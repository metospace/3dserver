import express, { type RequestHandler } from 'express';
import type Database from 'better-sqlite3';
import type { AuthRequest, PasswordVerifier } from './auth.js';
import { HttpError, objectBody } from './validation.js';
import { createTeamAuth } from './team-auth.js';
import { createTeamDashboards } from './team-dashboards.js';
import { openTeamPublications, TEAM_MAX_BYTES, teamJson, teamRoute } from './team-publications.js';
import { createTeamPublishUploads } from './team-publish-uploads.js';

export function createTeamApi(db: Database.Database, auth: PasswordVerifier, paths: {
  fileDir: string; tempDir: string; dashboardDir: string;
}) {
  const router = express.Router();
  const desktopOrigins = ['http://tauri.localhost', 'https://tauri.localhost', 'tauri://localhost'];
  const origins = new Set((process.env.CHAT3D_TEAM_ORIGINS ?? '').split(',').map(origin => origin.trim()).filter(Boolean));
  for (const origin of origins) {
    if (desktopOrigins.includes(origin)) continue;
    const parsed = new URL(origin);
    if (!['http:', 'https:'].includes(parsed.protocol) || parsed.origin !== origin) throw new Error('CHAT3D_TEAM_ORIGINS 必须是完整的 HTTP(S) 来源，不带路径或末尾斜杠');
  }
  // Tauri's platform origins are fixed. Team endpoints never accept cookie credentials.
  for (const origin of desktopOrigins) origins.add(origin);
  const sessions = createTeamAuth(db, auth);
  const publications = openTeamPublications(db, paths.fileDir, paths.tempDir);
  router.use((req, res, next) => {
    res.set('Cache-Control', 'no-store');
    res.vary('Origin');
    const origin = req.get('origin');
    if (origin) {
      // Prefix routing never opts the native cookie API into CORS.
      if (origin !== `${req.protocol}://${req.get('host')}` && !origins.has(origin)) return next(new HttpError(403, '此客户端来源未获允许'));
      res.set('Access-Control-Allow-Origin', origin);
    }
    if (req.method === 'OPTIONS') {
      res.set('Access-Control-Allow-Methods', 'GET,HEAD,POST,OPTIONS');
      res.set('Access-Control-Allow-Headers', 'Content-Type,Authorization');
      res.status(204).end(); return;
    }
    next();
  });
  router.use(sessions.router, sessions.requireUser);
  router.get('/items', teamRoute((req, res) => res.json(publications.list(req.query.kind, req.query.q))));
  router.get('/items/:id/:version(\\d+)', teamRoute((req, res) => publications.read(req.params.id!, Number(req.params.version), res)));
  // The legacy release posts one JSON request. Bound buffered completion work separately from chunks.
  let legacyInProgress = false;
  const reserveLegacy: RequestHandler = (req, res, next) => {
    if ((req as AuthRequest).user?.role === 'viewer') return next(new HttpError(403, '只读成员不能发布'));
    if (legacyInProgress) return next(new HttpError(429, '已有旧版发布正在处理，请重试同一项'));
    legacyInProgress = true;
    const release = () => { legacyInProgress = false; res.off('close', release); res.off('finish', release); };
    res.once('close', release).once('finish', release);
    next();
  };
  router.post('/publish', reserveLegacy, ...teamJson(TEAM_MAX_BYTES), teamRoute(async (req, res) => {
    const user = await sessions.authenticate(req, true);
    res.json(await publications.publish(user, objectBody(req.body)));
  }));
  router.use('/publish-uploads', createTeamPublishUploads(db, paths.tempDir, sessions.authenticate, publications.publish));
  router.use('/dashboards', createTeamDashboards({ db, ...paths, authenticate: sessions.authenticate }));
  router.use((_req, _res, next) => next(new HttpError(404, '接口不存在')));
  return { router, callback: sessions.callback, close: sessions.close };
}
