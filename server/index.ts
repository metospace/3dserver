import express, { type Request, type Response, type NextFunction, type RequestHandler } from 'express';
import multer from 'multer';
import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, existsSync, mkdirSync } from 'node:fs';
import { rename, rm, readdir, stat, open } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { openDatabase, publicUser, type UserRow } from './db.js';
import { createAuth, type AuthRequest } from './auth.js';
import { createTeamApi } from './team.js';
import { HttpError, text, tags, objectBody, originalFilename, validateGlb, validatePng } from './validation.js';
import { prepareDashboard, loadManifest, loadPackage, syncFile, PACKAGE_UPLOAD_LIMIT } from './dashboard.js';
import type { Kind, Role, Category, Version, ModelRecord } from '../src/contracts.js';
import { appVersion } from '../src/release.js';
import { MODEL_MAX_BYTES, MODEL_MAX_MB, MODEL_TIMEOUT_MS } from '../src/limits.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const dataDir = path.resolve(process.env.DATA_DIR || path.join(root, 'data'));
const fileDir = path.join(dataDir, 'files');
const tempDir = path.join(dataDir, 'tmp');
const dashboardDir = path.join(dataDir, 'dashboards');
for (const directory of [fileDir, tempDir, dashboardDir]) mkdirSync(directory, { recursive: true });
const db = openDatabase(dataDir);
const auth = createAuth(db);
const app = express();
app.disable('x-powered-by');
if (process.env.TRUST_PROXY === '1') app.set('trust proxy', 1);

const team = createTeamApi(db, auth, { fileDir, tempDir, dashboardDir });
app.get('/team/sso/callback', team.callback);

interface RecordRow {
  id: string; kind: Kind; name: string; description: string; tags: string;
  category_id: string | null; current_version_id: string; revision: number; archived: number;
  created_at: string; updated_at: string;
}
interface VersionRow {
  id: string; record_id: string; number: number; original_name: string; size: number; note: string;
  created_at: string; uploaded_by: string; has_thumbnail: number; thumbnail_path: string | null;
  source_kind: Version['sourceKind']; entry: string | null;
}
interface CategoryRow { id: string; kind: Kind; name: string; parent_id: string | null }
interface ReceiptRow { fingerprint: string; response: string }
interface UploadRequest extends AuthRequest { uploadPaths?: string[]; uploadBytes?: number }
interface PreparedUpload {
  id: string; sourceKind: Version['sourceKind']; entry: string | null;
  originalName: string; size: number; destination: string;
}
interface FileFingerprint { field: string; originalName: string; rawName: string; size: number; sha256: string }
type Handler = (req: AuthRequest, res: Response) => unknown | Promise<unknown>;
const route = (handler: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => handler(req as AuthRequest, res)).catch(next);
};
function gate(check: (req: AuthRequest) => unknown): RequestHandler {
  return (req, _res, next) => { try { check(req as AuthRequest); next(); } catch (error) { next(error); } };
}

app.use((req, res, next) => {
  if (req.path === '/dashboard-preview.html') {
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'none'; script-src 'self' 'unsafe-inline' blob:; style-src 'unsafe-inline' blob:; img-src blob: data:; font-src blob: data:; media-src blob: data:; connect-src blob:; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'; frame-ancestors 'self'; sandbox allow-scripts");
    if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
    next(); return;
  }
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
  res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; worker-src 'self' blob:; connect-src 'self' blob: data:; img-src 'self' blob: data:; style-src 'self' 'unsafe-inline'; font-src 'self'; frame-src 'self' blob:; object-src 'none'; base-uri 'self'; frame-ancestors 'none'");
  if (req.secure) res.setHeader('Strict-Transport-Security', 'max-age=31536000');
  next();
});
app.use('/api/team', team.router);
app.use('/api', (req, res, next) => {
  res.setHeader('Cache-Control', 'no-store');
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method)) {
    const origin = req.get('origin');
    if (req.get('sec-fetch-site') === 'cross-site') return next(new HttpError(403, '不允许跨站请求'));
    if (origin) {
      try {
        const url = new URL(origin);
        if (url.host !== req.get('host') || url.protocol !== `${req.protocol}:`) return next(new HttpError(403, '请求来源不受信任'));
      } catch { return next(new HttpError(403, '请求来源无效')); }
    }
    if (!req.is('application/json') && !req.is('multipart/form-data') && Number(req.get('content-length') || 0) > 0) return next(new HttpError(415, '请使用 JSON 或 multipart/form-data 请求'));
  }
  next();
});
app.use('/api', express.json({ limit: '128kb', strict: true }), auth.authenticate);

