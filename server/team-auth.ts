import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import express, { type Request, type RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import type { AuthRequest, PasswordVerifier } from './auth.js';
import type { UserRow } from './db.js';
import { HttpError, objectBody, text } from './validation.js';

const CALLBACK_PATH = '/team/sso/callback';
const SESSION_AGE = 8 * 60 * 60 * 1000;
const PLATFORM_RECHECK = 5 * 60 * 1000;
const CLAIM_TTL = 5 * 60 * 1000;
const MAX_CLAIMS = 1024;
const hash = (value: string) => createHash('sha256').update(value).digest('hex');
const loginRequired = () => new HttpError(401, '请重新登录团队服务');

interface PlatformIdentity { subject: string; username: string }
interface PlatformTokens { accessToken: string; refreshToken: string; expiresTime: number }
interface PlatformSession { accessToken: string; subject: string; expiresAt: number; checkedAt: number }
interface SessionRow extends UserRow { platform_sso: 0 | 1 }
interface PendingClaim { expiresAt: number; platform?: PlatformTokens }

function wireUser(user: UserRow) {
  return { id: user.id, name: user.display_name, role: user.role === 'editor' ? 'member' : user.role };
}

function httpUrl(value: string): URL {
  if (!/^https?:\/\/[^/]/i.test(value) || /[\s\\#]/.test(value)) throw new Error('Expected an HTTP(S) URL without a fragment');
  const url = new URL(value);
  if (url.username || url.password) throw new Error('Unexpected URL credentials');
  return url;
}

function platformConfig() {
  const env = process.env;
  const configuredBase = env.CHAT3D_PLATFORM_AUTH_BASE?.trim();
  if (configuredBase?.includes('?')) throw new Error('CHAT3D_PLATFORM_AUTH_BASE must not contain a query');
  const root = configuredBase ? httpUrl(configuredBase).href.replace(/\/$/, '') : undefined;
  const tenant = env.CHAT3D_PLATFORM_TENANT_ID?.trim() ?? '1';
  if (!/^\d{1,16}$/.test(tenant)) throw new Error('Invalid CHAT3D_PLATFORM_TENANT_ID');
  const tokenPath = env.CHAT3D_PLATFORM_OAUTH_TOKEN_PATH?.trim() ?? '/admin-api/system/oauth2/token';
  if (!/^\/(?!\/)[a-zA-Z0-9/_.-]+$/.test(tokenPath) || tokenPath.split('/').some(part => part === '.' || part === '..')) {
    throw new Error('CHAT3D_PLATFORM_OAUTH_TOKEN_PATH must be a path on the configured authentication service');
  }
  const redirect = env.CHAT3D_PLATFORM_OAUTH_REDIRECT_URI?.trim();
  if (redirect) httpUrl(redirect);
  const clientId = env.CHAT3D_PLATFORM_OAUTH_CLIENT_ID?.trim() ?? 'scenivo';
  let clientSecret = env.CHAT3D_PLATFORM_OAUTH_CLIENT_SECRET;
  if (root && !clientSecret && env.CHAT3D_PLATFORM_OAUTH_CLIENT_SECRET_FILE) {
    try { clientSecret = readFileSync(env.CHAT3D_PLATFORM_OAUTH_CLIENT_SECRET_FILE, 'utf8').trim(); }
    catch { throw new Error('Cannot read CHAT3D_PLATFORM_OAUTH_CLIENT_SECRET_FILE'); }
  }
  return { root, tenant, tokenPath, redirect, clientId, clientSecret, passwordLogin: env.CHAT3D_TEAM_PASSWORD_LOGIN !== '0' };
}

function redirectFor(req: Request, configured?: string): string {
  if (configured) return configured;
  const host = req.get('host');
  try {
    if (!host || /[/?#@]/.test(host)) throw new Error('Invalid host');
    return httpUrl(`${req.protocol}://${host}`).origin + CALLBACK_PATH;
  } catch { throw new HttpError(400, '授权回调服务地址无效'); }
}

function bearerHash(req: Request): string {
  const match = /^Bearer ([a-f0-9]{64})$/i.exec(req.get('authorization') ?? '');
  if (!match) throw loginRequired();
  return hash(match[1]);
}

const bearerValue = /^[a-zA-Z0-9._~+\/-]+=*$/;
function accessToken(value: unknown): string {
  const token = text(value, '协同登录令牌', 4096, 1, false);
  if (!bearerValue.test(token)) throw new HttpError(400, '协同登录令牌无效');
  return token;
}

function object(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : undefined;
}

async function platformCall(url: string, options: RequestInit, failure: string): Promise<Record<string, unknown>> {
  let response: Response;
  try {
    response = await fetch(url, { ...options, signal: AbortSignal.timeout(15_000), redirect: 'error' });
  } catch { throw new HttpError(502, '无法连接协同认证服务'); }
  if (response.status === 401 || response.status === 403) {
    await response.body?.cancel().catch(() => undefined);
    throw new HttpError(response.status, response.status === 401 ? '协同登录已失效' : '协同账号未获授权');
  }
  let result: Record<string, unknown> | undefined;
  try { result = object(await response.json()); }
  catch { throw new HttpError(502, '协同认证响应无效'); }
  if (!result) throw new HttpError(502, '协同认证响应无效');
  if (result.code === 401 || result.error === 'invalid_grant' || result.error === 'invalid_token') throw new HttpError(401, '协同登录已失效');
  if (result.code === 403) throw new HttpError(403, '协同账号未获授权');
  if (!response.ok || (result.code !== undefined && result.code !== 0)) throw new HttpError(502, failure);
  return result;
}

function platformTokens(result: Record<string, unknown>): PlatformTokens {
  const data = object(result.data);
  const accessToken = data?.access_token ?? data?.accessToken ?? result.access_token ?? result.accessToken;
  const refreshToken = data?.refresh_token ?? data?.refreshToken ?? result.refresh_token ?? result.refreshToken ?? '';
  const expiresIn = data?.expires_in ?? result.expires_in;
  const expiresTime = data?.expiresTime ?? data?.expires_time ?? result.expiresTime ?? result.expires_time
    ?? (typeof expiresIn === 'number' ? Date.now() + expiresIn * 1000 : 0);
  if (typeof accessToken !== 'string' || accessToken.length > 4096 || !bearerValue.test(accessToken)
    || typeof refreshToken !== 'string' || refreshToken.length > 4096 || typeof expiresTime !== 'number' || !Number.isFinite(expiresTime)) {
    throw new HttpError(502, '协同授权码兑换响应无效');
  }
  return { accessToken, refreshToken, expiresTime };
}

export function createTeamAuth(db: Database.Database, auth: PasswordVerifier) {
  const config = platformConfig();
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_sessions (
      token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      expires_at INTEGER NOT NULL, platform_sso INTEGER NOT NULL CHECK(platform_sso IN (0,1))
    );
    CREATE INDEX IF NOT EXISTS team_sessions_expiry ON team_sessions(expires_at);
    CREATE INDEX IF NOT EXISTS team_sessions_user ON team_sessions(user_id);
    CREATE TRIGGER IF NOT EXISTS revoke_demoted_team_sessions AFTER UPDATE OF role ON users
    WHEN (OLD.role='admin' AND NEW.role<>'admin') OR (OLD.role='editor' AND NEW.role='viewer')
    BEGIN DELETE FROM team_sessions WHERE user_id=OLD.id; END;
    CREATE TABLE IF NOT EXISTS team_platform_identities (
      issuer TEXT NOT NULL, tenant_id TEXT NOT NULL, subject TEXT NOT NULL,
      user_id TEXT NOT NULL UNIQUE REFERENCES users(id) ON DELETE CASCADE,
      PRIMARY KEY(issuer,tenant_id,subject)
    );
  `);
  // Provider credentials must be available for revalidation, but never written to SQLite.
  const platformSessions = new Map<string, PlatformSession>();
  const pending = new Map<string, PendingClaim>();
  const findSession = db.prepare(`SELECT u.*,s.platform_sso FROM team_sessions s JOIN users u ON u.id=s.user_id
    WHERE s.token_hash=? AND s.expires_at>?`);
  const addSession = db.prepare('INSERT INTO team_sessions (token_hash,user_id,expires_at,platform_sso) VALUES (?,?,?,?)');
  const deleteSession = db.prepare('DELETE FROM team_sessions WHERE token_hash=?');
  const purgeSessions = db.prepare('DELETE FROM team_sessions WHERE expires_at<=?');
  const liveSsoSession = db.prepare('SELECT 1 FROM team_sessions WHERE token_hash=?');
  const isInitialized = db.prepare("SELECT 1 FROM users WHERE role='admin' LIMIT 1");
  const findIdentity = db.prepare(`SELECT u.* FROM team_platform_identities p JOIN users u ON u.id=p.user_id
    WHERE p.issuer=? AND p.tenant_id=? AND p.subject=?`);
  const bindIdentity = db.prepare('INSERT INTO team_platform_identities (issuer,tenant_id,subject,user_id) VALUES (?,?,?,?)');
  const localNameTaken = db.prepare('SELECT 1 FROM users WHERE username=?');
  const addUser = db.prepare('INSERT INTO users (id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)');
  // A restart cannot revalidate existing SSO sessions; password sessions remain valid.
  db.prepare('DELETE FROM team_sessions WHERE platform_sso=1').run();
  purgeSessions.run(Date.now());

  function pruneClaims(now: number) {
    for (const [key, claim] of pending) if (claim.expiresAt <= now) pending.delete(key);
  }
  const timer = setInterval(() => {
    if (!db.open) { clearInterval(timer); return; }
    const now = Date.now();
    pruneClaims(now);
    purgeSessions.run(now);
    for (const [key, session] of platformSessions) {
      if (session.expiresAt <= now || !liveSsoSession.get(key)) platformSessions.delete(key);
    }
  }, 60_000);
  timer.unref();

  function platformRoot(): string {
    if (!config.root) throw new HttpError(503, '协同认证服务尚未配置');
    return config.root;
  }

  function checkTenant(value: unknown) {
    if (value !== undefined && ((typeof value !== 'string' && typeof value !== 'number') || String(value) !== config.tenant)) {
      throw new HttpError(400, '协同租户未获授权');
    }
  }

  function requireInitialized() {
    if (!isInitialized.get()) throw new HttpError(503, '请先初始化系统管理员');
  }

  async function platformIdentity(root: string, token: string): Promise<PlatformIdentity> {
    const result = await platformCall(root + '/admin-api/system/auth/get-permission-info', {
      headers: { Authorization: 'Bearer ' + token, 'tenant-id': config.tenant },
    }, '协同认证失败');
    const user = object(object(result.data)?.user);
    if (result.code !== 0 || !user || typeof user.username !== 'string' || !/^[a-zA-Z0-9_.@-]{1,80}$/.test(user.username)) {
      throw new HttpError(502, '协同账号无效');
    }
    if (user.disabled === true || user.disabled === 1 || user.status === 1 || user.status === '1') {
      throw new HttpError(403, '协同账号未获授权');
    }
    const issuerTenant = user.tenantId ?? user.tenant_id;
    if (issuerTenant != null && String(issuerTenant) !== config.tenant) throw new HttpError(403, '协同账号未获授权');
    const id = user.id ?? user.userId ?? user.user_id;
    // Older permission responses provided only the tenant's account name.
    if (id == null) return { subject: `name:${user.username}`, username: user.username };
    if (!(typeof id === 'number' && Number.isSafeInteger(id) && id >= 0)
      && !(typeof id === 'string' && /^[^\s\u0000-\u001f\u007f]{1,128}$/.test(id))) throw new HttpError(502, '协同账号标识无效');
    return { subject: `id:${id}`, username: user.username };
  }

  const localUser = db.transaction((root: string, identity: PlatformIdentity): UserRow => {
    const existing = findIdentity.get(root, config.tenant, identity.subject) as UserRow | undefined;
    if (existing) return existing;
    requireInitialized();
    const id = randomUUID();
    // A local username collision must never bind this identity to the existing local account.
    const username = /^[a-zA-Z0-9_.-]{3,40}$/.test(identity.username) && !localNameTaken.get(identity.username)
      ? identity.username : `sso-${id}`;
    const user: UserRow = { id, username, display_name: identity.username, role: 'editor', password_hash: 'sso' };
    addUser.run(user.id, user.username, user.display_name, user.password_hash, user.role, new Date().toISOString());
    bindIdentity.run(root, config.tenant, identity.subject, user.id);
    return user;
  });

  function issue(user: UserRow, platform?: { accessToken: string; subject: string }) {
    const token = randomBytes(32).toString('hex');
    const key = hash(token);
    const now = Date.now();
    const expiresAt = now + SESSION_AGE;
    addSession.run(key, user.id, expiresAt, platform ? 1 : 0);
    if (platform) platformSessions.set(key, { ...platform, expiresAt, checkedAt: now });
    return { token, user: wireUser(user) };
  }

  function revoke(key: string) {
    deleteSession.run(key);
    platformSessions.delete(key);
  }

  function currentSession(key: string) {
    const session = findSession.get(key, Date.now()) as SessionRow | undefined;
    if (!session) throw loginRequired();
    return session;
  }

  async function authenticate(req: Request, force = false): Promise<UserRow> {
    const key = bearerHash(req);
    let user = currentSession(key);
    if (user.platform_sso) {
      const platform = platformSessions.get(key);
      if (!platform) { revoke(key); throw loginRequired(); }
      const now = Date.now();
      if (force || now - platform.checkedAt >= PLATFORM_RECHECK) {
        try {
          const identity = await platformIdentity(platformRoot(), platform.accessToken);
          if (identity.subject !== platform.subject) throw loginRequired();
        } catch (error) {
          if (error instanceof HttpError && (error.status === 401 || error.status === 403)) {
            revoke(key);
            throw new HttpError(401, '协同登录已失效');
          }
          throw error;
        }
        user = currentSession(key); // The session may have been revoked while awaiting the provider.
        platform.checkedAt = Math.max(now, platform.checkedAt);
      }
    }
    (req as AuthRequest).user = user;
    return user;
  }

  async function withClaim<T extends { platform: PlatformTokens }>(state: string, exchange: () => Promise<T>): Promise<T> {
    const key = hash(state);
    const now = Date.now();
    pruneClaims(now);
    if (pending.has(key)) throw new HttpError(409, '此授权请求已处理，请重新发起授权');
    if (pending.size >= MAX_CLAIMS) throw new HttpError(429, '授权请求过多，请稍后重试');
    const claim: PendingClaim = { expiresAt: now + CLAIM_TTL };
    pending.set(key, claim);
    try {
      const result = await exchange();
      claim.expiresAt = Date.now() + CLAIM_TTL;
      claim.platform = result.platform;
      return result;
    } catch (error) {
      pending.delete(key);
      throw error;
    }
  }

  async function loginPlatform(root: string, token: string) {
    requireInitialized();
    const identity = await platformIdentity(root, token);
    return issue(localUser.immediate(root, identity), { accessToken: token, subject: identity.subject });
  }

  const router = express.Router();
  const requireUser: RequestHandler = (req, _res, next) => { void authenticate(req).then(() => next()).catch(next); };
  const json = express.json({ limit: '128kb', strict: true });
  function post(path: string, handler: (req: Request, body: Record<string, unknown>) => unknown | Promise<unknown>) {
    router.post(path, (req, _res, next) => {
      if (!req.is('application/json')) return next(new HttpError(415, '需要 JSON'));
      next();
    }, json, async (req, res, next) => {
      try { res.json(await handler(req, objectBody(req.body))); }
      catch (error) { next(error); }
    });
  }

  post('/login', async (req, body) => {
    if (!config.passwordLogin) throw new HttpError(403, '已关闭团队密码登录，请使用协同账号');
    return issue(await auth.verifyPassword(req, body.name, body.password));
  });
  post('/login/sso', async (_req, body) => {
    const root = platformRoot();
    checkTenant(body.tenantId);
    const token = accessToken(body.accessToken);
    if (body.state === undefined) return loginPlatform(root, token);
    // A legacy implicit-token callback needs the same desktop handoff as a code callback.
    const refreshToken = text(body.refreshToken, '协同刷新令牌', 4096, 0, false);
    const expiresTime = body.expiresTime ?? 0;
    if (typeof expiresTime !== 'number' || !Number.isFinite(expiresTime)) throw new HttpError(400, '协同令牌到期时间无效');
    const state = text(body.state, '授权 state', 256, 1);
    const { platform: _platform, ...session } = await withClaim(state, async () => ({
      ...await loginPlatform(root, token), platform: { accessToken: token, refreshToken, expiresTime },
    }));
    return session;
  });
  post('/login/sso/code', async (req, body) => {
    const root = platformRoot();
    const { clientId, clientSecret } = config;
    if (!clientId || !clientSecret) throw new HttpError(503, '协同 OAuth client 尚未配置');
    checkTenant(body.tenantId);
    const code = text(body.code, '授权码', 4096, 1, false);
    const redirect = text(body.redirectUri, '授权回调地址', 4096, 1, false);
    if (redirect !== redirectFor(req, config.redirect)) throw new HttpError(400, '授权回调地址不匹配');
    const state = text(body.state, '授权 state', 256, 1);
    requireInitialized();
    return withClaim(state, async () => {
      const result = await platformCall(root + config.tokenPath, {
        method: 'POST',
        headers: { 'Content-Type': 'application/x-www-form-urlencoded', 'tenant-id': config.tenant },
        body: new URLSearchParams({ grant_type: 'authorization_code', code, redirect_uri: redirect, client_id: clientId, client_secret: clientSecret, state }),
      }, '协同授权码兑换失败');
      const platform = platformTokens(result);
      return { ...await loginPlatform(root, platform.accessToken), platform };
    });
  });
  post('/login/sso/claim', (_req, body) => {
    const state = text(body.state, '授权 state', 256, 1);
    const claim = pending.get(hash(state));
    if (!claim?.platform || claim.expiresAt <= Date.now()) throw new HttpError(404, '授权尚未完成或已过期');
    const platform = claim.platform;
    delete claim.platform; // Keep the state reserved until expiry; the credentials are returned only once.
    return { platform };
  });
  router.get('/me', requireUser, (req, res) => { res.json(wireUser((req as AuthRequest).user!)); });
  post('/logout', req => {
    const key = bearerHash(req);
    currentSession(key); // A provider outage must not prevent invalidating the local session.
    revoke(key);
    return { ok: true };
  });

  const callback: RequestHandler = (req, res, next) => {
    try {
      const redirect = redirectFor(req, config.redirect);
      const nonce = randomBytes(18).toString('base64');
      res.set({
        'Cache-Control': 'no-store', 'Content-Type': 'text/html; charset=utf-8',
        'Content-Security-Policy': `default-src 'none'; script-src 'nonce-${nonce}'; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'; form-action 'none'`,
        'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'X-Frame-Options': 'DENY',
        ...(req.secure ? { 'Strict-Transport-Security': 'max-age=31536000' } : {}),
      });
      res.send(callbackPage(nonce, redirect, config.tenant));
    } catch (error) { next(error); }
  };
  return { router, requireUser, authenticate, callback, close: () => clearInterval(timer) };
}

function callbackPage(nonce: string, redirect: string, tenant: string): string {
  const scriptConfig = JSON.stringify({ redirect, tenant }).replace(/</g, '\\u003c');
  return `<!doctype html>
<html lang="zh-CN"><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>团队协同登录</title><h1>团队协同登录</h1><p id="status" role="status">正在完成授权…</p>
<noscript>请启用 JavaScript，然后从原工作空间重新发起授权。</noscript>
<script nonce="${nonce}">
'use strict';
const config = ${scriptConfig};
const status = document.getElementById('status');
const query = new URLSearchParams(window.location.search);
const fragment = new URLSearchParams(window.location.hash.slice(1));
const get = key => query.get(key) ?? fragment.get(key) ?? undefined;
const state = get('state');
const code = get('code');
const accessToken = get('accessToken') ?? get('access_token');
const refreshToken = get('refreshToken') ?? get('refresh_token') ?? '';
const rawExpiry = get('expiresTime') ?? get('expires_in');
const expiry = rawExpiry ? Number(rawExpiry) : 0;
const expiresTime = Number.isFinite(expiry) && expiry ? (expiry < 1e12 ? Date.now() + expiry * 1000 : expiry) : 0;
const error = get('error') ?? get('error_description');
try { window.history.replaceState(null, '', window.location.pathname); } catch {}

function notify(result) {
  try { window.localStorage.setItem('chat3d.platform.oauth.pending', JSON.stringify({ ...result, at: Date.now() })); } catch {}
  try {
    const channel = new BroadcastChannel('chat3d-platform-oauth');
    try { channel.postMessage(result); } finally { channel.close(); }
  } catch {}
}
async function post(path, body) {
  const response = await fetch('/api/team/login/sso' + path, {
    method: 'POST', credentials: 'omit', redirect: 'error', cache: 'no-store',
    headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body), signal: AbortSignal.timeout(60000),
  });
  const data = await response.json().catch(() => undefined);
  if (!response.ok) throw new Error(typeof data?.error === 'string' ? data.error : '协同授权失败');
  return data;
}
async function finish() {
  try {
    if (error) throw new Error(error === 'access_denied' ? '用户拒绝了协同授权（access_denied）' : '协同授权失败');
    if (!state || state.length > 256) throw new Error('协同登录回调缺少有效的授权 state');
    let platform;
    if (accessToken) {
      await post('', { accessToken, refreshToken, expiresTime, state, tenantId: config.tenant });
      platform = { accessToken, refreshToken, expiresTime };
    } else if (code) {
      const data = await post('/code', { code, redirectUri: config.redirect, tenantId: config.tenant, state });
      if (!data?.platform?.accessToken) throw new Error('协同登录回调缺少令牌');
      platform = data.platform;
    } else {
      throw new Error('协同登录回调缺少令牌或授权码');
    }
    notify({ ...platform, state });
    status.textContent = '授权成功，请返回原工作空间。';
  } catch (error) {
    const message = error instanceof Error ? error.message : '协同授权失败';
    notify({ error: message, state });
    status.textContent = '授权失败：' + message;
  }
}
void finish();
</script></html>`;
}
