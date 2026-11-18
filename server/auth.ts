import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
import type { User } from '../src/contracts.js';
import { publicUser, type UserRow } from './db.js';
import { HttpError, text, objectBody } from './validation.js';

const SESSION_AGE = 7 * 24 * 60 * 60 * 1000;
const COOKIE = 'glb_session';
const hashToken = (value: string) => createHash('sha256').update(value).digest('hex');
const DUMMY_PASSWORD_HASH = `scrypt$${'00'.repeat(16)}$${'00'.repeat(64)}`;

function derive(password: string, salt: Buffer): Promise<Buffer> {
  // Node 20 lacks Promise.withResolvers; scrypt exposes its options through the callback overload.
  return new Promise<Buffer>((resolve, reject) => {
    scrypt(password, salt, 64, { N: 16384, r: 8, p: 1, maxmem: 32 * 1024 * 1024 }, (error, key) => {
      if (error) reject(error); else resolve(key);
    });
  });
}
async function passwordHash(password: string): Promise<string> {
  const salt = randomBytes(16);
  return `scrypt$${salt.toString('hex')}$${(await derive(password, salt)).toString('hex')}`;
}

async function passwordMatches(password: string, encoded?: string): Promise<boolean> {
  const stored = encoded?.startsWith('scrypt$') ? encoded : undefined;
  const [, salt, hash] = (stored ?? DUMMY_PASSWORD_HASH).split('$');
  const actual = await derive(password, Buffer.from(salt, 'hex'));
  const expected = Buffer.from(hash, 'hex');
  return actual.length === expected.length && timingSafeEqual(actual, expected) && stored !== undefined;
}

export interface AuthRequest extends Request { user?: UserRow }
interface OAuthSession { expiresTime: number; verify: () => Promise<void> }
export interface TeamAuthHost {
  verifyPassword(req: Request, name: unknown, secret: unknown): Promise<UserRow>;
  issueSession(req: Request, res: Response, user: UserRow, oauth?: OAuthSession): User;
}