function kindValue(value: unknown): Kind {
  if (value !== 'asset' && value !== 'scene' && value !== 'dashboard') throw new HttpError(400, '类型必须为资产、场景或大屏');
  return value;
}
function roleValue(value: unknown): Role {
  if (value !== 'admin' && value !== 'editor' && value !== 'viewer') throw new HttpError(400, '角色必须为管理员、编辑者或查看者');
  return value;
}
function currentUser(user: UserRow): UserRow {
  const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow | undefined;
  if (!fresh) throw new HttpError(401, '请重新登录');
  return fresh;
}
function writeAccess(user: UserRow, kind?: Kind) {
  const fresh = currentUser(user);
  if (fresh.role === 'viewer' || (kind === 'dashboard' && fresh.role !== 'admin')) throw new HttpError(403, '没有此内容的编辑权限');
}
function adminAccess(user: UserRow) {
  if (currentUser(user).role !== 'admin') throw new HttpError(403, '需要管理员权限');
}
function recordAccess(user: UserRow, id: string, write = false): RecordRow {
  const record = db.prepare('SELECT * FROM records WHERE id=?').get(id) as RecordRow | undefined;
  if (!record) throw new HttpError(404, '记录不存在');
  if (write) writeAccess(user, record.kind);
  return record;
}
function versionAccess(user: UserRow, id: string, write = false) {
  const version = db.prepare('SELECT * FROM versions WHERE id=?').get(id) as VersionRow | undefined;
  if (!version) throw new HttpError(404, '版本不存在');
  return { version, record: recordAccess(user, version.record_id, write) };
}
function categoryAccess(id: string): CategoryRow {
  const category = db.prepare('SELECT * FROM categories WHERE id=?').get(id) as CategoryRow | undefined;
  if (!category) throw new HttpError(404, '分类不存在');
  return category;
}
function categoryAssignment(value: unknown, kind: Kind): string | null {
  if (value === null || value === undefined || value === '') return null;
  const id = text(value, '分类编号', 64, 1);
  if (categoryAccess(id).kind !== kind) throw new HttpError(400, '分类不属于此模块');
  return id;
}
function categoryDto(category: CategoryRow): Category {
  return { id: category.id, kind: category.kind, name: category.name, parentId: category.parent_id };
}
function versionDto(version: VersionRow): Version {
  const uploader = db.prepare('SELECT display_name FROM users WHERE id=?').get(version.uploaded_by) as { display_name: string };
  return { id: version.id, recordId: version.record_id, number: version.number, originalName: version.original_name,
    size: version.size, note: version.note, createdAt: version.created_at, uploadedBy: uploader.display_name,
    hasThumbnail: Boolean(version.has_thumbnail), sourceKind: version.source_kind, entry: version.entry };
}
function recordDto(record: RecordRow): ModelRecord {
  const version = db.prepare('SELECT * FROM versions WHERE id=? AND record_id=?').get(record.current_version_id, record.id) as VersionRow | undefined;
  if (!version) throw new Error('记录缺少当前版本');
  return { id: record.id, kind: record.kind, name: record.name, description: record.description,
    tags: JSON.parse(record.tags) as string[], categoryId: record.category_id, currentVersionId: record.current_version_id,
    revision: record.revision, archived: Boolean(record.archived), createdAt: record.created_at,
    updatedAt: record.updated_at, currentVersion: versionDto(version) };
}
function revisionValue(value: unknown, multipart = false): number {
  if (multipart && typeof value === 'string' && /^[1-9]\d*$/.test(value)) value = Number(value);
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) throw new HttpError(400, '请提供有效的 expectedRevision');
  return value;
}
function checkRevision(record: RecordRow, expected: number) {
  if (record.revision !== expected) throw new HttpError(409, '记录已被修改，请读取最新版本后明确重新提交', 'VERSION_CONFLICT', record.revision);
}
function requireActive(record: RecordRow) {
  if (record.archived) throw new HttpError(409, '记录已归档，请先取消归档再编辑');
}

app.get('/api/setup', route((_req, res) => res.json({ required: !db.prepare('SELECT 1 FROM users LIMIT 1').get() })));
app.post('/api/setup', route(async (req, res) => {
  if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, '系统已经完成初始化');
  auth.limitSetup(req);
  const input = auth.credentials(req.body);
  const hash = await auth.hash(input.password);
  const user: UserRow = { id: randomUUID(), username: input.username, display_name: input.displayName, role: 'admin', password_hash: hash };
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM users LIMIT 1').get()) throw new HttpError(409, '系统已经完成初始化');
    db.prepare('INSERT INTO users (id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(user.id, user.username, user.display_name, hash, user.role, new Date().toISOString());
  }).immediate();
  res.status(201).json({ user: auth.issueSession(req, res, user) });
}));
app.post('/api/login', route(async (req, res) => res.json({ user: await auth.login(req, res) })));
app.post('/api/logout', route((req, res) => { auth.logout(req, res); res.sendStatus(204); }));
app.get('/api/me', auth.requireUser, route((req, res) => res.json({ user: publicUser(req.user!) })));
app.get('/api/users', auth.requireAdmin, route((_req, res) => {
  res.json((db.prepare('SELECT * FROM users ORDER BY username COLLATE NOCASE').all() as UserRow[]).map(publicUser));
}));
app.post('/api/users', auth.requireAdmin, route(async (req, res) => {
  const input = auth.credentials(req.body);
  const role = roleValue(objectBody(req.body).role);
  if (db.prepare('SELECT 1 FROM users WHERE username=?').get(input.username)) throw new HttpError(409, '用户名已存在');
  const user: UserRow = { id: randomUUID(), username: input.username, display_name: input.displayName, role, password_hash: await auth.hash(input.password) };
  db.transaction(() => {
    adminAccess(req.user!);
    db.prepare('INSERT INTO users (id,username,display_name,password_hash,role,created_at) VALUES (?,?,?,?,?,?)')
      .run(user.id, user.username, user.display_name, user.password_hash, user.role, new Date().toISOString());
  }).immediate();
  res.status(201).json(publicUser(user));
}));
app.patch('/api/users/:id', auth.requireAdmin, route((req, res) => {
  const role = roleValue(objectBody(req.body).role);
  const user = db.transaction(() => {
    adminAccess(req.user!);
    const target = db.prepare('SELECT * FROM users WHERE id=?').get(req.params.id) as UserRow | undefined;
    if (!target) throw new HttpError(404, '用户不存在');
    if (target.role === 'admin' && role !== 'admin' && !db.prepare("SELECT 1 FROM users WHERE role='admin' AND id<>?").get(target.id)) throw new HttpError(400, '不能降级最后一名管理员');
    db.prepare('UPDATE users SET role=? WHERE id=?').run(role, target.id);
    const ranks: Record<Role, number> = { viewer: 0, editor: 1, admin: 2 };
    if (ranks[role] < ranks[target.role]) db.prepare('DELETE FROM sessions WHERE user_id=?').run(target.id);
    return { ...target, role };
  }).immediate();
  res.json(publicUser(user));
}));

