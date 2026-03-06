export const SCHEMA_VERSION = 2;

export const CREATE_TABLES = `
CREATE TABLE IF NOT EXISTS schema_version (
  version INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS conversations (
  id              TEXT PRIMARY KEY,
  source_id       TEXT NOT NULL,
  source          TEXT NOT NULL,
  title           TEXT NOT NULL,
  summary         TEXT DEFAULT '',
  author          TEXT NOT NULL,
  project         TEXT,
  tags_json       TEXT DEFAULT '[]',
  slug            TEXT,
  created_at      TEXT NOT NULL,
  discovered_at   TEXT NOT NULL,
  modified_at     TEXT NOT NULL,
  state           TEXT NOT NULL DEFAULT 'discovered'
                  CHECK(state IN ('discovered','staged','published')),
  published_at    TEXT,
  publish_version INTEGER DEFAULT 0,
  source_path     TEXT NOT NULL,
  file_path       TEXT,
  source_mtime    TEXT,
  indexed_at      TEXT,
  origin          TEXT DEFAULT NULL,
  UNIQUE(source, source_id)
);

CREATE TABLE IF NOT EXISTS publish_log (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  conversation_id TEXT NOT NULL REFERENCES conversations(id),
  version         INTEGER NOT NULL,
  published_at    TEXT NOT NULL,
  author          TEXT NOT NULL,
  message         TEXT DEFAULT '',
  diff_json       TEXT
);
`;

interface DbLike {
  run: (sql: string) => unknown;
  exec: (sql: string) => Array<{ values: unknown[][] }>;
}

export function createTables(db: DbLike): void {
  db.run(CREATE_TABLES);

  // Initialize schema version if empty
  const result = db.exec("SELECT COUNT(*) FROM schema_version");
  const count = result[0]?.values[0]?.[0] as number;
  if (count === 0) {
    db.run(`INSERT INTO schema_version (version) VALUES (${SCHEMA_VERSION})`);
  }
}

export function migrate(db: DbLike): void {
  const result = db.exec("SELECT version FROM schema_version LIMIT 1");
  const currentVersion = (result[0]?.values[0]?.[0] as number) ?? 0;

  if (currentVersion < 2) {
    // Add origin column for Phase 3 team sharing
    try {
      db.run("ALTER TABLE conversations ADD COLUMN origin TEXT DEFAULT NULL");
    } catch {
      // Column may already exist if table was created fresh with v2 schema
    }
  }

  if (currentVersion < SCHEMA_VERSION) {
    db.run(
      `UPDATE schema_version SET version = ${SCHEMA_VERSION}`
    );
  }
}
