import type { Database } from "sql.js";

// Baseline collapsed from a 1→10 migration ramp before first release; the ramp
// lives in git history. Future changes add ordinary forward migrations from 10.
export const SCHEMA_BASELINE_VERSION = 10;
export const CURRENT_SCHEMA_VERSION = 10;

export const SCHEMA_RESET_RECOVERY =
  "Archive the complete CLOG_HOME before resetting it. Then either move the old CLOG_HOME aside, or remove only clog.db and vectors/ inside CLOG_HOME while retaining config.json, raw/, and imports/. Run 'clog init', then run a database-using command such as 'clog status' to create the fresh database. Restoring saved summaries, tags, author edits, and other curated metadata requires a database backup or re-saving and re-importing the archived conversations.";

export function ensureCurrentSchema(db: Database): boolean {
  if (!tableExists(db, "schema_version")) {
    if (
      tableExists(db, "conversations") ||
      tableExists(db, "conversation_relationships")
    ) {
      throw new Error(
        `Cannot initialize clog's conversation database because schema_version is missing while clog application tables already exist. ${SCHEMA_RESET_RECOVERY}`,
      );
    }

    createLatestSchema(db);
    setSchemaVersion(db, CURRENT_SCHEMA_VERSION);
    return true;
  }

  const currentVersion = getSchemaVersion(db);

  if (currentVersion === null || !Number.isInteger(currentVersion)) {
    throw new Error(
      `Database schema version "${currentVersion}" is not a valid integer value. This suggests a malformed database state. ${SCHEMA_RESET_RECOVERY}`,
    );
  }

  if (currentVersion < SCHEMA_BASELINE_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is incompatible with this clog build; the oldest schema this build supports is ${SCHEMA_BASELINE_VERSION}. ${SCHEMA_RESET_RECOVERY}`,
    );
  }

  if (currentVersion > CURRENT_SCHEMA_VERSION) {
    throw new Error(
      `Database schema version ${currentVersion} is incompatible with this clog build, which expects version ${CURRENT_SCHEMA_VERSION}; the database is newer than this build. Use a compatible newer clog build, if one is available. Otherwise, back up your old database and create a new one:\n${SCHEMA_RESET_RECOVERY}`,
    );
  }

  // Add future forward migrations here in ascending version order.

  return currentVersion < CURRENT_SCHEMA_VERSION;
}

function createLatestSchema(db: Database): void {
  db.exec(`
    CREATE TABLE schema_version (
      version INTEGER NOT NULL
    );
  `);

  createConversationsTable(db);
  createConversationRelationshipsTable(db);
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
      relationship_status TEXT NOT NULL DEFAULT 'unexamined'
        CHECK(relationship_status IN ('unexamined','none_found','linked','unknown')),
      relationship_inspection_version INTEGER,
      relationship_diagnostic TEXT,
      transcript_projection_version INTEGER,
      CHECK(
        (origin_kind = 'git' AND origin_ref IS NOT NULL)
        OR
        (origin_kind IN ('local','file') AND origin_ref IS NULL)
      ),
      CHECK(
        (
          relationship_status = 'unexamined'
          AND relationship_inspection_version IS NULL
          AND relationship_diagnostic IS NULL
        )
        OR
        (
          relationship_status IN ('none_found','linked')
          AND typeof(relationship_inspection_version) = 'integer'
          AND relationship_inspection_version >= 1
          AND relationship_diagnostic IS NULL
        )
        OR
        (
          relationship_status = 'unknown'
          AND typeof(relationship_inspection_version) = 'integer'
          AND relationship_inspection_version >= 1
          AND relationship_diagnostic IS NOT NULL
          AND typeof(relationship_diagnostic) = 'text'
          AND relationship_diagnostic != ''
        )
      ),
      CHECK(
        transcript_projection_version IS NULL
        OR (
          typeof(transcript_projection_version) = 'integer'
          AND transcript_projection_version >= 1
        )
      ),
      UNIQUE(source, source_id)
    );
  `);
}

function createConversationRelationshipsTable(db: Database): void {
  db.exec(`
    CREATE TABLE IF NOT EXISTS conversation_relationships (
      child_id TEXT NOT NULL
        REFERENCES conversations(id) ON DELETE CASCADE,
      relationship_kind TEXT NOT NULL
        CHECK(relationship_kind = 'branch'),
      parent_source TEXT NOT NULL CHECK(parent_source != ''),
      parent_source_id TEXT NOT NULL CHECK(parent_source_id != ''),
      evidence_kind TEXT NOT NULL
        CHECK(evidence_kind IN ('source','inferred')),
      branch_point_json TEXT
        CHECK(
          branch_point_json IS NULL
          OR (
            json_valid(branch_point_json)
            AND json_extract(branch_point_json, '$.kind')
              IN ('source-turn','source-message')
            AND json_type(branch_point_json, '$.id') = 'text'
            AND json_extract(branch_point_json, '$.id') != ''
          )
        ),
      PRIMARY KEY(child_id, relationship_kind)
    );
  `);
}

function getSchemaVersion(db: Database): number | null {
  const result = db.exec("SELECT version FROM schema_version LIMIT 1");

  if (result.length === 0 || (result[0]?.values.length ?? 0) === 0) {
    return null;
  }

  const value = result[0]?.values[0]?.[0];
  return value == null ? null : Number(value);
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