export function createAuth(db: Database.Database) {
  const attempts = new Map<string, { count: number; until: number }>();
  const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
  db.exec(`CREATE TABLE IF NOT EXISTS management_oauth_sessions (
    token_hash TEXT PRIMARY KEY REFERENCES sessions(token_hash) ON DELETE CASCADE
  );`);
  // The upstream credentials are deliberately process-local.
  db.prepare('DELETE FROM sessions WHERE token_hash IN (SELECT token_hash FROM management_oauth_sessions)').run();
  const oauthSessions = new Map<string, { verify: () => Promise<void>; checkedAt: number; expiresAt: number }>();
  const dropSession = db.prepare('DELETE FROM sessions WHERE token_hash = ?');
  const findSession = db.prepare(`SELECT u.*, o.token_hash IS NOT NULL AS oauth FROM users u JOIN sessions s ON s.user_id = u.id
    LEFT JOIN management_oauth_sessions o ON o.token_hash = s.token_hash WHERE s.token_hash = ? AND s.expires_at > ?`);
  let activeHashes = 0;
  const prune = () => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
    for (const [key, session] of oauthSessions) if (session.expiresAt <= now || !findSession.get(key, now)) oauthSessions.delete(key);
    for (const [key, value] of attempts) if (value.until <= now) attempts.delete(key);
  };
  prune();
  const timer = setInterval(prune, 15 * 60 * 1000);
  timer.unref();

  function throttle(req: Request, name: string) {
    const now = Date.now();
    const keys = [`ip:${req.ip ?? 'unknown'}`, `name:${name.toLowerCase()}`];
    for (const key of keys) {
      const item = attempts.get(key);
      if (item && item.until > now && item.count >= (key.startsWith('ip:') ? 50 : 12)) {
        throw new HttpError(429, '尝试次数过多，请在十五分钟后重试');
      }
    }
    if (attempts.size > 10000) {
      prune();
      if (attempts.size > 10000) throw new HttpError(429, '登录请求过多，请稍后重试');
    }
    for (const key of keys) {
      const item = attempts.get(key);
      if (!item || item.until <= now) attempts.set(key, { count: 1, until: now + 15 * 60 * 1000 });
      else item.count++;
    }
  }

  async function withHash<T>(work: () => Promise<T>): Promise<T> {
    if (activeHashes >= 4) throw new HttpError(429, '密码处理繁忙，请稍后重试');
    activeHashes++;
    try { return await work(); } finally { activeHashes--; }
  }

  function cookieOptions(req: Request) {
    return { httpOnly: true, sameSite: 'strict' as const, secure: req.secure, path: '/' };
  }

  function sessionToken(req: Request): string | undefined {
    const value = req.headers.cookie?.split(';').map(part => part.trim()).find(part => part.startsWith(`${COOKIE}=`))?.slice(COOKIE.length + 1);
    return value && /^[a-f0-9]{64}$/.test(value) ? value : undefined;
  }

  function issueSession(req: Request, res: Response, user: UserRow, oauth?: OAuthSession) {
    const now = Date.now(), expiresAt = oauth ? Math.min(now + 8 * 3600_000, oauth.expiresTime || Infinity) : now + SESSION_AGE;
    if (expiresAt <= now) throw new HttpError(401, '协同登录已失效');
    const token = randomBytes(32).toString('hex');
    const key = hashToken(token), oldToken = sessionToken(req), oldKey = oldToken && hashToken(oldToken);
    db.transaction(() => {
      if (oldKey) dropSession.run(oldKey);
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(key, user.id, expiresAt);
      if (oauth) db.prepare('INSERT INTO management_oauth_sessions VALUES (?)').run(key);
    })();
    if (oldKey) oauthSessions.delete(oldKey);
    if (oauth) oauthSessions.set(key, { verify: oauth.verify, checkedAt: now, expiresAt });
    res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: expiresAt - now });
    return publicUser(user);
  }

  async function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
    try {
      const token = sessionToken(req);
      if (token) {
        const key = hashToken(token), now = Date.now();
        let user = findSession.get(key, now) as (UserRow & { oauth: number }) | undefined;
        if (user?.oauth && !(req.method === 'POST' && req.path === '/logout')) {
          const session = oauthSessions.get(key);
          if (!session) { dropSession.run(key); user = undefined; }
          else if (now - session.checkedAt >= 5 * 60_000 || !['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
            try { await session.verify(); }
            catch (error) {
              if (!(error instanceof HttpError) || (error.status !== 401 && error.status !== 403)) throw error;
              dropSession.run(key); oauthSessions.delete(key);
            }
            user = findSession.get(key, Date.now()) as typeof user;
            if (user) session.checkedAt = Date.now();
          }
        }
        if (user) req.user = user;
      }
      next();
    } catch (error) { next(error); }
  }

  function requireUser(req: AuthRequest, _res: Response, next: NextFunction) {
    if (!req.user) return next(new HttpError(401, '请先登录'));
    next();
  }

  function requireAdmin(req: AuthRequest, _res: Response, next: NextFunction) {
    if (!req.user) return next(new HttpError(401, '请先登录'));
    if (req.user.role !== 'admin') return next(new HttpError(403, '需要管理员权限'));
    next();
  }

  function credentials(body: unknown) {
    const value = objectBody(body);
    const username = text(value.username, '用户名', 40, 3);
    if (!/^[A-Za-z0-9_.-]+$/.test(username)) throw new HttpError(400, '用户名只能包含英文字母、数字、下划线、点或短横线');
    const password = text(value.password, '密码', 1024, 6, false);
    const displayName = text(value.displayName, '显示名称', 80, 1);
    return { username, password, displayName };
  }

  async function verifyPassword(req: Request, name: unknown, secret: unknown): Promise<UserRow> {
    const username = text(name, '用户名', 40, 1);
    const password = text(secret, '密码', 1024, 1, false);
    throttle(req, username);
    const user = findUser.get(username) as UserRow | undefined;
    const matches = await withHash(() => passwordMatches(password, user?.password_hash));
    if (!user || !matches) throw new HttpError(401, '用户名或密码错误');
    const current = findUser.get(username) as UserRow | undefined;
    if (!current || current.id !== user.id || current.password_hash !== user.password_hash) throw new HttpError(401, '用户名或密码错误');
    attempts.delete(`name:${username.toLowerCase()}`);
    return current;
  }

  return {
    authenticate, requireUser, requireAdmin, credentials,
    async hash(password: string) { return withHash(() => passwordHash(password)); },
    issueSession, verifyPassword,
    async login(req: Request, res: Response) {
      const body = objectBody(req.body);
      return issueSession(req, res, await verifyPassword(req, body.username, body.password));
    },
    logout(req: Request, res: Response) {
      const token = sessionToken(req);
      if (token) { const key = hashToken(token); dropSession.run(key); oauthSessions.delete(key); }
      res.clearCookie(COOKIE, cookieOptions(req));
    },
    limitSetup(req: Request) { throttle(req, '__setup__'); },
    close() { clearInterval(timer); },
  };
}
