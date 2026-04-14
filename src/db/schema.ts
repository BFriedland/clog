import type { Database } from "sql.js";

export const CURRENT_SCHEMA_VERSION = 2;

export function applyMigrations(db: Database): void {
  if (!tableExists(db, "schema_version")) {
    createLatestSchema(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return;
  }

  const currentVersion = getSchemaVersion(db);

  if (currentVersion < 1) {
    createConversationsTable(db);
    setSchemaVersion(db, 1);
  }

  if (currentVersion < 2) {
    addColumnIfMissing(db, "conversations", "indexed_at", "TEXT");
    setSchemaVersion(db, 2);
  }
}

function createLatestSchema(db: Database): void {
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL
    );
  `);

  createConversationsTable(db);
}

function createConversationsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversations (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      author TEXT NOT NULL,
      project_name TEXT,
      project_path TEXT,
      tags_json TEXT DEFAULT '[]',
      slug TEXT,
      created_at TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'discovered'
        CHECK(state IN ('discovered','staged','published')),
      published_at TEXT,
      published_message_count INTEGER,
      publish_version INTEGER DEFAULT 0,
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      UNIQUE(source, source_id)
    );
  `);
}

function getSchemaVersion(db: Database): number {
  const result = db.exec("SELECT version FROM schema_version LIMIT 1");

  if (result.length === 0 || result[0]?.values.length === 0) {
    return 0;
  }

  return Number(result[0].values[0]?.[0] ?? 0);
}

function setSchemaVersion(db: Database, version: number): void {
  db.exec("DELETE FROM schema_version");
  db.run("INSERT INTO schema_version (version) VALUES (?)", [version]);
}

function tableExists(db: Database, tableName: string): boolean {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );

  return result.length > 0 && result[0]?.values.length > 0;
}

function addColumnIfMissing(
  db: Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  const existingColumns = new Set(
    result[0]?.values.map((row) => String(row[1])) ?? [],
  );

  if (existingColumns.has(columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
