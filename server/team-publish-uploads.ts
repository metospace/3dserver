import { createHash, randomUUID } from 'node:crypto';
import { createReadStream, createWriteStream, mkdirSync } from 'node:fs';
import { open, readFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGunzip } from 'node:zlib';
import express, { type Request } from 'express';
import type Database from 'better-sqlite3';
import type { UserRow } from './db.js';
import { HttpError, objectBody } from './validation.js';
import { publicationKey, TEAM_MAX_BYTES, teamJson, teamRoute } from './team-publications.js';

const CHUNK_BYTES = 1024 * 1024;
const MAX_IDLE = 24 * 3600 * 1000;
const BASE64_CHUNK_BYTES = 4 * Math.ceil(CHUNK_BYTES / 3);
const fingerprintPattern = /^[a-f0-9]{64}$/;
const base64 = /^[A-Za-z0-9+/]+={0,2}$/;
const stagingId = /^[a-f0-9-]{36}$/;
interface Published { id: string; version: number }
interface Row { id: string; user_id: string; key: string; digest: string; total: number; offset: number; encoding: 'json' | 'gzip'; result: string | null }

export function createTeamPublishUploads(db: Database.Database, tempDir: string,
  authenticate: (req: Request, force?: boolean) => Promise<UserRow>,
  publish: (user: UserRow, body: Record<string, unknown>) => Promise<Published>) {
  const router = express.Router(), directory = path.join(tempDir, 'team-publish');
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  db.exec(`CREATE TABLE IF NOT EXISTS team_publish_uploads (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL, digest TEXT NOT NULL,
    total INTEGER NOT NULL, offset INTEGER NOT NULL DEFAULT 0, encoding TEXT NOT NULL, result TEXT, touched INTEGER NOT NULL,
    UNIQUE(user_id,key)
  ); CREATE INDEX IF NOT EXISTS team_upload_age ON team_publish_uploads(touched) WHERE result IS NULL;`);
  const findId = db.prepare('SELECT * FROM team_publish_uploads WHERE id=? AND user_id=?');
  const findKey = db.prepare('SELECT * FROM team_publish_uploads WHERE user_id=? AND key=?');
  const status = (row: Row) => ({ uploadId: row.id, offset: row.offset, total: row.total, encoding: row.encoding,
    ...(row.result ? { result: JSON.parse(row.result) as Published } : {}) });
  const busy = new Set<string>();
  let completeInProgress = false;
  let lastSweep = 0;
  const part = (id: string) => path.join(directory, `${id}.part`);
  async function sweep(now: number) {
    if (now - lastSweep < 3600000) return;
    lastSweep = now;
    const stale = db.prepare('SELECT id FROM team_publish_uploads WHERE result IS NULL AND touched<?').all(now - MAX_IDLE) as { id: string }[];
    for (const { id } of stale) {
      if (busy.has(id)) continue;
      db.prepare('DELETE FROM team_publish_uploads WHERE id=?').run(id);
      await rm(part(id), { force: true });
      await rm(path.join(directory, `${id}.json`), { force: true });
    }
  }
  function requireWriter(user: UserRow) {
    if (user.role === 'viewer') throw new HttpError(403, '只读成员不能发布');
  }
  async function ownedOperation<T>(id: string, user: UserRow, run: (row: Row) => Promise<T>) {
    requireWriter(user);
    if (!stagingId.test(id)) throw new HttpError(404, '找不到此发布上传');
    const row = findId.get(id, user.id) as Row | undefined;
    if (!row) throw new HttpError(404, '找不到此发布上传');
    if (busy.has(id)) throw new HttpError(409, '发布上传正在处理，请重试同一项');
    busy.add(id);
    try { return await run(row); } finally { busy.delete(id); }
  }
  const json = teamJson('2mb');
  router.post('/start', ...json, teamRoute(async (req, res) => {
    const user = await authenticate(req, true); requireWriter(user);
    const body = objectBody(req.body), key = publicationKey(body.key), encoding = body.encoding ?? 'json';
    const { total, digest } = body;
    if ((encoding !== 'json' && encoding !== 'gzip') || typeof total !== 'number' || !Number.isSafeInteger(total) ||
        total < 1 || total > TEAM_MAX_BYTES || typeof digest !== 'string' || !fingerprintPattern.test(digest)) throw new HttpError(400, '发布上传信息无效或超过 500 MiB');
    const now = Date.now();
    await sweep(now);
    const row = findKey.get(user.id, key) as Row | undefined;
    if (row) {
      if (row.total !== total || row.digest !== digest || row.encoding !== encoding) throw new HttpError(409, '重试标识已用于其他内容');
      db.prepare('UPDATE team_publish_uploads SET touched=? WHERE id=?').run(now, row.id);
      res.json(status(row)); return;
    }
    const active = db.prepare('SELECT COUNT(*) AS count FROM team_publish_uploads WHERE user_id=? AND result IS NULL').get(user.id) as { count: number };
    if (active.count >= 10) throw new HttpError(429, '未完成的发布上传过多，请重试已有上传或等待过期');
    const id = randomUUID();
    db.prepare('INSERT INTO team_publish_uploads(id,user_id,key,digest,total,encoding,touched) VALUES(?,?,?,?,?,?,?)').run(id, user.id, key, digest, total, encoding, now);
    res.json({ uploadId: id, offset: 0, total, encoding });
  }));
  router.post('/:id/chunk', ...json, teamRoute(async (req, res) => {
    const next = await ownedOperation(req.params.id!, req.user!, async row => {
      if (row.result) throw new HttpError(409, '发布上传已经完成，请重新查询上传状态');
      const { offset, data } = objectBody(req.body);
      if (typeof offset !== 'number' || !Number.isSafeInteger(offset) || offset < 0 || offset % CHUNK_BYTES || offset >= row.total ||
          typeof data !== 'string' || !data.length || data.length > BASE64_CHUNK_BYTES || data.length % 4 || !base64.test(data)) throw new HttpError(400, '上传分块编码或偏移无效');
      const bytes = Buffer.from(data, 'base64');
      if (bytes.length !== Math.min(CHUNK_BYTES, row.total - offset) || bytes.toString('base64') !== data) throw new HttpError(400, '上传分块大小或编码无效');
      if (offset > row.offset) throw new HttpError(409, '上传偏移与已确认位置不一致');
      const handle = await open(part(row.id), row.offset ? 'r+' : 'w+', 0o600);
      try {
        if (offset < row.offset) {
          const previous = Buffer.allocUnsafe(bytes.length);
          for (let cursor = 0; cursor < previous.length;) {
            const read = await handle.read(previous, cursor, previous.length - cursor, offset + cursor);
            if (!read.bytesRead) throw new Error('Confirmed upload bytes missing');
            cursor += read.bytesRead;
          }
          if (!bytes.equals(previous)) throw new HttpError(409, '重试分块内容与已确认内容不同');
        } else {
          if ((await handle.stat()).size < row.offset) throw new Error('Confirmed upload bytes missing');
          await handle.truncate(row.offset);
          for (let cursor = 0; cursor < bytes.length;) {
            const written = await handle.write(bytes, cursor, bytes.length - cursor, offset + cursor);
            if (!written.bytesWritten) throw new Error('Upload storage made no write progress');
            cursor += written.bytesWritten;
          }
          await handle.sync();
          row.offset += bytes.length;
        }
        db.prepare('UPDATE team_publish_uploads SET offset=?,touched=? WHERE id=?').run(row.offset, Date.now(), row.id);
        return status(row);
      } finally { await handle.close(); }
    });
    res.json(next);
  }));
  router.post('/:id/complete', ...json, teamRoute(async (req, res) => {
    objectBody(req.body);
    const user = await authenticate(req, true);
    const result = await ownedOperation(req.params.id!, user, async row => {
      if (row.result) return JSON.parse(row.result) as Published;
      if (row.offset !== row.total) throw new HttpError(409, '发布上传尚未完成');
      if (completeInProgress) throw new HttpError(429, '已有发布正在处理，请重试同一项');
      completeInProgress = true;
      const filename = part(row.id), expanded = path.join(directory, `${row.id}.json`);
      try {
        const handle = await open(filename, 'r');
        try {
          if ((await handle.stat()).size !== row.total) throw new Error('Confirmed upload byte length mismatch');
          const digest = createHash('sha256'), buffer = Buffer.allocUnsafe(Math.min(row.total, CHUNK_BYTES));
          for (let offset = 0; offset < row.total; offset += CHUNK_BYTES) {
            const size = Math.min(buffer.length, row.total - offset);
            for (let cursor = 0; cursor < size;) {
              const read = await handle.read(buffer, cursor, size - cursor, offset + cursor);
              if (!read.bytesRead) throw new Error('Confirmed upload bytes missing');
              cursor += read.bytesRead;
            }
            digest.update(createHash('sha256').update(buffer.subarray(0, size)).digest('hex'));
          }
          if (digest.digest('hex') !== row.digest) throw new HttpError(409, '上传内容校验失败，请保留原发布项重试');
        } finally { await handle.close(); }
        if (row.encoding === 'gzip') {
          let size = 0;
          const limit = new Transform({ transform(bytes: Buffer, _encoding, done) {
            size += bytes.length;
            if (size > TEAM_MAX_BYTES) done(new HttpError(413, '发布上传解压后超过 500 MiB'));
            else done(null, bytes);
          } });
          try { await pipeline(createReadStream(filename), createGunzip(), limit, createWriteStream(expanded, { mode: 0o600 })); }
          catch (error) {
            if (['Z_DATA_ERROR', 'Z_BUF_ERROR', 'Z_NEED_DICT'].includes((error as NodeJS.ErrnoException).code ?? '')) throw new HttpError(400, '发布上传 gzip 压缩包损坏或无效');
            throw error;
          }
        }
        const bytes = await readFile(row.encoding === 'gzip' ? expanded : filename);
        let body: Record<string, unknown>;
        try { body = objectBody(JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes))); }
        catch { throw new HttpError(400, '发布上传不是有效 UTF-8 JSON'); }
        if (body.key !== row.key) throw new HttpError(400, '发布上传重试标识不匹配');
        const outcome = await publish(await authenticate(req), body);
        db.prepare('UPDATE team_publish_uploads SET result=?,touched=? WHERE id=?').run(JSON.stringify(outcome), Date.now(), row.id);
        await rm(filename, { force: true }).catch(error => console.error('清理已发布分块失败', error));
        return outcome;
      } finally {
        completeInProgress = false;
        await rm(expanded, { force: true }).catch(error => console.error('清理解压暂存失败', error));
      }
    });
    res.json(result);
  }));
  return router;
}
