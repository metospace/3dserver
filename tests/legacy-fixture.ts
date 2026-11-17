import Database from 'better-sqlite3'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { createHash, scryptSync } from 'node:crypto'

export const legacySession = 'a'.repeat(64)
export function createLegacyFixture(directory: string, model: Buffer) {
  mkdirSync(join(directory, 'files'), { recursive: true })
  const db = new Database(join(directory, 'manager.sqlite'))
  const salt = Buffer.alloc(16, 1)
  const password = `scrypt$${salt.toString('hex')}$${scryptSync('123456', salt, 64).toString('hex')}`
  db.exec(`
    PRAGMA foreign_keys=ON;
    CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT COLLATE NOCASE UNIQUE NOT NULL,display_name TEXT NOT NULL,password_hash TEXT NOT NULL,is_admin INTEGER NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE sessions(token_hash TEXT PRIMARY KEY,user_id TEXT NOT NULL REFERENCES users(id),expires_at INTEGER NOT NULL);
    CREATE TABLE projects(id TEXT PRIMARY KEY,name TEXT NOT NULL,description TEXT NOT NULL,created_at TEXT NOT NULL);
    CREATE TABLE project_members(project_id TEXT NOT NULL REFERENCES projects(id),user_id TEXT NOT NULL REFERENCES users(id),role TEXT NOT NULL,PRIMARY KEY(project_id,user_id));
    CREATE TABLE records(id TEXT PRIMARY KEY,project_id TEXT NOT NULL REFERENCES projects(id),kind TEXT NOT NULL,name TEXT NOT NULL,description TEXT NOT NULL,tags TEXT NOT NULL,current_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,created_at TEXT NOT NULL,updated_at TEXT NOT NULL);
    CREATE TABLE versions(id TEXT PRIMARY KEY,record_id TEXT NOT NULL REFERENCES records(id),number INTEGER NOT NULL,original_name TEXT NOT NULL,size INTEGER NOT NULL,note TEXT NOT NULL,created_at TEXT NOT NULL,uploaded_by TEXT NOT NULL REFERENCES users(id),has_thumbnail INTEGER NOT NULL,UNIQUE(record_id,number));
    CREATE TRIGGER current_version_record BEFORE UPDATE OF current_version_id ON records WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS(SELECT 1 FROM versions WHERE id=NEW.current_version_id AND record_id=NEW.id) BEGIN SELECT RAISE(ABORT,'version does not belong to record');END;
    PRAGMA user_version=1;
  `)
  const now = new Date().toISOString()
  for (const [id, admin] of [['legacy-admin', 1], ['legacy-editor', 0], ['legacy-viewer', 0]] as const) db.prepare('INSERT INTO users VALUES(?,?,?,?,?,?)').run(id, id, id, password, admin, now)
  db.prepare('INSERT INTO sessions VALUES(?,?,?)').run(createHash('sha256').update(legacySession).digest('hex'), 'legacy-admin', Date.now() + 3600000)
  db.prepare('INSERT INTO projects VALUES(?,?,?,?)').run('legacy-project', '旧项目', '', now)
  db.prepare('INSERT INTO project_members VALUES(?,?,?)').run('legacy-project', 'legacy-editor', 'owner')
  db.prepare('INSERT INTO project_members VALUES(?,?,?)').run('legacy-project', 'legacy-viewer', 'viewer')
  db.transaction(() => {
    db.prepare('INSERT INTO records VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-record', 'legacy-project', 'asset', '保留设备', '旧描述', '["历史"]', null, now, now)
    db.prepare('INSERT INTO versions VALUES(?,?,?,?,?,?,?,?,?)').run('legacy-version', 'legacy-record', 1, '原始设备.glb', model.length, '初始版本', now, 'legacy-admin', 0)
    db.prepare('UPDATE records SET current_version_id=? WHERE id=?').run('legacy-version', 'legacy-record')
  })()
  db.close()
  writeFileSync(join(directory, 'files', 'legacy-version.glb'), model)
}
