import { randomUUID } from 'node:crypto';
import { rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import express, { type NextFunction, type Request, type Response } from 'express';
import type { AuthRequest } from './auth.js';
import { loadManifest, type DashboardSource, syncFile } from './dashboard.js';
import type { UserRow } from './db.js';
import { HttpError, objectBody, text } from './validation.js';
import { screenshotPng } from './team-dashboard-png.js';
import { dashboardHash, openDashboardUploads, sourceFilename, syncDirectory, teamSourceKind } from './team-dashboard-uploads.js';

interface Options {
  db: Database.Database;
  dashboardDir: string;
  fileDir: string;
  tempDir: string;
  authenticate(req: Request, force?: boolean): Promise<UserRow>;
}
interface Screenshot {
  id: string; templateId: string; version: number; packageHash: string; sha256: string;
  width: number; height: number; bytes: number; source: string; capturedAt: string;
  confirmedBy: string; created: string; provenance: 'admin-confirmed-local-render';
}
interface Row {
  id: string; versionId: string; owner: string; version: number; name: string;
  description: string; system: string; archived: number; fileName: string; entry: string;
  created: string; sourceKind: DashboardSource; bytes: number; fileCount: number | null;
  packageHash: string | null; screenshotJson: string | null;
  hasThumbnail: number; thumbnailPath: string | null; bindingId: string | null;
  previousThumbnail: number | null; previousPath: string | null;
}
type Route = (req: AuthRequest, res: Response, next: NextFunction) => void | Promise<void>;
const route = (handler: Route) => (req: AuthRequest, res: Response, next: NextFunction) => {
  Promise.resolve().then(() => handler(req, res, next)).catch(next);
};
const controls = /[\x00-\x1f\x7f-\x9f]/;
const idPattern = /^[a-zA-Z0-9-]{1,80}$/;
const metaBytes = 16 * 1024;
const chunkBytes = 2 * 1024 * 1024;
const screenshotBytes = 12 * 1024 * 1024;
const objectKeys = (value: unknown, allowed: string[]) => {
  const body = objectBody(value);
  if (Object.keys(body).some(key => !allowed.includes(key))) throw new HttpError(400, '包含不支持的字段');
  return body;
};
const parseJson = (limit: number) => {
  const parse = express.json({ limit, inflate: false });
  return (req: Request, res: Response, next: NextFunction) => {
    if (!req.is('application/json')) return next(new HttpError(415, '需要 JSON 请求体'));
    parse(req, res, error => next(error?.status === 415 ? new HttpError(415, 'JSON 编码不受支持') : error));
  };
};
const metadataJson = parseJson(metaBytes), chunkJson = parseJson(chunkBytes), screenshotJson = parseJson(screenshotBytes);
const additionalMime: Record<string, string> = {
  '.csv': 'text/csv', '.xml': 'application/xml', '.avif': 'image/avif', '.bmp': 'image/bmp',
  '.eot': 'application/vnd.ms-fontobject', '.webm': 'video/webm', '.ogg': 'audio/ogg',
  '.wav': 'audio/wav', '.webmanifest': 'application/manifest+json',
};
const screenshotFilename = (id: string) => `${id}.png`;
const imageOf = (row: Row): Screenshot | undefined => row.screenshotJson === null ? undefined : JSON.parse(row.screenshotJson);
function dto(row: Row, fileCount: number) {
  return {
    id: row.id, owner: row.owner, version: row.version, name: row.name, description: row.description,
    system: row.system, archived: Boolean(row.archived), fileName: row.fileName, entry: row.entry,
    created: row.created, sourceKind: teamSourceKind(row.sourceKind), bytes: row.bytes, fileCount,
    packageHash: row.packageHash ?? undefined, screenshot: imageOf(row),
  };
}

function binary(res: Response, next: NextFunction, filename: string, fileName: string, mime: string) {
  res.attachment(fileName).set({ 'Content-Type': mime, 'Content-Security-Policy': "default-src 'none'; sandbox" });
  res.sendFile(path.resolve(filename), { cacheControl: false, lastModified: false, acceptRanges: false }, error => {
    if (!error) return;
    if (!res.headersSent) res.removeHeader('Content-Disposition');
    const failure = error as Error & { status?: number };
    next(failure.status === 404 ? new HttpError(404, '文件不可用') : failure);
  });
}

export function createTeamDashboards({ db, dashboardDir, fileDir, tempDir, authenticate }: Options): express.Router {
  db.exec(`
    CREATE TABLE IF NOT EXISTS team_dashboard_metadata (
      version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
      name TEXT NOT NULL, description TEXT NOT NULL, system TEXT NOT NULL, file_count INTEGER NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_dashboard_hashes (
      version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE, hash TEXT NOT NULL
    );
    CREATE TABLE IF NOT EXISTS team_dashboard_screenshots (
      version_id TEXT PRIMARY KEY REFERENCES versions(id) ON DELETE CASCADE,
      id TEXT NOT NULL UNIQUE, package_hash TEXT NOT NULL, filename TEXT NOT NULL,
      metadata TEXT NOT NULL, previous_thumbnail INTEGER NOT NULL, previous_path TEXT
    );
  `);
  const router = express.Router();
  router.use((_req, res, next) => { res.set({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff' }); next(); });
  const localRole = db.prepare('SELECT role FROM users WHERE id=?');
  function admin(user?: UserRow): UserRow {
    const current = user && localRole.get(user.id) as { role: string } | undefined;
    if (!user || !current) throw new HttpError(401, '请重新登录团队服务');
    if (current.role !== 'admin' || user.role !== 'admin') throw new HttpError(403, '只有管理员可以管理看板');
    return user;
  }
  const adminGate = route((req, _res, next) => { admin(req.user); next(); });
  const forceAdmin = route(async (req, _res, next) => { req.user = admin(await authenticate(req, true)); next(); });
  function member(req: AuthRequest) {
    if (!req.user?.id) throw new HttpError(401, '请重新登录团队服务');
    return req.user;
  }
  const uploads = openDashboardUploads({ db, dashboardDir, tempDir, admin });
  const from = `SELECT r.id, v.id AS versionId,
      (SELECT first_version.uploaded_by FROM versions first_version WHERE first_version.record_id=r.id ORDER BY first_version.number LIMIT 1) AS owner,
      v.number AS version, COALESCE(m.name,r.name) AS name, COALESCE(m.description,r.description) AS description,
      COALESCE(m.system,c.name,'未指定') AS system, r.archived, v.original_name AS fileName, v.entry,
      v.created_at AS created, v.source_kind AS sourceKind, v.size AS bytes, m.file_count AS fileCount,
      h.hash AS packageHash, s.metadata AS screenshotJson, v.has_thumbnail AS hasThumbnail, v.thumbnail_path AS thumbnailPath,
      s.id AS bindingId, s.previous_thumbnail AS previousThumbnail, s.previous_path AS previousPath
    FROM records r JOIN versions v ON v.record_id=r.id
    LEFT JOIN categories c ON c.id=r.category_id AND c.kind='dashboard'
    LEFT JOIN team_dashboard_metadata m ON m.version_id=v.id
    LEFT JOIN team_dashboard_hashes h ON h.version_id=v.id
    LEFT JOIN team_dashboard_screenshots s ON s.version_id=v.id AND s.package_hash=h.hash
      AND v.has_thumbnail=1 AND v.thumbnail_path=s.filename
    WHERE r.kind='dashboard' AND v.source_kind IN ('html','zip','folder')`;
  const queryList = db.prepare(`${from} AND v.number=(SELECT MAX(latest.number) FROM versions latest WHERE latest.record_id=r.id)
    AND (r.archived=0 OR ?=1) ORDER BY v.created_at DESC,r.id`);
  const queryVersion = db.prepare(`${from} AND r.id=? AND v.number=?`);
  function row(id: string, version: number): Row {
    if (!idPattern.test(id) || !Number.isSafeInteger(version) || version < 1) throw new HttpError(400, '看板版本无效');
    const value = queryVersion.get(id, version) as Row | undefined;
    if (!value) throw new HttpError(404, '找不到看板发布版本');
    return value;
  }
  function requested(req: Request) { return row(req.params.id, Number(req.params.version)); }
  const packageDirectory = (value: Row) => path.join(dashboardDir, value.versionId);
  const manifestOf = (value: Row) => loadManifest(packageDirectory(value));
  const setHash = db.prepare('INSERT OR IGNORE INTO team_dashboard_hashes(version_id,hash) VALUES (?,?)');
  async function identity(value: Row) {
    if (value.packageHash === null) {
      const hash = await dashboardHash(packageDirectory(value), value.sourceKind, value.fileName, await manifestOf(value));
      setHash.run(value.versionId, hash);
    }
    const current = row(value.id, value.version);
    return { templateId: current.id, version: current.version, packageHash: current.packageHash!, screenshot: imageOf(current) };
  }

  router.get('/', route(async (req, res) => {
    const user = member(req), rows = queryList.all(Number(user.role === 'admin' && req.query.all === '1')) as Row[];
    const result = [];
    for (const value of rows) result.push(dto(value, value.fileCount ?? (await manifestOf(value)).files.length));
    res.json(result);
  }));
  router.get('/:id/:version(\\d+)', route(async (req, res) => {
    member(req);
    const value = requested(req), manifest = await manifestOf(value);
    res.json({ ...dto(value, manifest.files.length), files: manifest.files.map(file => ({ path: file.path, bytes: file.size })) });
  }));
  router.get('/:id/:version(\\d+)/files', route(async (req, res, next) => {
    member(req);
    const value = requested(req), filename = req.query.path;
    if (typeof filename !== 'string') throw new HttpError(404, '看板资源不存在');
    // Only manifest storage IDs are ever used as filesystem paths.
    const file = (await manifestOf(value)).files.find(item => item.path === filename);
    if (!file) throw new HttpError(404, '看板资源不存在');
    const mime = additionalMime[path.posix.extname(file.path).toLowerCase()] ?? file.mime;
    binary(res, next, path.join(packageDirectory(value), 'content', file.storage), path.posix.basename(file.path), mime);
  }));
  router.get('/:id/:version(\\d+)/source', route((req, res, next) => {
    member(req);
    const value = requested(req);
    const fileName = value.sourceKind === 'folder' && !/\.zip$/i.test(value.fileName) ? `${value.fileName}.zip` : value.fileName;
    binary(res, next, path.join(packageDirectory(value), sourceFilename(value.sourceKind)), fileName,
      value.sourceKind === 'html' ? 'text/html' : 'application/zip');
  }));
  router.post('/uploads', adminGate, metadataJson, route((req, res) => {
    res.json(uploads.start(admin(req.user), req.body));
  }));
  router.post('/uploads/:upload/files', adminGate, metadataJson, route(async (req, res) => {
    res.json(await uploads.register(admin(req.user), req.params.upload, req.body));
  }));
  router.post('/uploads/:upload/files/:file/chunks', adminGate, chunkJson, route(async (req, res) => {
    res.json(await uploads.chunk(admin(req.user), req.params.upload, req.params.file, req.body));
  }));
  router.post('/uploads/:upload/complete', adminGate, metadataJson, forceAdmin, route(async (req, res) => {
    objectBody(req.body);
    res.json(await uploads.complete(admin(req.user), req.params.upload, () => authenticate(req)));
  }));
  router.post('/uploads/:upload/cancel', adminGate, metadataJson, route(async (req, res) => {
    objectBody(req.body);
    res.json(await uploads.cancel(admin(req.user), req.params.upload));
  }));
  const archive = db.prepare("UPDATE records SET archived=?,revision=revision+1,updated_at=? WHERE id=? AND kind='dashboard'");
  router.post('/:id/archive', adminGate, metadataJson, forceAdmin, route((req, res) => {
    const { archived } = objectBody(req.body);
    if (typeof archived !== 'boolean' || !idPattern.test(req.params.id)) throw new HttpError(400, '看板归档参数无效');
    if (!archive.run(Number(archived), new Date().toISOString(), req.params.id).changes) throw new HttpError(404, '看板原件不存在');
    res.json({ id: req.params.id, archived });
  }));

  router.get('/:id/:version(\\d+)/screenshot/info', route(async (req, res) => {
    member(req);
    res.json(await identity(requested(req)));
  }));
  router.get('/:id/:version(\\d+)/screenshot/:screenshot', route((req, res, next) => {
    member(req);
    const shot = imageOf(requested(req));
    if (!shot || shot.id !== req.params.screenshot) throw new HttpError(404, '暂无截图');
    binary(res, next, path.join(fileDir, screenshotFilename(shot.id)), 'dashboard-screenshot.png', 'image/png');
  }));
  const upsertShot = db.prepare(`INSERT INTO team_dashboard_screenshots
    (version_id,id,package_hash,filename,metadata,previous_thumbnail,previous_path) VALUES (?,?,?,?,?,?,?)
    ON CONFLICT(version_id) DO UPDATE SET id=excluded.id,package_hash=excluded.package_hash,filename=excluded.filename,
      metadata=excluded.metadata,previous_thumbnail=excluded.previous_thumbnail,previous_path=excluded.previous_path`);
  const updateThumbnail = db.prepare('UPDATE versions SET has_thumbnail=?,thumbnail_path=? WHERE id=?');
  const deleteShot = db.prepare('DELETE FROM team_dashboard_screenshots WHERE version_id=?');
  const lastShotId = db.prepare('SELECT id FROM team_dashboard_screenshots WHERE version_id=?');
  const dropImage = (id: string) => rm(path.join(fileDir, screenshotFilename(id)), { force: true })
    .catch(error => console.error('清理看板截图失败', error));
  const commitShot = db.transaction((user: UserRow, shot: Screenshot, target: Row) => {
    admin(user);
    const current = row(shot.templateId, shot.version);
    if (current.packageHash !== shot.packageHash || current.bindingId !== target.bindingId ||
        current.hasThumbnail !== target.hasThumbnail || current.thumbnailPath !== target.thumbnailPath) {
      throw new HttpError(409, '截图或看板包已变更，请刷新后重试');
    }
    const previous = lastShotId.get(current.versionId) as { id: string } | undefined;
    upsertShot.run(current.versionId, shot.id, shot.packageHash, screenshotFilename(shot.id), JSON.stringify(shot),
      current.bindingId ? current.previousThumbnail : current.hasThumbnail,
      current.bindingId ? current.previousPath : current.thumbnailPath);
    updateThumbnail.run(1, screenshotFilename(shot.id), current.versionId);
    return previous?.id;
  });
  // Native startup cleanup also handles abandoned UUID staging files in tempDir.
  // Limit concurrent decoding: one valid 16 Mpx image may need 64 MiB of working memory.
  let decoding = false;
  router.post('/:id/:version(\\d+)/screenshot', adminGate, screenshotJson, forceAdmin, route(async (req, res) => {
    const user = admin(req.user), value = requested(req);
    const body = objectKeys(req.body, ['packageHash', 'expectedScreenshotId', 'base64', 'source', 'capturedAt', 'confirmed']);
    const source = text(body.source, '截图来源', 1000, 1, false), expected = body.expectedScreenshotId;
    const captured = typeof body.capturedAt === 'string' ? Date.parse(body.capturedAt) : NaN;
    if (typeof body.packageHash !== 'string' || !/^[a-f0-9]{64}$/.test(body.packageHash) ||
        !(expected === null || typeof expected === 'string') || body.confirmed !== true || controls.test(source) || !source.trim() ||
        !Number.isFinite(captured) || captured > Date.now() + 300000) throw new HttpError(400, '请填写实际渲染来源、拍摄时间并明确确认固定版本');
    const target = await identity(value);
    if (target.packageHash !== body.packageHash) throw new HttpError(409, '截图包内容 hash 不匹配');
    if ((target.screenshot?.id ?? null) !== expected) throw new HttpError(409, '截图已变更，请刷新后重试');
    const thumbnail = row(value.id, value.version);
    if (decoding) throw new HttpError(409, '正在处理其他看板截图，请稍后重试');
    decoding = true;
    const id = randomUUID(), staged = path.join(tempDir, id), destination = path.join(fileDir, screenshotFilename(id));
    let retained = false, moved = false;
    try {
      const image = await screenshotPng(body.base64);
      const shot: Screenshot = { id, templateId: value.id, version: value.version, packageHash: target.packageHash,
        sha256: image.sha256, width: image.width, height: image.height, bytes: image.bytes.length, source: source.trim(),
        capturedAt: new Date(captured).toISOString(), confirmedBy: user.id, created: new Date().toISOString(),
        provenance: 'admin-confirmed-local-render' };
      await writeFile(staged, image.bytes, { flag: 'wx', mode: 0o600 }); await syncFile(staged);
      await rename(staged, destination); moved = true;
      await syncDirectory(fileDir);
      const previous = commitShot.immediate(await authenticate(req), shot, thumbnail);
      retained = true;
      if (previous) await dropImage(previous);
      res.json(shot);
    } finally {
      decoding = false;
      if (!retained) {
        await rm(staged, { force: true });
        if (moved) await dropImage(id);
      }
    }
  }));
  const unbind = db.transaction((user: UserRow, id: string, version: number, expected: string) => {
    admin(user);
    const value = row(id, version);
    if (value.bindingId !== expected) throw new HttpError(409, '截图已变更，请刷新后重试');
    updateThumbnail.run(value.previousThumbnail, value.previousPath, value.versionId);
    deleteShot.run(value.versionId);
  });
  router.post('/:id/:version(\\d+)/screenshot/unbind', adminGate, metadataJson, forceAdmin, route(async (req, res) => {
    const { expectedScreenshotId } = objectKeys(req.body, ['expectedScreenshotId']);
    if (typeof expectedScreenshotId !== 'string') throw new HttpError(400, '截图解绑参数无效');
    unbind.immediate(admin(req.user), req.params.id, Number(req.params.version), expectedScreenshotId);
    await dropImage(expectedScreenshotId);
    res.json({ ok: true });
  }));
  return router;
}
