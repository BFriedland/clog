import type { Database } from "sql.js";

export const CURRENT_SCHEMA_VERSION = 9;

export function ensureCurrentSchema(db: Database): boolean {
  if (!tableExists(db, "schema_version")) {
    createLatestSchema(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return true;
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

  if (currentVersion < 5) {
    migrateToV5(db);
    setSchemaVersion(db, 5);
  }

  if (currentVersion < 6) {
    migrateToV6(db);
    setSchemaVersion(db, 6);
  }

  if (currentVersion < 7) {
    migrateToV7(db);
    setSchemaVersion(db, 7);
  }

  if (currentVersion < 8) {
    migrateToV8(db);
    setSchemaVersion(db, 8);
  }

  if (currentVersion < 9) {
    migrateToV9(db);
    setSchemaVersion(db, 9);
  }

  return currentVersion < CURRENT_SCHEMA_VERSION;
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
      summary_kind TEXT NOT NULL DEFAULT 'none'
        CHECK(summary_kind IN ('none','imported','generated','curated')),
      summary_extraction TEXT,
      author TEXT NOT NULL,
      project_name TEXT,
      project_path TEXT,
      tags_json TEXT DEFAULT '[]',
      slug TEXT,
      created_at TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      saved_at TEXT NOT NULL,
      saved_message_count INTEGER NOT NULL CHECK(saved_message_count >= 0),
      save_version INTEGER NOT NULL CHECK(save_version >= 1),
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'local'
        CHECK(origin_kind IN ('local','git','file')),
      origin_ref TEXT,
      CHECK(
        (origin_kind = 'git' AND origin_ref IS NOT NULL)
        OR
        (origin_kind IN ('local','file') AND origin_ref IS NULL)
      ),
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

function migrateToV5(db: Database): void {
  // SQLite's ADD COLUMN supports NOT NULL when a non-null DEFAULT is supplied.
  // The column-level CHECK references only the new column.
  addColumnIfMissing(
    db,
    "conversations",
    "summary_kind",
    "TEXT NOT NULL DEFAULT 'none' CHECK(summary_kind IN ('none','imported','generated','curated'))",
  );
  addColumnIfMissing(db, "conversations", "summary_extraction", "TEXT");

  // Existing non-empty summaries become 'curated': conservative, so auto-summary
  // does not overwrite text the user has had a chance to edit.
  db.exec(`
    UPDATE conversations
    SET summary_kind = 'curated'
    WHERE summary_kind = 'none' AND COALESCE(summary, '') != '';
  `);
}

function migrateToV6(db: Database): void {
  if (!tableExists(db, "conversations")) {
    return;
  }

  const stagedCount = countRows(db, "SELECT COUNT(*) FROM conversations WHERE state = 'staged'");
  if (stagedCount > 0) {
    throw new Error(
      "This clog database contains staged conversations from an unsupported older schema. Remove or archive the old CLOG_HOME and run clog init to create a fresh database.",
    );
  }

  db.exec(`
    CREATE TABLE conversations_v6 (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      summary_kind TEXT NOT NULL DEFAULT 'none'
        CHECK(summary_kind IN ('none','imported','generated','curated')),
      summary_extraction TEXT,
      author TEXT NOT NULL,
      project_name TEXT,
      project_path TEXT,
      tags_json TEXT DEFAULT '[]',
      slug TEXT,
      created_at TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'discovered'
        CHECK(state IN ('discovered','saved')),
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

    INSERT INTO conversations_v6 (
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at, state, saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at, origin
    )
    SELECT
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at, state, saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at, origin
    FROM conversations;

    DROP TABLE conversations;
    ALTER TABLE conversations_v6 RENAME TO conversations;
  `);
}

function migrateToV7(db: Database): void {
  if (!tableExists(db, "conversations")) {
    return;
  }

  const existingColumns = getColumnNames(db, "conversations");
  if (existingColumns.has("origin_kind") && existingColumns.has("origin_ref")) {
    return;
  }

  db.exec(`
    CREATE TABLE conversations_v7 (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      summary_kind TEXT NOT NULL DEFAULT 'none'
        CHECK(summary_kind IN ('none','imported','generated','curated')),
      summary_extraction TEXT,
      author TEXT NOT NULL,
      project_name TEXT,
      project_path TEXT,
      tags_json TEXT DEFAULT '[]',
      slug TEXT,
      created_at TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'discovered'
        CHECK(state IN ('discovered','saved')),
      saved_at TEXT,
      saved_message_count INTEGER,
      save_version INTEGER DEFAULT 0,
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'local'
        CHECK(origin_kind IN ('local','git','file')),
      origin_ref TEXT,
      CHECK(
        (origin_kind = 'git' AND origin_ref IS NOT NULL)
        OR
        (origin_kind IN ('local','file') AND origin_ref IS NULL)
      ),
      UNIQUE(source, source_id)
    );

    INSERT INTO conversations_v7 (
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at, state, saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at,
      origin_kind, origin_ref
    )
    SELECT
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at, state, saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at,
      CASE WHEN origin IS NULL THEN 'local' ELSE 'git' END,
      origin
    FROM conversations;

    DROP TABLE conversations;
    ALTER TABLE conversations_v7 RENAME TO conversations;
  `);
}

function migrateToV8(db: Database): void {
  if (!tableExists(db, "conversations")) {
    return;
  }

  // Rename the user-facing state value: the old internal "discovered" becomes
  // "unsaved" so a single vocabulary spans the CLI, MCP, and storage. The CHECK
  // constraint has to change too, which SQLite can only do via table rebuild.
  db.exec(`
    CREATE TABLE conversations_v8 (
      id TEXT PRIMARY KEY,
      source_id TEXT NOT NULL,
      source TEXT NOT NULL,
      title TEXT NOT NULL,
      summary TEXT DEFAULT '',
      summary_kind TEXT NOT NULL DEFAULT 'none'
        CHECK(summary_kind IN ('none','imported','generated','curated')),
      summary_extraction TEXT,
      author TEXT NOT NULL,
      project_name TEXT,
      project_path TEXT,
      tags_json TEXT DEFAULT '[]',
      slug TEXT,
      created_at TEXT NOT NULL,
      discovered_at TEXT NOT NULL,
      modified_at TEXT NOT NULL,
      state TEXT NOT NULL DEFAULT 'unsaved'
        CHECK(state IN ('unsaved','saved')),
      saved_at TEXT,
      saved_message_count INTEGER,
      save_version INTEGER DEFAULT 0,
      source_path TEXT NOT NULL,
      file_path TEXT,
      source_mtime TEXT,
      indexed_at TEXT,
      origin_kind TEXT NOT NULL DEFAULT 'local'
        CHECK(origin_kind IN ('local','git','file')),
      origin_ref TEXT,
      CHECK(
        (origin_kind = 'git' AND origin_ref IS NOT NULL)
        OR
        (origin_kind IN ('local','file') AND origin_ref IS NULL)
      ),
      UNIQUE(source, source_id)
    );

    INSERT INTO conversations_v8 (
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at, state, saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at,
      origin_kind, origin_ref
    )
    SELECT
      id, source_id, source, title, summary, summary_kind, summary_extraction,
      author, project_name, project_path, tags_json, slug, created_at,
      discovered_at, modified_at,
      CASE WHEN state = 'discovered' THEN 'unsaved' ELSE state END,
      saved_at, saved_message_count,
      save_version, source_path, file_path, source_mtime, indexed_at,
      origin_kind, origin_ref
    FROM conversations;

    DROP TABLE conversations;
    ALTER TABLE conversations_v8 RENAME TO conversations;
  `);
}

function migrateToV9(db: Database): void {
  if (!tableExists(db, "conversations")) {
    return;
  }

  const invalidSavedRows = countRows(
    db,
    `
      SELECT COUNT(*)
      FROM conversations
      WHERE state = 'saved'
        AND (
          saved_at IS NULL
          OR saved_message_count IS NULL
          OR typeof(saved_message_count) != 'integer'
          OR saved_message_count < 0
          OR save_version IS NULL
          OR typeof(save_version) != 'integer'
          OR save_version < 1
        )
    `,
  );
  if (invalidSavedRows > 0) {
    throw new Error(
      `Cannot migrate clog's conversation database: ${invalidSavedRows} saved conversation row(s) have invalid save checkpoints. Run 'clog plunge' with the current clog version and repair the saved data before retrying.`,
    );
  }

  db.exec("BEGIN TRANSACTION;");
  try {
    db.exec(`
      CREATE TABLE conversations_v9 (
        id TEXT PRIMARY KEY,
        source_id TEXT NOT NULL,
        source TEXT NOT NULL,
        title TEXT NOT NULL,
        summary TEXT DEFAULT '',
        summary_kind TEXT NOT NULL DEFAULT 'none'
          CHECK(summary_kind IN ('none','imported','generated','curated')),
        summary_extraction TEXT,
        author TEXT NOT NULL,
        project_name TEXT,
        project_path TEXT,
        tags_json TEXT DEFAULT '[]',
        slug TEXT,
        created_at TEXT NOT NULL,
        discovered_at TEXT NOT NULL,
        modified_at TEXT NOT NULL,
        saved_at TEXT NOT NULL,
        saved_message_count INTEGER NOT NULL CHECK(saved_message_count >= 0),
        save_version INTEGER NOT NULL CHECK(save_version >= 1),
        source_path TEXT NOT NULL,
        file_path TEXT,
        source_mtime TEXT,
        indexed_at TEXT,
        origin_kind TEXT NOT NULL DEFAULT 'local'
          CHECK(origin_kind IN ('local','git','file')),
        origin_ref TEXT,
        CHECK(
          (origin_kind = 'git' AND origin_ref IS NOT NULL)
          OR
          (origin_kind IN ('local','file') AND origin_ref IS NULL)
        ),
        UNIQUE(source, source_id)
      );

      INSERT INTO conversations_v9 (
        id, source_id, source, title, summary, summary_kind, summary_extraction,
        author, project_name, project_path, tags_json, slug, created_at,
        discovered_at, modified_at, saved_at, saved_message_count, save_version,
        source_path, file_path, source_mtime, indexed_at, origin_kind, origin_ref
      )
      SELECT
        id, source_id, source, title, summary, summary_kind, summary_extraction,
        author, project_name, project_path, tags_json, slug, created_at,
        discovered_at, modified_at, saved_at, saved_message_count, save_version,
        source_path, file_path, source_mtime, indexed_at, origin_kind, origin_ref
      FROM conversations
      WHERE state = 'saved';

      DROP TABLE conversations;
      ALTER TABLE conversations_v9 RENAME TO conversations;
    `);
    db.exec("COMMIT;");
  } catch (error) {
    db.exec("ROLLBACK;");
    throw error;
  }
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

function countRows(db: Database, sql: string): number {
  const result = db.exec(sql);
  return Number(result[0]?.values[0]?.[0] ?? 0);
}
