import Database from 'better-sqlite3';
import { mkdirSync } from 'node:fs';
import path from 'node:path';
import type { Role, User } from '../src/contracts.js';

export interface UserRow {
  id: string;
  username: string;
  display_name: string;
  role: Role;
  password_hash: string;
}
interface ForeignKeyViolation { table: string; rowid: number | null; parent: string; fkid: number }

const users = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, username TEXT NOT NULL COLLATE NOCASE UNIQUE,
  display_name TEXT NOT NULL, password_hash TEXT NOT NULL,
  role TEXT NOT NULL CHECK(role IN ('admin','editor','viewer')), created_at TEXT NOT NULL
);`;
const records = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('asset','scene','dashboard')),
  name TEXT NOT NULL, description TEXT NOT NULL DEFAULT '', tags TEXT NOT NULL DEFAULT '[]',
  category_id TEXT REFERENCES categories(id) ON DELETE SET NULL,
  current_version_id TEXT REFERENCES versions(id) DEFERRABLE INITIALLY DEFERRED,
  revision INTEGER NOT NULL DEFAULT 1 CHECK(revision > 0),
  archived INTEGER NOT NULL DEFAULT 0 CHECK(archived IN (0,1)),
  created_at TEXT NOT NULL, updated_at TEXT NOT NULL
);`;
const versions = (name: string) => `CREATE TABLE ${name} (
  id TEXT PRIMARY KEY, record_id TEXT NOT NULL REFERENCES records(id) ON DELETE CASCADE,
  number INTEGER NOT NULL CHECK(number > 0), original_name TEXT NOT NULL,
  size INTEGER NOT NULL CHECK(size >= 0), note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL, uploaded_by TEXT NOT NULL REFERENCES users(id),
  has_thumbnail INTEGER NOT NULL DEFAULT 0 CHECK(has_thumbnail IN (0,1)), thumbnail_path TEXT,
  source_kind TEXT NOT NULL CHECK(source_kind IN ('glb','html','zip','folder')),
  entry TEXT, UNIQUE(record_id,number)
);`;
const categories = `CREATE TABLE categories (
  id TEXT PRIMARY KEY, kind TEXT NOT NULL CHECK(kind IN ('asset','scene','dashboard')),
  name TEXT NOT NULL COLLATE NOCASE, parent_id TEXT REFERENCES categories(id) ON DELETE CASCADE
);
CREATE UNIQUE INDEX category_root_name ON categories(kind,name) WHERE parent_id IS NULL;
CREATE UNIQUE INDEX category_child_name ON categories(parent_id,name) WHERE parent_id IS NOT NULL;`;
const supporting = `
CREATE INDEX record_kind ON records(kind,archived,updated_at);
CREATE INDEX record_category ON records(category_id);
CREATE TABLE upload_receipts (
  user_id TEXT NOT NULL REFERENCES users(id), key TEXT NOT NULL,
  fingerprint TEXT NOT NULL, response TEXT NOT NULL, created_at TEXT NOT NULL,
  PRIMARY KEY(user_id,key)
);
CREATE TRIGGER current_version_record BEFORE UPDATE OF current_version_id ON records
WHEN NEW.current_version_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM versions WHERE id=NEW.current_version_id AND record_id=NEW.id
) BEGIN SELECT RAISE(ABORT,'version does not belong to record'); END;
CREATE TRIGGER category_depth_insert BEFORE INSERT ON categories
WHEN NEW.parent_id IS NOT NULL AND NOT EXISTS (
  SELECT 1 FROM categories WHERE id=NEW.parent_id AND parent_id IS NULL AND kind=NEW.kind
) BEGIN SELECT RAISE(ABORT,'invalid category parent'); END;
`;

export function openDatabase(dataDir: string): Database.Database {
  mkdirSync(dataDir, { recursive: true });
  const db = new Database(path.join(dataDir, 'manager.sqlite'));
  try {
    db.pragma('foreign_keys = ON');
    db.pragma('journal_mode = WAL');
    db.pragma('busy_timeout = 5000');
    db.pragma('synchronous = FULL');
    const version = db.pragma('user_version', { simple: true }) as number;
    if (version > 2) throw new Error('数据库版本高于当前服务支持的版本，请升级服务');
    if (version === 0) {
      db.transaction(() => {
        db.exec(users('users') + categories + records('records') + versions('versions'));
        db.exec(`CREATE TABLE sessions (
          token_hash TEXT PRIMARY KEY, user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          expires_at INTEGER NOT NULL
        ); CREATE INDEX sessions_expiry ON sessions(expires_at);` + supporting);
        db.pragma('user_version = 2');
      }).immediate();
    } else if (version === 1) {
      // Keep sessions and immutable files untouched. Foreign keys must be disabled outside the transaction.
      db.pragma('foreign_keys = OFF');
      try {
        db.transaction(() => {
          db.exec(users('users_v2') + categories + records('records_v2') + versions('versions_v2'));
          db.exec(`
            INSERT INTO users_v2 SELECT u.id,u.username,u.display_name,u.password_hash,
              CASE WHEN u.is_admin=1 THEN 'admin' WHEN EXISTS (
                SELECT 1 FROM project_members m WHERE m.user_id=u.id AND m.role IN ('owner','editor')
              ) THEN 'editor' ELSE 'viewer' END,u.created_at FROM users u;
            INSERT INTO records_v2 (id,kind,name,description,tags,current_version_id,created_at,updated_at)
              SELECT id,kind,name,description,tags,current_version_id,created_at,updated_at FROM records;
            INSERT INTO versions_v2 (id,record_id,number,original_name,size,note,created_at,uploaded_by,has_thumbnail,source_kind)
              SELECT id,record_id,number,original_name,size,note,created_at,uploaded_by,has_thumbnail,'glb' FROM versions;
            DROP TRIGGER current_version_record;
            DROP TABLE project_members; DROP TABLE projects;
            DROP TABLE versions; DROP TABLE records; DROP TABLE users;
            ALTER TABLE users_v2 RENAME TO users;
            ALTER TABLE records_v2 RENAME TO records;
            ALTER TABLE versions_v2 RENAME TO versions;
          ` + supporting);
          const violations = db.pragma('foreign_key_check') as ForeignKeyViolation[];
          if (violations.length) throw new Error('数据库迁移外键检查失败，原数据库保持不变');
          db.pragma('user_version = 2');
        }).immediate();
      } finally { db.pragma('foreign_keys = ON'); }
    }
    return db;
  } catch (error) { db.close(); throw error; }
}

export function publicUser(user: UserRow): User {
  return { id: user.id, username: user.username, displayName: user.display_name, role: user.role };
}