// Every remaining route, including manifests, packages and all file bytes, requires a live session.
app.use('/api', (req, res, next) => auth.requireUser(req as AuthRequest, res, next));
app.get('/api/system', route((req, res) => {
  const counts = { asset: 0, scene: 0, dashboard: 0 };
  const rows = db.prepare('SELECT kind,COUNT(*) AS count FROM records GROUP BY kind').all() as { kind: Kind; count: number }[];
  for (const row of rows) counts[row.kind] = row.count;
  const versions = db.prepare('SELECT COUNT(*) AS count,COALESCE(SUM(size),0) AS bytes FROM versions').get() as { count: number; bytes: number };
  res.json({ version: appVersion, databaseVersion: db.pragma('user_version', { simple: true }), role: req.user!.role,
    records: counts, versionCount: versions.count, sourceBytes: versions.bytes,
    limits: { modelMB: 100, screenshotMB: 2, dashboardMB: 100, expandedMB: 200, dashboardFiles: 2000 },
    ...(req.user!.role === 'admin' ? { dataDirectory: dataDir, runtime: `Node.js ${process.version}` } : {}),
  });
}));
app.get('/api/categories', route((req, res) => {
  const kind = kindValue(req.query.kind);
  res.json((db.prepare('SELECT * FROM categories WHERE kind=? ORDER BY name COLLATE NOCASE,id').all(kind) as CategoryRow[]).map(categoryDto));
}));
app.post('/api/categories', route((req, res) => {
  const body = objectBody(req.body), kind = kindValue(body.kind);
  const name = text(body.name, '分类名称', 120, 1);
  const category = db.transaction(() => {
    writeAccess(req.user!, kind);
    const parentId = body.parentId === null || body.parentId === undefined ? null : text(body.parentId, '父分类编号', 64, 1);
    if (parentId) {
      const parent = categoryAccess(parentId);
      if (parent.kind !== kind || parent.parent_id !== null) throw new HttpError(400, '分类最多两级且父分类必须属于同一模块');
    }
    const row: CategoryRow = { id: randomUUID(), kind, name, parent_id: parentId };
    db.prepare('INSERT INTO categories (id,kind,name,parent_id) VALUES (?,?,?,?)').run(row.id, kind, name, parentId);
    return row;
  }).immediate();
  res.status(201).json(categoryDto(category));
}));
app.patch('/api/categories/:id', route((req, res) => {
  const name = text(objectBody(req.body).name, '分类名称', 120, 1);
  const category = db.transaction(() => {
    const row = categoryAccess(req.params.id!); writeAccess(req.user!, row.kind);
    db.prepare('UPDATE categories SET name=? WHERE id=?').run(name, row.id);
    return { ...row, name };
  }).immediate();
  res.json(categoryDto(category));
}));
app.delete('/api/categories/:id', route((req, res) => {
  db.transaction(() => {
    const category = categoryAccess(req.params.id!); writeAccess(req.user!, category.kind);
    db.prepare(`UPDATE records SET category_id=NULL,revision=revision+1,updated_at=?
      WHERE category_id IN (SELECT id FROM categories WHERE id=? OR parent_id=?)`)
      .run(new Date().toISOString(), category.id, category.id);
    db.prepare('DELETE FROM categories WHERE parent_id=?').run(category.id);
    db.prepare('DELETE FROM categories WHERE id=?').run(category.id);
  }).immediate();
  res.sendStatus(204);
}));
app.get('/api/records', route((req, res) => {
  const kind = kindValue(req.query.kind);
  const query = text(req.query.q, '搜索内容', 200).toLocaleLowerCase();
  const tag = text(req.query.tag, '标签', 60).toLocaleLowerCase();
  const categoryId = text(req.query.categoryId, '分类编号', 64);
  if (categoryId && categoryId !== 'uncategorized' && categoryAccess(categoryId).kind !== kind) throw new HttpError(400, '分类不属于此模块');
  const showArchived = req.user!.role === 'admin' && req.query.includeArchived === '1';
  const rows = db.prepare(`SELECT * FROM records WHERE kind=? AND (?=1 OR archived=0)
    AND (?='' OR (?='uncategorized' AND category_id IS NULL)
      OR category_id IN (SELECT id FROM categories WHERE id=? OR parent_id=?))
    ORDER BY updated_at DESC,id`).all(kind, showArchived ? 1 : 0, categoryId, categoryId, categoryId, categoryId) as RecordRow[];
  res.json(rows.filter(record => {
    const values = JSON.parse(record.tags) as string[];
    return (!query || [record.name, record.description, ...values].some(value => value.toLocaleLowerCase().includes(query)))
      && (!tag || values.some(value => value.toLocaleLowerCase() === tag));
  }).map(recordDto));
}));

