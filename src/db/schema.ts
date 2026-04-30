import type { Database } from "sql.js";

export const CURRENT_SCHEMA_VERSION = 4;

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

  if (currentVersion < 3) {
    addColumnIfMissing(db, "conversations", "origin", "TEXT DEFAULT NULL");
    setSchemaVersion(db, 3);
  }

  if (currentVersion < 4) {
    migrateToV4(db);
    setSchemaVersion(db, 4);
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
        CHECK(state IN ('discovered','staged','saved')),
      saved_at TEXT,
      saved_message_count INTEGER,
      save_version INTEGER DEFAULT 0,
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      origin TEXT DEFAULT NULL,
      UNIQUE(source, source_id)
    );
  `);
}

function migrateToV4(db: Database): void {
  if (!tableExists(db, "conversations")) {
    return;
  }

  const existingColumns = getColumnNames(db, "conversations");

  // If the v3 column names are still present, rebuild the table with the v4
  // schema and translate the "published" state to "saved" while we copy.
  if (!existingColumns.has("published_at")) {
    return;
  }

  db.exec(`
    CREATE TABLE conversations_v4 (
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
        CHECK(state IN ('discovered','staged','saved')),
      saved_at TEXT,
      saved_message_count INTEGER,
      save_version INTEGER DEFAULT 0,
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      origin TEXT DEFAULT NULL,
      UNIQUE(source, source_id)
    );

    INSERT INTO conversations_v4 (
      id, source_id, source, title, summary, author, project_name, project_path,
      tags_json, slug, created_at, discovered_at, modified_at, state,
      saved_at, saved_message_count, save_version,
      source_path, file_path, source_mtime, indexed_at, origin
    )
    SELECT
      id, source_id, source, title, summary, author, project_name, project_path,
      tags_json, slug, created_at, discovered_at, modified_at,
      CASE WHEN state = 'published' THEN 'saved' ELSE state END,
      published_at, published_message_count, publish_version,
      source_path, file_path, source_mtime, indexed_at, origin
    FROM conversations;

    DROP TABLE conversations;
    ALTER TABLE conversations_v4 RENAME TO conversations;
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

function getColumnNames(db: Database, tableName: string): Set<string> {
  const result = db.exec(`PRAGMA table_info(${tableName})`);
  return new Set(result[0]?.values.map((row) => String(row[1])) ?? []);
}

function addColumnIfMissing(
  db: Database,
  tableName: string,
  columnName: string,
  definition: string,
): void {
  const existingColumns = getColumnNames(db, tableName);

  if (existingColumns.has(columnName)) {
    return;
  }

  db.exec(`ALTER TABLE ${tableName} ADD COLUMN ${columnName} ${definition}`);
}
