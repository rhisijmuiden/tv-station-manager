import { DatabaseSync } from "node:sqlite";
import { join } from "node:path";

export type Db = DatabaseSync;

const MIGRATIONS: string[] = [
  `CREATE TABLE users (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     username TEXT NOT NULL UNIQUE COLLATE NOCASE,
     password_hash TEXT NOT NULL,
     display_name TEXT,
     email TEXT,
     role TEXT NOT NULL DEFAULT 'admin',
     language TEXT NOT NULL DEFAULT 'en',
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE sessions (
     token TEXT PRIMARY KEY,
     user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
     expires_at INTEGER NOT NULL,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
   CREATE TABLE backup_targets (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     name TEXT NOT NULL,
     protocol TEXT NOT NULL CHECK (protocol IN ('ftp','ftps','scp')),
     config TEXT NOT NULL,
     enabled INTEGER NOT NULL DEFAULT 1,
     created_at TEXT NOT NULL DEFAULT (datetime('now'))
   );
   CREATE TABLE backup_runs (
     id TEXT PRIMARY KEY,
     target_id INTEGER REFERENCES backup_targets(id) ON DELETE SET NULL,
     kind TEXT NOT NULL CHECK (kind IN ('full','incremental')),
     parent_id TEXT,
     base_id TEXT,
     status TEXT NOT NULL,
     remote_name TEXT,
     size_bytes INTEGER,
     file_count INTEGER,
     error TEXT,
     manifest TEXT,
     started_at TEXT NOT NULL,
     finished_at TEXT
   );`,
];

export function openDb(dataDir: string): Db {
  const db = new DatabaseSync(join(dataDir, "app.db"));
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  return db;
}

/** Runs migrations. `scope` lets apps add their own numbered migrations next to the platform ones. */
export function migrate(db: Db, migrations: string[] = MIGRATIONS, scope = "platform") {
  db.exec(`CREATE TABLE IF NOT EXISTS migrations (scope TEXT NOT NULL, idx INTEGER NOT NULL, PRIMARY KEY (scope, idx))`);
  const done = new Set(
    (db.prepare("SELECT idx FROM migrations WHERE scope = ?").all(scope) as { idx: number }[]).map((r) => r.idx),
  );
  migrations.forEach((sql, idx) => {
    if (done.has(idx)) return;
    db.exec("BEGIN");
    try {
      db.exec(sql);
      db.prepare("INSERT INTO migrations (scope, idx) VALUES (?, ?)").run(scope, idx);
      db.exec("COMMIT");
    } catch (err) {
      db.exec("ROLLBACK");
      throw err;
    }
  });
}

export class Settings {
  constructor(private db: Db) {}
  get<T>(key: string, fallback: T): T {
    const row = this.db.prepare("SELECT value FROM settings WHERE key = ?").get(key) as { value: string } | undefined;
    return row ? (JSON.parse(row.value) as T) : fallback;
  }
  set(key: string, value: unknown) {
    this.db
      .prepare("INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
      .run(key, JSON.stringify(value));
  }
}
