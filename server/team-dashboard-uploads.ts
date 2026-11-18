import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, mkdirSync } from 'node:fs';
import { mkdir, open, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import { loadManifest, packagePath, PACKAGE_UPLOAD_LIMIT, prepareDashboard, type DashboardSource, type PackageManifest, type PreparedDashboard } from './dashboard.js';
import type { UserRow } from './db.js';
import { decodeBase64 } from './team-dashboard-png.js';
import { HttpError, objectBody, text } from './validation.js';

const MAX_FILES = 2000;
const MAX_CHUNK = 1024 * 1024;
const MAX_ACTIVE = 8, MAX_PER_USER = 3;
const UPLOAD_LIFETIME = 24 * 60 * 60 * 1000;
const controls = /[\x00-\x1f\x7f-\x9f]/;
const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
interface Metadata {
  name: string; description: string; system: string; entry: string; itemId?: string;
  expectedVersion: number; key: string; sourceKind: 'file' | 'folder'; fileName: string;
}
interface Upload {
  id: string; metadata: string; state: 'active' | 'cancelled' | 'completed';
  result: string | null; touched: number;
}
interface UploadFile { id: string; path: string; size: number; offset: number }
interface Published { id: string; version: number }
interface DashboardHead { id: string; head: number | null }

function dashboardPath(value: unknown): string {
  const name = packagePath(value);
  if (name !== name.normalize('NFC') || /[\x80-\x9f%?#]/.test(name) || name.split('/').some(part =>
    /[. ]$/.test(part) || /^(?:con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new HttpError(400, '看板文件路径无效');
  }
  return name;
}
function metadataOf(value: unknown): Metadata {
  const body = objectBody(value);
  if (Object.keys(body).some(key => !['name', 'description', 'system', 'entry', 'itemId', 'expectedVersion', 'key', 'sourceKind', 'fileName'].includes(key))) throw new HttpError(400, '看板发布信息无效');
  const name = text(body.name, '看板名称', 80, 1, false), description = text(body.description, '说明', 2000, 0, false);
  const rawSystem = text(body.system, '所属系统', 256, 1, false), system = rawSystem.trim();
  const { itemId, sourceKind, expectedVersion, key } = body;
  if (!name.trim() || controls.test(name) || !system || system.length > 80 || controls.test(rawSystem) ||
      typeof key !== 'string' || !/^[a-zA-Z0-9-]{16,80}$/.test(key) ||
      typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0 ||
      (itemId !== undefined && (typeof itemId !== 'string' || !idPattern.test(itemId))) ||
      (sourceKind !== 'file' && sourceKind !== 'folder')) throw new HttpError(400, '看板发布信息无效');
  const entry = dashboardPath(body.entry), fileName = dashboardPath(body.fileName);
  if (!/\.html?$/i.test(entry)) throw new HttpError(400, '看板入口必须是 HTML');
  if (fileName.includes('/') || fileName.length > 240) throw new HttpError(400, '看板原包文件名无效');
  if (sourceKind === 'file' && (!/\.(?:html?|zip)$/i.test(fileName) || (!/\.zip$/i.test(fileName) && entry !== fileName))) throw new HttpError(400, '请选择 HTML 文件或静态 ZIP，且 HTML 入口必须匹配文件名');
  return { name: name.trim(), description, system, entry, itemId, expectedVersion, key, sourceKind, fileName };
}
function validateFilePath(name: string, files: UploadFile[]) {
  // Files are registered one at a time; compare prefixes to catch file/directory and case collisions before accepting bytes.
  const parts = name.split('/'), folded = parts.map(part => part.toLowerCase());
  for (const other of files) {
    const old = other.path.split('/');
    for (let i = 0; i < Math.min(parts.length, old.length); i++) {
      if (folded[i] !== old[i].toLowerCase()) break;
      if (parts[i] !== old[i] || i === parts.length - 1 || i === old.length - 1) throw new HttpError(400, '包内包含重复路径或文件目录冲突');
    }
  }
}
export async function syncDirectory(directory: string) {
  if (process.platform === 'win32') return;
  const handle = await open(directory, 'r');
  try { await handle.sync(); } finally { await handle.close(); }
}
export const sourceFilename = (kind: DashboardSource) => kind === 'html' ? 'source.html' : 'source.zip';
export const teamSourceKind = (kind: DashboardSource) => kind === 'folder' ? 'folder' : 'file';
async function storedHash(filename: string) {
  const hash = createHash('sha256');
  let size = 0;
  for await (const bytes of createReadStream(filename)) { hash.update(bytes); size += bytes.length; }
  return { size, sha256: hash.digest('hex') };
}
export async function dashboardHash(directory: string, kind: DashboardSource, fileName: string, manifest: PackageManifest) {
  const files = [];
  if (kind === 'folder') {
    for (const file of [...manifest.files].sort((a, b) => a.path < b.path ? -1 : a.path > b.path ? 1 : 0)) {
      files.push({ path: file.path, ...await storedHash(path.join(directory, 'content', file.storage)) });
    }
  } else {
    files.push({ path: fileName, ...await storedHash(path.join(directory, sourceFilename(kind))) });
  }
  return createHash('sha256').update(JSON.stringify({ entry: manifest.entry, sourceKind: teamSourceKind(kind), fileName, files })).digest('hex');
}
async function verifyEntry(directory: string, manifest: PackageManifest) {
  for (const file of manifest.files) dashboardPath(file.path);
  const entry = manifest.files.find(file => file.path === manifest.entry)!;
  // Like the legacy store, reject binary/NUL or non-HTML entry content, without building or evaluating the package.
  const decoder = new TextDecoder(), probe = /<(?:!doctype\s+html|html|head|body|div|main|section|script|style|title|canvas|svg|h[1-6]|p)(?:\s|>)/i;
  let found = false, tail = '';
  for await (const bytes of createReadStream(path.join(directory, 'content', entry.storage))) {
    if (bytes.includes(0)) throw new HttpError(400, '看板入口不是有效 HTML');
    if (!found) {
      const source = tail + decoder.decode(bytes, { stream: true });
      found = probe.test(source); tail = source.slice(-128);
    }
  }
  if (!found) throw new HttpError(400, '看板入口不是有效 HTML');
}

interface UploadOptions {
  db: Database.Database; dashboardDir: string; tempDir: string;
  admin(user: UserRow): UserRow;
}
export function openDashboardUploads({ db, dashboardDir, tempDir, admin }: UploadOptions) {
  const root = path.join(tempDir, 'team-dashboard-uploads');
  mkdirSync(root, { recursive: true, mode: 0o700 });
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_dashboard_uploads (
      id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
      key TEXT NOT NULL, metadata TEXT NOT NULL, state TEXT NOT NULL DEFAULT 'active'
        CHECK(state IN ('active','cancelled','completed')),
      result TEXT, touched INTEGER NOT NULL, cleanup INTEGER NOT NULL DEFAULT 0, UNIQUE(user_id,key)
    );
    CREATE INDEX IF NOT EXISTS team_dashboard_upload_gc ON team_dashboard_uploads(touched)
      WHERE state='active' OR cleanup=1;
    CREATE TABLE IF NOT EXISTS team_dashboard_upload_files (
      id TEXT PRIMARY KEY, upload_id TEXT NOT NULL REFERENCES team_dashboard_uploads(id) ON DELETE CASCADE,
      path TEXT NOT NULL, size INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, UNIQUE(upload_id,path)
    );
  `);
  const lookupUpload = db.prepare('SELECT id,metadata,state,result,touched FROM team_dashboard_uploads WHERE user_id=? AND id=?');
  const lookupKey = db.prepare('SELECT id,metadata,state,result,touched FROM team_dashboard_uploads WHERE user_id=? AND key=?');
  const lookupFile = db.prepare('SELECT id,path,size,offset FROM team_dashboard_upload_files WHERE upload_id=? AND id=?');
  const lookupFiles = db.prepare('SELECT id,path,size,offset FROM team_dashboard_upload_files WHERE upload_id=? ORDER BY path');
  const touch = db.prepare("UPDATE team_dashboard_uploads SET touched=? WHERE id=? AND state='active'");
  const cancelState = db.prepare("UPDATE team_dashboard_uploads SET state='cancelled',cleanup=1 WHERE id=? AND state='active'");
  const expireState = db.prepare("UPDATE team_dashboard_uploads SET state='cancelled',cleanup=1 WHERE id=? AND state='active' AND touched<?");
  const markClean = db.prepare('UPDATE team_dashboard_uploads SET cleanup=0 WHERE id=?');
  const deleteFiles = db.prepare('DELETE FROM team_dashboard_upload_files WHERE upload_id=?');
  const versionExists = db.prepare('SELECT 1 FROM versions WHERE id=?');
  const advance = db.prepare('UPDATE team_dashboard_upload_files SET offset=? WHERE id=?');
  const busy = new Map<string, Promise<void>>();
  const cleaning = new Map<string, Promise<void>>();
  function owned(user: UserRow, id: string) {
    const upload = lookupUpload.get(user.id, id) as Upload | undefined;
    if (!upload) throw new HttpError(404, '上传任务不存在');
    return upload;
  }
  function active(upload: Upload, now: number) {
    if (upload.state !== 'active' || upload.touched < now - UPLOAD_LIFETIME) throw new HttpError(409, '上传任务已完成、取消或过期');
  }
  async function exclusive<T>(id: string, work: () => Promise<T>) {
    if (busy.has(id)) throw new HttpError(409, '上传任务正在写入，请稍后重试');
    // Node 20 predates Promise.withResolvers(); cancellation waits for the current disk operation.
    let release!: () => void;
    busy.set(id, new Promise<void>(resolve => { release = resolve; }));
    try { return await work(); } finally { busy.delete(id); release(); }
  }
  function clean(id: string) {
    const old = cleaning.get(id);
    if (old) return old;
    const job = (async () => {
      await rm(path.join(root, id), { recursive: true, force: true });
      // An interrupted rename before the metadata commit is unpublished; a committed native version is never removed.
      if (db.open && !versionExists.get(id)) await rm(path.join(dashboardDir, id), { recursive: true, force: true });
      if (db.open) db.transaction(() => { deleteFiles.run(id); markClean.run(id); }).immediate();
    })().catch(error => console.error('清理看板上传失败', error)).finally(() => cleaning.delete(id));
    cleaning.set(id, job);
    return job;
  }
  const expired = db.prepare(`SELECT id,state FROM team_dashboard_uploads WHERE
    cleanup=1 OR (state='active' AND touched<?) ORDER BY touched LIMIT 32`);
  let sweeping = false;
  async function sweep() {
    if (sweeping || !db.open) return;
    sweeping = true;
    try {
      const cutoff = Date.now() - UPLOAD_LIFETIME;
      const entries = expired.all(cutoff) as Pick<Upload, 'id' | 'state'>[];
      for (const { id, state } of entries) {
        if (!db.open) break;
        if (busy.has(id)) continue;
        if (state === 'active' && !expireState.run(id, cutoff).changes) continue;
        await clean(id);
      }
    } catch (error) { console.error('清理历史看板上传失败', error); }
    finally { sweeping = false; }
  }
  const timer = setInterval(() => { if (db.open) void sweep(); else clearInterval(timer); }, 5 * 60 * 1000);
  timer.unref();
  void sweep();

  const findHead = db.prepare(`SELECT r.id, (SELECT MAX(v.number) FROM versions v WHERE v.record_id=r.id) AS head
    FROM records r WHERE r.id=? AND r.kind='dashboard'`);
  function checkHead(meta: Metadata): DashboardHead | undefined {
    const item = meta.itemId === undefined ? undefined : findHead.get(meta.itemId) as DashboardHead | undefined;
    if (meta.itemId !== undefined && !item) throw new HttpError(404, '看板原件不存在');
    if ((item?.head ?? 0) !== meta.expectedVersion) throw new HttpError(409, '看板已有新版本，请刷新后重试', 'VERSION_CONFLICT');
    return item;
  }
  const countActive = db.prepare(`SELECT COUNT(*) AS total, SUM(user_id=?) AS own
    FROM team_dashboard_uploads WHERE state='active' OR cleanup=1`);
  const insertUpload = db.prepare('INSERT INTO team_dashboard_uploads (id,user_id,key,metadata,touched) VALUES (?,?,?,?,?)');
  const start = db.transaction((user: UserRow, body: unknown) => {
    const meta = metadataOf(body), serialized = JSON.stringify(meta), now = Date.now();
    const prior = lookupKey.get(user.id, meta.key) as Upload | undefined;
    if (prior) {
      if (prior.metadata !== serialized || prior.state === 'cancelled') throw new HttpError(409, '重试标识已用于其他内容或已取消', 'IDEMPOTENCY_MISMATCH');
      if (prior.state === 'completed') return { uploadId: prior.id, ...JSON.parse(prior.result!) as Published };
      active(prior, now);
      touch.run(now, prior.id);
      return { uploadId: prior.id };
    }
    checkHead(meta);
    const limits = countActive.get(user.id) as { total: number; own: number | null };
    if (limits.total >= MAX_ACTIVE || (limits.own ?? 0) >= MAX_PER_USER) throw new HttpError(429, '待完成的看板上传过多，请取消不需要的任务后重试');
    const id = randomUUID();
    insertUpload.run(id, user.id, meta.key, serialized, now);
    return { uploadId: id };
  });
  const insertFile = db.prepare('INSERT INTO team_dashboard_upload_files (id,upload_id,path,size) VALUES (?,?,?,?)');
  async function register(user: UserRow, id: string, input: unknown) {
    return exclusive(id, async () => {
      const upload = owned(user, id), now = Date.now();
      active(upload, now);
      const body = objectBody(input), size = body.size;
      if (Object.keys(body).some(key => key !== 'path' && key !== 'size') || typeof size !== 'number' || !Number.isSafeInteger(size) || size < 0) throw new HttpError(400, '上传文件信息无效');
      const name = dashboardPath(body.path), meta = JSON.parse(upload.metadata) as Metadata;
      if (meta.sourceKind === 'file' && name !== meta.fileName) throw new HttpError(400, '原包文件名不匹配');
      const files = lookupFiles.all(id) as UploadFile[], prior = files.find(file => file.path === name);
      if (prior) {
        if (prior.size !== size) throw new HttpError(409, '文件声明大小不一致');
        touch.run(now, id);
        return { fileId: prior.id, offset: prior.offset };
      }
      if (files.length >= MAX_FILES || size + files.reduce((sum, file) => sum + file.size, 0) > PACKAGE_UPLOAD_LIMIT) throw new HttpError(413, '看板上传最多 2000 个文件且不得超过 100 MiB');
      validateFilePath(name, files);
      const directory = path.join(root, id), fileId = randomUUID(), filename = path.join(directory, fileId);
      if (await mkdir(directory, { recursive: true, mode: 0o700 })) await syncDirectory(root);
      const handle = await open(filename, 'wx', 0o600);
      try {
        try { await handle.sync(); } finally { await handle.close(); }
        await syncDirectory(directory);
        active(owned(user, id), Date.now());
        db.transaction(() => { insertFile.run(fileId, id, name, size); touch.run(now, id); }).immediate();
      } catch (error) { await rm(filename, { force: true }); throw error; }
      return { fileId, offset: 0 };
    });
  }
  async function chunk(user: UserRow, id: string, fileId: string, input: unknown) {
    return exclusive(id, async () => {
      const now = Date.now();
      active(owned(user, id), now);
      const body = objectBody(input), requestedOffset = body.offset;
      if (Object.keys(body).some(key => key !== 'offset' && key !== 'base64') || typeof requestedOffset !== 'number' || !Number.isSafeInteger(requestedOffset) || requestedOffset < 0) throw new HttpError(400, '上传分块无效');
      const file = lookupFile.get(id, fileId) as UploadFile | undefined;
      if (!file) throw new HttpError(404, '上传文件不存在');
      if (file.offset !== requestedOffset) throw new HttpError(409, '上传偏移不匹配，请重新获取文件偏移');
      const bytes = decodeBase64(body.base64, MAX_CHUNK, '上传分块不能超过 1 MiB，且必须使用规范 Base64');
      const offset = file.offset + bytes.length;
      if (offset > file.size) throw new HttpError(400, '上传内容超过文件声明大小');
      touch.run(now, id);
      const handle = await open(path.join(root, id, file.id), 'r+');
      try {
        // Discard uncommitted bytes from a crash between fsync and the offset update.
        await handle.truncate(file.offset);
        let written = 0;
        while (written < bytes.length) {
          const result = await handle.write(bytes, written, bytes.length - written, file.offset + written);
          if (!result.bytesWritten) throw new Error('File write made no progress');
          written += result.bytesWritten;
        }
        await handle.sync();
      } finally { await handle.close(); }
      active(owned(user, id), Date.now());
      advance.run(offset, file.id);
      return { offset };
    });
  }
  const nextNumber = db.prepare('SELECT COALESCE(MAX(number),0)+1 AS version FROM versions WHERE record_id=?');
  const matchingCategory = db.prepare("SELECT id FROM categories WHERE kind='dashboard' AND parent_id IS NULL AND name=?");
  const insertRecord = db.prepare("INSERT INTO records (id,kind,name,description,category_id,created_at,updated_at) VALUES (?,'dashboard',?,?,?,?,?)");
  const insertVersion = db.prepare(`INSERT INTO versions (id,record_id,number,original_name,size,created_at,uploaded_by,source_kind,entry)
    VALUES (?,?,?,?,?,?,?,?,?)`);
  const setHead = db.prepare('UPDATE records SET current_version_id=?,name=?,description=?,updated_at=?,revision=revision+? WHERE id=?');
  const insertMetadata = db.prepare('INSERT INTO team_dashboard_metadata (version_id,name,description,system,file_count) VALUES (?,?,?,?,?)');
  const insertHash = db.prepare('INSERT INTO team_dashboard_hashes (version_id,hash) VALUES (?,?)');
  const markCompleted = db.prepare("UPDATE team_dashboard_uploads SET state='completed',result=?,cleanup=1 WHERE id=?");
  const publish = db.transaction((user: UserRow, uploadId: string, meta: Metadata, prepared: PreparedDashboard, fileCount: number, hash: string): Published => {
    admin(user);
    active(owned(user, uploadId), Date.now());
    const existing = checkHead(meta), id = existing?.id ?? randomUUID(), now = new Date().toISOString();
    const { version } = nextNumber.get(id) as { version: number };
    if (!existing) {
      const category = matchingCategory.get(meta.system) as { id: string } | undefined;
      insertRecord.run(id, meta.name, meta.description, category?.id ?? null, now, now);
    }
    insertVersion.run(uploadId, id, version, meta.fileName, prepared.size, now, user.id, prepared.sourceKind, prepared.entry);
    insertMetadata.run(uploadId, meta.name, meta.description, meta.system, fileCount);
    insertHash.run(uploadId, hash);
    setHead.run(uploadId, meta.name, meta.description, now, Number(Boolean(existing)), id);
    const result = { id, version };
    markCompleted.run(JSON.stringify(result), uploadId);
    return result;
  });
  async function complete(user: UserRow, id: string, reauthenticate: () => Promise<UserRow>) {
    const result = await exclusive(id, async () => {
      const upload = owned(user, id), now = Date.now();
      if (upload.state === 'completed') return JSON.parse(upload.result!) as Published;
      active(upload, now);
      const meta = JSON.parse(upload.metadata) as Metadata, files = lookupFiles.all(id) as UploadFile[];
      checkHead(meta);
      if (!files.length || files.some(file => file.size !== file.offset)) throw new HttpError(409, '上传文件尚未完整接收');
      if (meta.sourceKind === 'file' && (files.length !== 1 || files[0].path !== meta.fileName)) throw new HttpError(400, '原包文件不匹配');
      const source = path.join(root, id), stage = path.join(source, 'prepared'), destination = path.join(dashboardDir, id);
      touch.run(now, id);
      await rm(stage, { recursive: true, force: true });
      if (!versionExists.get(id)) await rm(destination, { recursive: true, force: true });
      let moved = false, committed = false;
      try {
        const asMulter = files.map(file => ({ fieldname: meta.sourceKind === 'file' ? 'file' : 'files[]',
          originalname: meta.sourceKind === 'file' ? Buffer.from(meta.fileName).toString('latin1') : '',
          size: file.size, path: path.join(source, file.id) } as Express.Multer.File));
        const prepared = await prepareDashboard(asMulter, meta.sourceKind === 'folder' ? JSON.stringify(files.map(file => file.path)) : undefined, meta.entry, stage);
        active(owned(user, id), Date.now());
        const manifest = await loadManifest(stage);
        await verifyEntry(stage, manifest);
        const hash = await dashboardHash(stage, prepared.sourceKind, meta.fileName, manifest);
        await syncDirectory(path.join(stage, 'content')); await syncDirectory(stage);
        active(owned(user, id), Date.now());
        await rename(stage, destination); moved = true;
        await syncDirectory(dashboardDir);
        const outcome = publish.immediate(await reauthenticate(), id, meta, prepared, manifest.files.length, hash);
        committed = true;
        return outcome;
      } finally {
        if (!committed) await rm(moved ? destination : stage, { recursive: true, force: true });
      }
    });
    await clean(id);
    return result;
  }
  async function cancel(user: UserRow, id: string) {
    if (owned(user, id).state === 'completed') throw new HttpError(409, '已发布的上传不能取消');
    cancelState.run(id);
    await busy.get(id);
    await clean(id);
    return { ok: true };
  }
  return { start: start.immediate, register, chunk, complete, cancel };
}