const storage = multer.diskStorage({
  destination: tempDir,
  filename(req, _file, done) {
    const name = randomUUID();
    ((req as UploadRequest).uploadPaths ??= []).push(path.join(tempDir, name));
    done(null, name);
  },
});
function countedStorage(limit: number): multer.StorageEngine {
  return {
    _handleFile(req, file, done) {
      file.stream.on('data', (chunk: Buffer) => {
        const uploadReq = req as UploadRequest;
        uploadReq.uploadBytes = (uploadReq.uploadBytes ?? 0) + chunk.length;
        if (uploadReq.uploadBytes > limit) file.stream.destroy(new HttpError(413, '上传总大小超过限制'));
      });
      storage._handleFile(req, file, done);
    },
    _removeFile(req, file, done) { storage._removeFile(req, file, done); },
  };
}
const dashboardUpload = multer({ storage: countedStorage(PACKAGE_UPLOAD_LIMIT), limits: {
  fileSize: PACKAGE_UPLOAD_LIMIT, files: 2000, fields: 12, parts: 2012,
  fieldSize: 4 * 1024 * 1024, fieldNameSize: 100, headerPairs: 100,
} }).fields([{ name: 'file', maxCount: 1 }, { name: 'files[]', maxCount: 2000 }]);
// Busboy flags reaching fileSize as truncated; countedStorage enforces the inclusive byte limit.
const modelUpload = multer({ storage: countedStorage(MODEL_MAX_BYTES), limits: {
  fileSize: MODEL_MAX_BYTES + 1, files: 1, fields: 12, parts: 13,
  fieldSize: 4 * 1024 * 1024, fieldNameSize: 100, headerPairs: 100,
} }).fields([{ name: 'file', maxCount: 1 }]);
// Requests without a kind query still work; the parsed kind is checked before hashing or preparation.
const unspecifiedUpload = multer({ storage: countedStorage(MODEL_MAX_BYTES), limits: {
  fileSize: MODEL_MAX_BYTES + 1, files: 2000, fields: 12, parts: 2012,
  fieldSize: 4 * 1024 * 1024, fieldNameSize: 100, headerPairs: 100,
} }).fields([{ name: 'file', maxCount: 1 }, { name: 'files[]', maxCount: 2000 }]);
const libraryUpload: RequestHandler = (req, res, next) => {
  try {
    const kind = req.params.id ? recordAccess((req as AuthRequest).user!, req.params.id, true).kind
      : req.query.kind === undefined ? undefined : kindValue(req.query.kind);
    const parser = kind === undefined ? unspecifiedUpload : kind === 'dashboard' ? dashboardUpload : modelUpload;
    parser(req, res, next);
  } catch (error) { next(error); }
};
const thumbnailUpload = multer({ storage: countedStorage(2 * 1024 * 1024), limits: {
  fileSize: 2 * 1024 * 1024, files: 1, fields: 1, parts: 2, fieldSize: 100, headerPairs: 100,
} }).single('file');
let uploadCount = 0;
const userUploads = new Map<string, number>();
function upload(parser: RequestHandler): RequestHandler {
  return (req: UploadRequest, res: Response, next: NextFunction) => {
    const userId = req.user!.id, count = userUploads.get(userId) ?? 0;
    if (uploadCount >= 12 || count >= 3) return next(new HttpError(429, '同时上传的文件过多，请稍后重试'));
    uploadCount++; userUploads.set(userId, count + 1);
    const cleanup = () => {
      for (const filename of req.uploadPaths ?? []) void rm(filename, { force: true }).catch(error => console.error('清理上传临时文件失败', error));
    };
    let released = false;
    const release = () => {
      if (released) return;
      released = true; uploadCount--;
      const remaining = (userUploads.get(userId) ?? 1) - 1;
      if (remaining) userUploads.set(userId, remaining); else userUploads.delete(userId);
      cleanup();
    };
    res.once('finish', release); res.once('close', release); req.once('aborted', release);
    req.setTimeout(MODEL_TIMEOUT_MS, () => { req.destroy(); release(); });
    parser(req, res, error => {
      if (error) { cleanup(); next(error); }
      else if (req.aborted) cleanup();
      else next();
    });
  };
}
function uploadedFiles(req: AuthRequest): Express.Multer.File[] {
  if (!req.files || Array.isArray(req.files)) throw new HttpError(400, '请选择上传文件');
  const single = req.files.file ?? [], folder = req.files['files[]'] ?? [];
  if ((!single.length && !folder.length) || (single.length && folder.length)) throw new HttpError(400, '请选择单文件或文件夹，不能混用');
  return [...single, ...folder];
}
function checkUploadLimits(kind: Kind, files: Express.Multer.File[]) {
  if (kind === 'dashboard') {
    if (files.reduce((total, file) => total + file.size, 0) > PACKAGE_UPLOAD_LIMIT) throw new HttpError(413, '大屏上传总大小不得超过 100 MiB');
  } else {
    if (files.length !== 1 || files[0].fieldname !== 'file') throw new HttpError(400, '模型上传必须为单个 GLB 文件');
    if (files[0].size > MODEL_MAX_BYTES) throw new HttpError(413, `GLB 文件不得超过 ${MODEL_MAX_MB} MiB`);
  }
}
function idempotencyKey(body: Record<string, unknown>): string {
  const key = text(body.idempotencyKey, '幂等请求编号', 36, 36);
  if (!/^[a-f\d]{8}-[a-f\d]{4}-[1-8][a-f\d]{3}-[89ab][a-f\d]{3}-[a-f\d]{12}$/i.test(key)) throw new HttpError(400, 'idempotencyKey 必须为 UUID');
  return key.toLowerCase();
}
async function fingerprint(operation: string, target: string | null, metadata: object, files: Express.Multer.File[]): Promise<string> {
  const content: FileFingerprint[] = [];
  for (const file of files) {
    const digest = createHash('sha256');
    for await (const chunk of createReadStream(file.path)) digest.update(chunk);
    content.push({ field: file.fieldname, originalName: originalFilename(file.originalname), rawName: file.originalname, size: file.size, sha256: digest.digest('hex') });
  }
  return createHash('sha256').update(JSON.stringify({ operation, target, metadata, files: content })).digest('hex');
}
function replay(userId: string, key: string, digest: string): string | undefined {
  const receipt = db.prepare('SELECT fingerprint,response FROM upload_receipts WHERE user_id=? AND key=?').get(userId, key) as ReceiptRow | undefined;
  if (!receipt) return undefined;
  if (receipt.fingerprint !== digest) throw new HttpError(409, '此幂等请求编号已用于不同内容，请为新的操作生成新编号', 'IDEMPOTENCY_MISMATCH');
  return receipt.response;
}
function saveReceipt(userId: string, key: string, digest: string, response: unknown): string {
  const encoded = JSON.stringify(response);
  db.prepare('INSERT INTO upload_receipts (user_id,key,fingerprint,response,created_at) VALUES (?,?,?,?,?)')
    .run(userId, key, digest, encoded, new Date().toISOString());
  return encoded;
}
async function syncDirectory(directory: string) {
  // Windows does not expose fsync on directories; files are flushed before the SQLite receipt commits.
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
async function prepareUpload(kind: Kind, files: Express.Multer.File[], body: Record<string, unknown>): Promise<PreparedUpload> {
  const id = randomUUID();
  if (kind !== 'dashboard') {
    if (files.length !== 1 || files[0].fieldname !== 'file') throw new HttpError(400, '模型上传必须为单个 GLB 文件');
    const file = files[0];
    if (!/\.glb$/i.test(originalFilename(file.originalname))) throw new HttpError(400, '请选择 GLB 文件');
    await validateGlb(file.path, file.size); await syncFile(file.path);
    const destination = path.join(fileDir, `${id}.glb`);
    await rename(file.path, destination); await syncDirectory(fileDir);
    return { id, sourceKind: 'glb', entry: null, originalName: originalFilename(file.originalname), size: file.size, destination };
  }
  const staging = path.join(tempDir, randomUUID());
  const destination = path.join(dashboardDir, id);
  try {
    const prepared = await prepareDashboard(files, body.paths, body.entry, staging);
    await syncDirectory(path.join(staging, 'content')); await syncDirectory(staging);
    await rename(staging, destination); await syncDirectory(dashboardDir);
    return { id, ...prepared, destination };
  } catch (error) { await rm(staging, { recursive: true, force: true }); await rm(destination, { recursive: true, force: true }); throw error; }
}
function insertVersion(prepared: PreparedUpload, recordId: string, number: number, note: string, now: string, userId: string) {
  db.prepare(`INSERT INTO versions (id,record_id,number,original_name,size,note,created_at,uploaded_by,source_kind,entry)
    VALUES (?,?,?,?,?,?,?,?,?,?)`).run(prepared.id, recordId, number, prepared.originalName, prepared.size, note, now, userId, prepared.sourceKind, prepared.entry);
}

app.post('/api/records', gate(req => writeAccess(req.user!)), upload(libraryUpload), route(async (req, res) => {
  const body = objectBody(req.body), kind = kindValue(body.kind);
  writeAccess(req.user!, kind);
  if (req.query.kind !== undefined && kindValue(req.query.kind) !== kind) throw new HttpError(400, '上传类型与请求 kind 不匹配');
  const key = idempotencyKey(body), files = uploadedFiles(req);
  checkUploadLimits(kind, files);
  const input = { kind, name: text(body.name, '名称', 160, 1), description: text(body.description, '说明', 10000),
    tags: tags(body.tags, true), categoryId: body.categoryId === '' || body.categoryId === undefined ? null : body.categoryId,
    note: text(body.note, '版本说明', 2000), paths: body.paths ?? null, entry: body.entry ?? null };
  const digest = await fingerprint('create-record', null, input, files);
  const prior = replay(req.user!.id, key, digest);
  if (prior !== undefined) { res.status(201).type('json').send(prior); return; }
  const prepared = await prepareUpload(kind, files, body);
  let retained = false;
  try {
    const response = db.transaction(() => {
      writeAccess(req.user!, kind);
      const existing = replay(req.user!.id, key, digest);
      if (existing !== undefined) return existing;
      const categoryId = categoryAssignment(input.categoryId, kind);
      const recordId = randomUUID(), now = new Date().toISOString();
      db.prepare(`INSERT INTO records (id,kind,name,description,tags,category_id,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)`)
        .run(recordId, kind, input.name, input.description, JSON.stringify(input.tags), categoryId, now, now);
      insertVersion(prepared, recordId, 1, input.note, now, req.user!.id);
      db.prepare('UPDATE records SET current_version_id=? WHERE id=?').run(prepared.id, recordId);
      const result = saveReceipt(req.user!.id, key, digest, recordDto(recordAccess(req.user!, recordId)));
      return { result };
    }).immediate();
    retained = typeof response !== 'string';
    res.status(201).type('json').send(typeof response === 'string' ? response : response.result);
  } finally { if (!retained) await rm(prepared.destination, { recursive: true, force: true }); }
}));
app.get('/api/records/:id', route((req, res) => {
  const record = recordAccess(req.user!, req.params.id!);
  const versions = db.prepare('SELECT * FROM versions WHERE record_id=? ORDER BY number DESC').all(record.id) as VersionRow[];
  res.json({ record: recordDto(record), versions: versions.map(versionDto) });
}));
app.patch('/api/records/:id', route((req, res) => {
  const body = objectBody(req.body), expected = revisionValue(body.expectedRevision);
  const result = db.transaction(() => {
    const record = recordAccess(req.user!, req.params.id!, true); checkRevision(record, expected); requireActive(record);
    const name = body.name === undefined ? record.name : text(body.name, '名称', 160, 1);
    const description = body.description === undefined ? record.description : text(body.description, '说明', 10000);
    const nextTags = body.tags === undefined ? record.tags : JSON.stringify(tags(body.tags));
    const categoryId = body.categoryId === undefined ? record.category_id : categoryAssignment(body.categoryId, record.kind);
    db.prepare('UPDATE records SET name=?,description=?,tags=?,category_id=?,revision=revision+1,updated_at=? WHERE id=?')
      .run(name, description, nextTags, categoryId, new Date().toISOString(), record.id);
    return recordDto(recordAccess(req.user!, record.id));
  }).immediate();
  res.json(result);
}));
app.post('/api/records/:id/versions', gate(req => {
  const record = recordAccess(req.user!, req.params.id!, true);
  if (db.prepare("SELECT 1 FROM versions WHERE id=? AND source_kind='chat3d'").get(record.current_version_id)) {
    throw new HttpError(409, '可编辑原件请在 Chat3D 中发布新版本，GLB 请另行入库');
  }
}), upload(libraryUpload), route(async (req, res) => {
  const record = recordAccess(req.user!, req.params.id!, true);
  const body = objectBody(req.body), key = idempotencyKey(body), files = uploadedFiles(req);
  checkUploadLimits(record.kind, files);
  const expected = revisionValue(body.expectedRevision, true), note = text(body.note, '版本说明', 2000);
  const digest = await fingerprint('create-version', record.id, { kind: record.kind, expectedRevision: expected, note, paths: body.paths ?? null, entry: body.entry ?? null }, files);
  const prior = replay(req.user!.id, key, digest);
  if (prior !== undefined) { res.status(201).type('json').send(prior); return; }
  const prepared = await prepareUpload(record.kind, files, body);
  let retained = false;
  try {
    const response = db.transaction(() => {
      const latest = recordAccess(req.user!, record.id, true);
      const existing = replay(req.user!.id, key, digest);
      if (existing !== undefined) return existing;
      checkRevision(latest, expected); requireActive(latest);
      if (db.prepare("SELECT 1 FROM versions WHERE record_id=? AND source_kind='chat3d' LIMIT 1").get(record.id)) {
        throw new HttpError(409, '可编辑原件请在 Chat3D 中发布新版本，GLB 请另行入库');
      }
      const previous = db.prepare('SELECT COALESCE(MAX(number),0) AS number FROM versions WHERE record_id=?').get(record.id) as { number: number };
      const now = new Date().toISOString();
      insertVersion(prepared, record.id, previous.number + 1, note, now, req.user!.id);
      db.prepare('UPDATE records SET current_version_id=?,revision=revision+1,updated_at=? WHERE id=?').run(prepared.id, now, record.id);
      const version = db.prepare('SELECT * FROM versions WHERE id=?').get(prepared.id) as VersionRow;
      return { result: saveReceipt(req.user!.id, key, digest, versionDto(version)) };
    }).immediate();
    retained = typeof response !== 'string';
    res.status(201).type('json').send(typeof response === 'string' ? response : response.result);
  } finally { if (!retained) await rm(prepared.destination, { recursive: true, force: true }); }
}));
app.post('/api/records/:id/current', route((req, res) => {
  const body = objectBody(req.body), expected = revisionValue(body.expectedRevision);
  const versionId = text(body.versionId, '版本编号', 64, 1);
  db.transaction(() => {
    const record = recordAccess(req.user!, req.params.id!, true); checkRevision(record, expected); requireActive(record);
    if (!db.prepare('SELECT 1 FROM versions WHERE id=? AND record_id=?').get(versionId, record.id)) throw new HttpError(400, '版本不属于当前记录');
    db.prepare('UPDATE records SET current_version_id=?,revision=revision+1,updated_at=? WHERE id=?').run(versionId, new Date().toISOString(), record.id);
  }).immediate();
  res.sendStatus(204);
}));
app.patch('/api/records/:id/archive', route((req, res) => {
  const body = objectBody(req.body), expected = revisionValue(body.expectedRevision);
  if (typeof body.archived !== 'boolean') throw new HttpError(400, 'archived 必须为布尔值');
  const result = db.transaction(() => {
    adminAccess(req.user!);
    const record = recordAccess(req.user!, req.params.id!); checkRevision(record, expected);
    db.prepare('UPDATE records SET archived=?,revision=revision+1,updated_at=? WHERE id=?').run(body.archived ? 1 : 0, new Date().toISOString(), record.id);
    return recordDto(recordAccess(req.user!, record.id));
  }).immediate();
  res.json(result);
}));
app.patch('/api/versions/:id/note', route((req, res) => {
  const body = objectBody(req.body), expected = revisionValue(body.expectedRevision);
  if (typeof body.note !== 'string') throw new HttpError(400, '版本说明必须是文本');
  const note = text(body.note, '版本说明', 2000, 0, false);
  const result = db.transaction(() => {
    const { version, record } = versionAccess(req.user!, req.params.id!, true);
    checkRevision(record, expected); requireActive(record);
    db.prepare('UPDATE versions SET note=? WHERE id=?').run(note, version.id);
    db.prepare('UPDATE records SET revision=revision+1,updated_at=? WHERE id=?').run(new Date().toISOString(), record.id);
    const versions = db.prepare('SELECT * FROM versions WHERE record_id=? ORDER BY number DESC').all(record.id) as VersionRow[];
    return { record: recordDto(recordAccess(req.user!, record.id)), versions: versions.map(versionDto) };
  }).immediate();
  res.json(result);
}));

function sendStoredFile(res: Response, filename: string) {
  res.sendFile(filename, { cacheControl: false, lastModified: false }, error => {
    if (error && !res.headersSent) res.status((error as NodeJS.ErrnoException).code === 'ENOENT' ? 404 : 500).json({ error: '文件不可用' });
    else if (error) res.destroy(error);
  });
}
app.get('/api/versions/:id/file', route((req, res) => {
  const { version } = versionAccess(req.user!, req.params.id!);
  if (version.source_kind !== 'glb') throw new HttpError(400, '大屏请使用源文件下载接口');
  if (req.query.download === '1') res.attachment(version.original_name);
  else res.setHeader('Content-Disposition', `inline; filename="model.glb"; filename*=UTF-8''${encodeURIComponent(version.original_name).replace(/['()*]/g, char => `%${char.charCodeAt(0).toString(16).toUpperCase()}`)}`);
  res.type('model/gltf-binary'); sendStoredFile(res, path.join(fileDir, `${version.id}.glb`));
}));
app.get('/api/versions/:id/source', route((req, res) => {
  const { version, record } = versionAccess(req.user!, req.params.id!);
  if (version.source_kind === 'chat3d') {
    res.attachment(version.original_name).type('application/json');
    sendStoredFile(res, path.join(fileDir, `${version.id}.json`));
    return;
  }
  if (record.kind !== 'dashboard') throw new HttpError(400, '此接口仅用于大屏源文件');
  res.attachment(version.source_kind === 'folder' ? 'dashboard.zip' : version.original_name);
  res.type(version.source_kind === 'html' ? 'text/html' : 'application/zip');
  // HTML is always an attachment and never a same-origin executable document.
  res.setHeader('Content-Security-Policy', "default-src 'none'; sandbox");
  sendStoredFile(res, path.join(dashboardDir, version.id, version.source_kind === 'html' ? 'source.html' : 'source.zip'));
}));
app.get('/api/versions/:id/manifest', route(async (req, res) => {
  const { version, record } = versionAccess(req.user!, req.params.id!);
  if (record.kind !== 'dashboard') throw new HttpError(400, '此接口仅用于大屏');
  const manifest = await loadManifest(path.join(dashboardDir, version.id));
  res.json({ entry: manifest.entry, files: manifest.files.map(file => ({ path: file.path, size: file.size })) });
}));
app.get('/api/versions/:id/package', route(async (req, res) => {
  const { version, record } = versionAccess(req.user!, req.params.id!);
  if (record.kind !== 'dashboard') throw new HttpError(400, '此接口仅用于大屏');
  res.json(await loadPackage(path.join(dashboardDir, version.id)));
}));
app.get('/api/versions/:id/thumbnail', route((req, res) => {
  const { version } = versionAccess(req.user!, req.params.id!);
  if (!version.has_thumbnail) throw new HttpError(404, '缩略图不存在');
  const filename = version.thumbnail_path ?? `${version.id}.png`;
  res.type(filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
  sendStoredFile(res, path.join(fileDir, filename));
}));
app.post('/api/versions/:id/thumbnail', gate(req => versionAccess(req.user!, req.params.id!, true)), upload(thumbnailUpload), route(async (req, res) => {
  const { version } = versionAccess(req.user!, req.params.id!, true);
  const body = objectBody(req.body), key = idempotencyKey(body), file = req.file;
  if (!file) throw new HttpError(400, '请选择 PNG 缩略图');
  const digest = await fingerprint('thumbnail', version.id, {}, [file]);
  if (replay(req.user!.id, key, digest) !== undefined) { res.sendStatus(204); return; }
  await validatePng(file.path); await syncFile(file.path);
  const filename = `${randomUUID()}.png`, destination = path.join(fileDir, filename);
  await rename(file.path, destination);
  let retained = false;
  try {
    await syncDirectory(fileDir);
    retained = db.transaction(() => {
      versionAccess(req.user!, version.id, true);
      if (replay(req.user!.id, key, digest) !== undefined) return false;
      db.prepare('UPDATE versions SET has_thumbnail=1,thumbnail_path=? WHERE id=?').run(filename, version.id);
      saveReceipt(req.user!.id, key, digest, null);
      return true;
    }).immediate();
  } finally { if (!retained) await rm(destination, { force: true }); }
  res.sendStatus(204);
}));

app.use('/api', (_req, _res, next) => next(new HttpError(404, '接口不存在')));
const dist = path.join(root, 'dist');
if (existsSync(path.join(dist, 'index.html'))) {
  app.use(express.static(dist, { index: false, dotfiles: 'deny', fallthrough: true }));
  app.get('*', (req, res, next) => {
    if (path.extname(req.path)) return next(new HttpError(404, '文件不存在'));
    res.setHeader('Cache-Control', 'no-cache'); res.sendFile(path.join(dist, 'index.html'));
  });
}
app.use((_req, _res, next) => next(new HttpError(404, '资源不存在')));
app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  if (res.headersSent) { res.destroy(error instanceof Error ? error : undefined); return; }
  if (error instanceof HttpError) { res.status(error.status).json({ error: error.message, code: error.code, currentRevision: error.currentRevision }); return; }
  if (error instanceof multer.MulterError) {
    res.status(error.code === 'LIMIT_FILE_SIZE' ? 413 : 400).json({ error: error.code === 'LIMIT_FILE_SIZE' ? `文件超过大小限制（GLB ${MODEL_MAX_MB} MiB，大屏 100 MiB，PNG 2 MiB）` : '上传格式无效、字段过多或包含多余文件' }); return;
  }
  const detail = error as { type?: string; code?: string; status?: number };
  if (detail.type === 'entity.too.large') { res.status(413).json({ error: '请求内容过大' }); return; }
  if (detail.type === 'entity.parse.failed') { res.status(400).json({ error: 'JSON 格式无效' }); return; }
  if (detail.code === 'SQLITE_CONSTRAINT_UNIQUE') { res.status(409).json({ error: '内容已存在，请刷新后重试' }); return; }
  if (detail.code === 'SQLITE_BUSY') { res.status(503).json({ error: '数据库繁忙，请稍后重试' }); return; }
  if (detail.code === 'ENOSPC') { res.status(507).json({ error: '服务器磁盘空间不足' }); return; }
  if (detail.code === 'ENOENT') { res.status(404).json({ error: '文件不可用' }); return; }
  console.error('请求处理失败', error); res.status(500).json({ error: '服务器内部错误，请联系管理员' });
});

