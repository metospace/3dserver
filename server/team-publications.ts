import { createHash, randomUUID } from 'node:crypto';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { mkdir, open, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type Database from 'better-sqlite3';
import express, { type Request, type Response } from 'express';
import type { AuthRequest } from './auth.js';
import type { UserRow } from './db.js';
import { HttpError, objectBody, text } from './validation.js';
import { requireReceiptRecord } from './resource-files.js';

export const TEAM_MAX_BYTES = 500 * 1024 * 1024;
const keyPattern = /^[a-zA-Z0-9-]{16,80}$/;
const idPattern = /^[a-zA-Z0-9_-]{1,100}$/;
const categoryId = /^category-[a-f\d]{8}(?:-[a-f\d]{4}){3}-[a-f\d]{12}$/i;
const controls = /[\u0000-\u001f\u007f-\u009f]/;
const thumbnailPattern = /^data:image\/(png|jpeg);base64,([a-zA-Z0-9+/]+={0,2})$/;
interface Published { id: string; version: number }
type ModelKind = 'asset' | 'scene';
interface Publication { kind: ModelKind; name: string; description: string; itemId?: string; expectedVersion: number; key: string; categoryPath: string[]; payload: Record<string, unknown> }
interface Item extends Published { owner: string; kind: ModelKind; name: string; description: string; created: string; categoryPath: string; sourceKind: string }
interface Receipt { fingerprint: string; result: string }

function modelKind(kind: unknown): ModelKind {
  if (kind !== 'asset' && kind !== 'scene') throw new HttpError(400, '请指定资产或场景');
  return kind;
}
function label(value: unknown) {
  if (typeof value !== 'string' || controls.test(value)) return;
  const name = value.trim();
  if (name && name.length <= 80 && name !== '全部' && name !== '未分类' && !categoryId.test(name)) return name;
}
export function publicationKey(value: unknown) {
  if (typeof value !== 'string' || !keyPattern.test(value)) throw new HttpError(400, '发布重试标识无效');
  return value;
}
const vector = (value: unknown, length: number) => Array.isArray(value) && value.length === length && value.every(Number.isFinite);

// 3dserver stores portable snapshots verbatim. Chat3D still owns interpretation of
// geometry parameters, animation tracks and project-specific rendering semantics.
function checkPortableDocument(kind: ModelKind, payload: Record<string, unknown>) {
  const bad = () => new HttpError(400, '发布内容不是有效的 Chat3D 可编辑快照');
  const asset = kind === 'asset';
  const doc = asset ? payload : objectBody(payload.scene);
  if (payload.format !== (asset ? 'chat3d-model-asset' : 'chat3d-project') || doc.schemaVersion !== 1 ||
      !Number.isSafeInteger(payload.version) || (asset ? (payload.version as number) < 1 : payload.version !== 1) ||
      doc.unit !== 'm' || doc.upAxis !== 'Y' || !Array.isArray(doc.nodes) || !Array.isArray(doc.materials)) throw bad();
  if (asset) {
    if (typeof doc.id !== 'string' || !idPattern.test(doc.id) || typeof doc.name !== 'string' || !doc.name.trim() ||
        typeof doc.category !== 'string' || !doc.nodes.length || !vector(doc.size, 3) || doc.quality !== 'unreviewed' ||
        typeof doc.front !== 'string' || !['+Z', '-Z', '+X', '-X'].includes(doc.front) ||
        typeof doc.createdAt !== 'string' || !Number.isFinite(Date.parse(doc.createdAt)) ||
        !Number.isSafeInteger(doc.externalConnectionsRemoved) || (doc.externalConnectionsRemoved as number) < 0) throw bad();
  } else if (typeof doc.projectId !== 'string' || !doc.projectId || !Number.isSafeInteger(doc.revision) ||
      (doc.revision as number) < 0 || !Array.isArray(doc.assets) || doc.assets.length) throw bad();
  const materials = new Set<string>();
  const nodes = new Set<string>();
  for (const material of doc.materials) {
    const { id, baseColor, roughness, metalness } = objectBody(material);
    if (typeof id !== 'string' || !id.trim() || materials.has(id) || typeof baseColor !== 'string' ||
        !/^#[a-f\d]{6}$/i.test(baseColor) || !Number.isFinite(roughness) || !Number.isFinite(metalness)) throw bad();
    materials.add(id);
  }
  for (const node of doc.nodes) {
    const { id, kind: type, parentId, name, visible, materialId, geometry, transform } = objectBody(node);
    const shape = objectBody(geometry), pose = objectBody(transform);
    objectBody(shape.params);
    if (typeof id !== 'string' || !id.trim() || nodes.has(id) || type !== 'primitive' || parentId !== null ||
        typeof name !== 'string' || typeof visible !== 'boolean' || typeof shape.type !== 'string' || !shape.type ||
        (materialId != null && (typeof materialId !== 'string' || !materials.has(materialId))) ||
        !vector(pose.position, 3) || !vector(pose.rotationQuaternion, 4) || !vector(pose.scale, 3)) throw bad();
    nodes.add(id);
  }
}
function publication(body: Record<string, unknown>): Publication {
  const kind = modelKind(body.kind), payload = objectBody(body.payload), key = publicationKey(body.key);
  const name = text(body.name, '名称', 80, 1), description = text(body.description, '说明', 2000, 0, false);
  const expectedVersion = body.expectedVersion === undefined ? 0 : body.expectedVersion;
  if (typeof expectedVersion !== 'number' || !Number.isSafeInteger(expectedVersion) || expectedVersion < 0) throw new HttpError(400, '发布版本无效');
  const itemId = body.itemId;
  if (itemId !== undefined && (typeof itemId !== 'string' || !idPattern.test(itemId))) throw new HttpError(400, '原件编号无效');
  let categoryPath: string[];
  if (body.categoryPath === undefined) {
    const old = kind === 'asset' && label(payload.category);
    categoryPath = old ? [old] : [];
  } else {
    if (!Array.isArray(body.categoryPath) || body.categoryPath.length > 2) throw new HttpError(400, '分类路径无效');
    categoryPath = body.categoryPath.map(value => {
      const normalized = label(value);
      if (!normalized) throw new HttpError(400, '分类路径无效');
      return normalized;
    });
  }
  checkPortableDocument(kind, payload);
  return { kind, payload, key, name, description, itemId, expectedVersion, categoryPath };
}

export function openTeamPublications(db: Database.Database, files: string, staging: string) {
  db.exec(`CREATE TABLE IF NOT EXISTS team_publication_versions (
    version_id TEXT PRIMARY KEY REFERENCES versions(id), name TEXT NOT NULL, description TEXT NOT NULL,
    category_path TEXT NOT NULL
  ); CREATE TABLE IF NOT EXISTS team_publication_receipts (
    user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, fingerprint TEXT NOT NULL, result TEXT NOT NULL,
    PRIMARY KEY(user_id, key)
  );`);
  const result = (user: string, key: string, fingerprint: string) => {
    const row = db.prepare('SELECT fingerprint,result FROM team_publication_receipts WHERE user_id=? AND key=?').get(user, key) as Receipt | undefined;
    if (row && row.fingerprint !== fingerprint) throw new HttpError(409, '重试标识已用于其他内容');
    if (!row) return;
    const published = JSON.parse(row.result) as Published;
    requireReceiptRecord(db, published.id);
    return published;
  };
  const fields = `r.id,r.kind,v.number AS version,v.source_kind AS sourceKind,p.name,p.description,v.created_at AS created,p.category_path AS categoryPath,
      (SELECT uploaded_by FROM versions WHERE record_id=r.id ORDER BY number LIMIT 1) AS owner`;
  const from = 'FROM records r JOIN versions v ON v.record_id=r.id JOIN team_publication_versions p ON p.version_id=v.id';
  // The management page can select an older display version. Chat3D always
  // publishes against the newest immutable version, never against that pointer.
  const newest = 'v.number=(SELECT MAX(number) FROM versions WHERE record_id=r.id)';
  const latestPublished = `EXISTS (SELECT 1 FROM versions latest JOIN team_publication_versions published ON published.version_id=latest.id
    WHERE latest.record_id=r.id AND latest.number=(SELECT MAX(number) FROM versions WHERE record_id=r.id))`;
  const visibleFrom = `FROM records r JOIN versions v ON v.record_id=r.id
    LEFT JOIN team_publication_versions p ON p.version_id=v.id
    LEFT JOIN categories c ON c.id=r.category_id LEFT JOIN categories parent ON parent.id=c.parent_id`;
  const visibleFields = `r.id,r.kind,v.number AS version,v.source_kind AS sourceKind,
    CASE WHEN p.version_id IS NOT NULL THEN p.name ELSE r.name END AS name,
    CASE WHEN p.version_id IS NOT NULL THEN p.description ELSE r.description END AS description,
    v.created_at AS created,CASE WHEN p.version_id IS NOT NULL THEN p.category_path
      WHEN c.id IS NULL THEN '[]' WHEN parent.id IS NULL THEN json_array(c.name) ELSE json_array(parent.name,c.name) END AS categoryPath,
    (SELECT uploaded_by FROM versions WHERE record_id=r.id ORDER BY number LIMIT 1) AS owner`;
  const managementVisible = `NOT (${latestPublished}) AND v.id=r.current_version_id`;
  function visibleVersion(id: string, version: number) {
    if (!idPattern.test(id) || !Number.isSafeInteger(version) || version < 1) throw new HttpError(404, '找不到发布版本');
    const row = db.prepare(`SELECT v.id AS versionId,v.size,v.has_thumbnail AS hasThumbnail,v.thumbnail_path AS thumbnailPath,
      ${visibleFields} ${visibleFrom} WHERE r.id=? AND v.number=? AND r.kind IN ('asset','scene') AND r.archived=0
      AND (p.version_id IS NOT NULL OR (${managementVisible}))`).get(id, version) as
      (Item & { versionId: string; size: number; hasThumbnail: number; thumbnailPath: string | null }) | undefined;
    if (!row) throw new HttpError(404, '找不到发布版本');
    return row;
  }
  const dto = ({ categoryPath, ...row }: Item) => ({ ...row, categoryPath: JSON.parse(categoryPath) as string[] });
  function categoryIdFor(kind: ModelKind, categoryPath: string[]) {
    let parent: string | null = null;
    for (const name of categoryPath) {
      const row = db.prepare('SELECT id FROM categories WHERE kind=? AND parent_id IS ? AND name=?').get(kind, parent, name) as { id: string } | undefined;
      const id = row?.id ?? randomUUID();
      if (!row) db.prepare('INSERT INTO categories (id,kind,name,parent_id) VALUES (?,?,?,?)').run(id, kind, name, parent);
      parent = id;
    }
    return parent;
  }
  function target(user: UserRow, input: Publication) {
    if (input.itemId === undefined) return;
    const current = db.prepare(`SELECT ${fields} ${from} WHERE r.id=? AND ${newest} AND r.archived=0`).get(input.itemId) as Item | undefined;
    if (!current) throw new HttpError(404, '找不到可编辑的团队原件');
    if (current.owner !== user.id && user.role !== 'admin') throw new HttpError(403, '只有发布者或管理员可以更新原件');
    if (current.kind !== input.kind || current.version !== input.expectedVersion) throw new HttpError(409, '原件已有新版本，请刷新后重试');
    return { id: current.id, version: current.version + 1 };
  }
  function writer(user: UserRow) {
    const fresh = db.prepare('SELECT * FROM users WHERE id=?').get(user.id) as UserRow | undefined;
    if (!fresh) throw new HttpError(401, '请重新登录团队服务');
    if (fresh.role === 'viewer') throw new HttpError(403, '只读成员不能发布');
    return fresh;
  }
  async function publish(user: UserRow, body: Record<string, unknown>) {
    const initial = writer(user), input = publication(body);
    const { payload: document, key, ...metadata } = input;
    const payload = JSON.stringify(document);
    const fingerprint = createHash('sha256').update(JSON.stringify(metadata)).update('\n').update(payload).digest('hex');
    const prior = result(user.id, key, fingerprint);
    if (prior) return prior;
    if (input.itemId === undefined && input.expectedVersion !== 0) throw new HttpError(409, '原件基线版本无效');
    target(initial, input);
    const size = Buffer.byteLength(payload);
    if (size > TEAM_MAX_BYTES) throw new HttpError(413, '可编辑快照超过 500 MiB');
    const versionId = randomUUID(), destination = path.join(files, `${versionId}.json`);
    const directory = path.join(staging, versionId);
    const thumbnail = typeof input.payload.thumbnail === 'string' && input.kind === 'asset' && input.payload.thumbnail.length <= 2 * 1024 * 1024
      ? thumbnailPattern.exec(input.payload.thumbnail) : null;
    const thumbnailName = thumbnail && `${versionId}.${thumbnail[1] === 'png' ? 'png' : 'jpg'}`;
    let committed = false;
    try {
      await mkdir(directory, { mode: 0o700 });
      const source = path.join(directory, 'snapshot.json');
      await writeFile(source, payload, { flag: 'wx', mode: 0o600, flush: true });
      await rename(source, destination);
      if (thumbnail && thumbnailName) await writeFile(path.join(files, thumbnailName), Buffer.from(thumbnail[2], 'base64'), { flag: 'wx', mode: 0o600, flush: true });
      if (process.platform !== 'win32') {
        const handle = await open(files, 'r');
        try { await handle.sync(); } finally { await handle.close(); }
      }
      const published = db.transaction(() => {
        const fresh = writer(user);
        const replay = result(user.id, key, fingerprint);
        if (replay) return replay;
        const next = target(fresh, input) ?? { id: randomUUID(), version: 1 }, now = new Date().toISOString();
        const category = categoryIdFor(input.kind, input.categoryPath);
        if (!input.itemId) db.prepare(`INSERT INTO records(id,kind,name,description,category_id,created_at,updated_at) VALUES(?,?,?,?,?,?,?)`)
          .run(next.id, input.kind, input.name, input.description, category, now, now);
        db.prepare(`INSERT INTO versions(id,record_id,number,original_name,size,created_at,uploaded_by,has_thumbnail,thumbnail_path,source_kind)
          VALUES(?,?,?,?,?,?,?,?,?,'chat3d')`).run(versionId, next.id, next.version,
          `${input.name.replace(/[\\/:*?"<>|]/g, '_')}.${input.kind === 'asset' ? 'chat3d-asset' : 'chat3d-project'}.json`, size, now, user.id, thumbnailName ? 1 : 0, thumbnailName);
        db.prepare('INSERT INTO team_publication_versions VALUES(?,?,?,?)').run(versionId, input.name, input.description, JSON.stringify(input.categoryPath));
        db.prepare(`UPDATE records SET name=?,description=?,category_id=?,current_version_id=?,updated_at=?,revision=revision+? WHERE id=?`)
          .run(input.name, input.description, category, versionId, now, input.itemId ? 1 : 0, next.id);
        db.prepare('INSERT INTO team_publication_receipts VALUES(?,?,?,?)').run(user.id, key, fingerprint, JSON.stringify(next));
        return { ...next, retained: true };
      }).immediate();
      committed = 'retained' in published;
      return { id: published.id, version: published.version };
    } finally {
      await rm(directory, { recursive: true, force: true });
      if (!committed) {
        await rm(destination, { force: true });
        if (thumbnailName) await rm(path.join(files, thumbnailName), { force: true });
      }
    }
  }
  return {
    publish,
    list(kind: unknown, q: unknown) {
      const search = text(q, '搜索内容', 200);
      const rows = db.prepare(`SELECT ${visibleFields} ${visibleFrom} WHERE r.kind=? AND r.archived=0
        AND ((p.version_id IS NOT NULL AND ${newest}) OR (${managementVisible}))
        AND (instr(lower(CASE WHEN p.version_id IS NOT NULL THEN p.name ELSE r.name END),lower(?))>0
          OR instr(lower(CASE WHEN p.version_id IS NOT NULL THEN p.description ELSE r.description END),lower(?))>0)
        ORDER BY v.created_at DESC,r.id LIMIT 500`).all(modelKind(kind), search, search) as Item[];
      return rows.map(dto);
    },
    async read(id: string, version: number, res: Response) {
      const { versionId, size, hasThumbnail, thumbnailPath, ...item } = visibleVersion(id, version);
      if (item.sourceKind !== 'glb' && item.sourceKind !== 'chat3d') throw new HttpError(404, '找不到发布版本');
      const input = await open(path.join(files, `${versionId}.${item.sourceKind === 'glb' ? 'glb' : 'json'}`), 'r');
      try {
        if ((await input.stat()).size !== size) throw new Error('Team resource byte length mismatch');
        if (item.sourceKind === 'glb') {
          res.type('model/gltf-binary').set('Content-Length', String(size));
          await pipeline(input.createReadStream({ autoClose: false }), res);
          return;
        }
        const prefix = `${JSON.stringify(dto(item)).slice(0, -1)},"payload":`;
        res.type('json').set('Content-Length', String(Buffer.byteLength(prefix) + size + 1));
        async function* responseBody() {
          yield prefix;
          yield* input.createReadStream({ autoClose: false });
          yield '}';
        }
        await pipeline(Readable.from(responseBody()), res);
      } finally { await input.close(); }
    },
    async thumbnail(id: string, version: number, res: Response) {
      const row = visibleVersion(id, version);
      if (!row.hasThumbnail) throw new HttpError(404, '缩略图不存在');
      const filename = row.thumbnailPath ?? `${row.versionId}.png`;
      res.type(filename.endsWith('.jpg') ? 'image/jpeg' : 'image/png');
      const { promise, resolve, reject } = Promise.withResolvers<void>();
      res.sendFile(path.resolve(files, filename), error => error ? reject(error) : resolve());
      await promise;
    },
  };
}

export function teamJson(limit: string | number) {
  const parse = express.json({ limit, inflate: false });
  return [((req, _res, next) => req.is('application/json') ? next() : next(new HttpError(415, '需要 JSON 请求'))) as express.RequestHandler, parse];
}
export const teamRoute = (handler: (req: AuthRequest, res: Response) => unknown | Promise<unknown>): express.RequestHandler =>
  (req: Request, res, next) => { Promise.resolve().then(() => handler(req, res)).catch(next); };
