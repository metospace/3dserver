import { createHash, randomBytes, scrypt, timingSafeEqual } from 'node:crypto';
import type { Request, Response, NextFunction } from 'express';
import type Database from 'better-sqlite3';
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
export interface PasswordVerifier {
  verifyPassword(req: Request, name: unknown, secret: unknown): Promise<UserRow>;
}

export function createAuth(db: Database.Database) {
  const attempts = new Map<string, { count: number; until: number }>();
  const findUser = db.prepare('SELECT * FROM users WHERE username = ?');
  let activeHashes = 0;
  const prune = () => {
    const now = Date.now();
    db.prepare('DELETE FROM sessions WHERE expires_at <= ?').run(now);
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

  function issueSession(req: Request, res: Response, user: UserRow) {
    const token = randomBytes(32).toString('hex');
    const old = sessionToken(req);
    db.transaction(() => {
      if (old) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(old));
      db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)').run(hashToken(token), user.id, Date.now() + SESSION_AGE);
    })();
    res.cookie(COOKIE, token, { ...cookieOptions(req), maxAge: SESSION_AGE });
    return publicUser(user);
  }

  function authenticate(req: AuthRequest, _res: Response, next: NextFunction) {
    try {
      const token = sessionToken(req);
      if (token) {
        const user = db.prepare(`SELECT u.* FROM users u JOIN sessions s ON s.user_id = u.id WHERE s.token_hash = ? AND s.expires_at > ?`).get(hashToken(token), Date.now()) as UserRow | undefined;
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
      if (token) db.prepare('DELETE FROM sessions WHERE token_hash = ?').run(hashToken(token));
      res.clearCookie(COOKIE, cookieOptions(req));
    },
    limitSetup(req: Request) { throttle(req, '__setup__'); },
    close() { clearInterval(timer); },
  };
}