// Remove only abandoned temporary entries, never immutable data or database-referenced files.
void readdir(tempDir).then(async files => {
  for (const name of files) {
    if (!/^[a-f0-9-]{36}$/.test(name)) continue;
    const filename = path.join(tempDir, name), info = await stat(filename).catch(() => undefined);
    if (info && info.mtimeMs < Date.now() - 24 * 60 * 60 * 1000) await rm(filename, { recursive: true, force: true });
  }
}).catch(error => console.error('清理历史临时文件失败', error));
const port = Number(process.env.PORT ?? 3187);
if (!Number.isInteger(port) || port < 0 || port > 65535) throw new Error('PORT 必须为 0–65535 的整数');
const server = app.listen(port, process.env.HOST || '127.0.0.1', () => {
  const address = server.address();
  if (address && typeof address !== 'string') console.log(`Scenivo 服务已启动：http://${process.env.HOST || '127.0.0.1'}:${address.port}`);
});
server.requestTimeout = MODEL_TIMEOUT_MS; server.headersTimeout = 15000;
server.on('error', error => { console.error('服务启动失败', error); team.close(); auth.close(); db.close(); process.exitCode = 1; });
let stopping = false;
function shutdown() {
  if (stopping) return;
  stopping = true;
  const force = setTimeout(() => { server.closeAllConnections(); }, 10000); force.unref();
  server.close(() => { clearTimeout(force); team.close(); auth.close(); db.close(); });
}
process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
