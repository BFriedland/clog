import fs from "node:fs/promises";
import path from "node:path";
import { pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";
import initSqlJs, { type Database, type QueryExecResult, type SqlJsStatic } from "sql.js";

import {
  type ConversationMeta,
  conversationMetaSchema,
  type ConversationState,
} from "../models/conversation.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { ClogError } from "../utils/errors.js";
import { getClogDbPath, getDbLockPath } from "../utils/paths.js";
import { applyMigrations } from "./schema.js";

type DbCallback<T> = (db: Database) => Promise<T> | T;

export interface DbAccessOptions {
  applyMigrations?: boolean;
  flush?: boolean;
  requireExistingHome?: boolean;
}

export type OriginFilter = "local" | "remote" | { url: string };

export interface ListConversationFilters {
  states?: ConversationState[];
  projectName?: string;
  author?: string;
  tag?: string;
  indexed?: boolean;
  origin?: OriginFilter;
  curatedDefault?: { author: string } | null;
}

export interface ResolvedConversationId {
  id: string;
  source: string;
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

export async function withDb<T>(
  callback: DbCallback<T>,
  options: DbAccessOptions = {},
): Promise<T> {
  const dbPath = getClogDbPath();
  const lockPath = getDbLockPath();
  const {
    applyMigrations: shouldApplyMigrations = true,
    flush: shouldFlush = true,
    requireExistingHome = false,
  } = options;

  if (requireExistingHome) {
    const clogHome = path.dirname(dbPath);
    try {
      await fs.access(clogHome);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") {
        throw new ClogError(`clog home is missing: ${clogHome}`);
      }

      throw new ClogError(`clog home is inaccessible: ${clogHome}`);
    }
  }

  await fs.mkdir(path.dirname(dbPath), { recursive: true });
  await removeLegacyLockFile(lockPath);

  const release = await lockfile.lock(dbPath, {
    lockfilePath: lockPath,
    stale: 10_000,
    retries: {
      retries: 10,
      minTimeout: 50,
      maxTimeout: 250,
    },
    realpath: false,
  });

  const SQL = await getSqlJs();
  const db = await loadDatabase(SQL, dbPath);

  try {
    if (shouldApplyMigrations) {
      applyMigrations(db);
    }
    const result = await callback(db);
    if (shouldFlush) {
      await flushDatabase(db, dbPath);
    }
    return result;
  } finally {
    db.close();
    await release();
  }
}

export async function insertConversation(
  conversation: ConversationMeta,
): Promise<void> {
  await withDb((db) => insertConversationInDb(db, conversation));
}

export async function updateConversation(
  conversation: ConversationMeta,
): Promise<void> {
  await withDb((db) => updateConversationInDb(db, conversation));
}

export async function getConversationById(
  id: string,
): Promise<ConversationMeta | null> {
  return withDb((db) => {
    const result = db.exec("SELECT * FROM conversations WHERE id = ?", [id]);
    return firstConversation(result);
  });
}

export async function listConversations(
  filters: ListConversationFilters = {},
): Promise<ConversationMeta[]> {
  return withDb((db) => listConversationsInDb(db, filters));
}

export async function browseValues(
  field: "author" | "project_name" | "tags_json",
): Promise<Array<{ name: string; count: number }>> {
  return withDb((db) => {
    if (field === "tags_json") {
      const conversations = resultToConversations(
        db.exec("SELECT * FROM conversations WHERE state = 'saved'"),
      );
      const counts = new Map<string, number>();

      for (const conversation of conversations) {
        for (const tag of conversation.tags) {
          counts.set(tag, (counts.get(tag) ?? 0) + 1);
        }
      }

      return Array.from(counts.entries())
        .map(([name, count]) => ({ name, count }))
        .sort((left, right) => left.name.localeCompare(right.name));
    }

    const result = db.exec(
      `
        SELECT ${field} AS name, COUNT(*) AS count
        FROM conversations
        WHERE state = 'saved' AND ${field} IS NOT NULL AND ${field} != ''
        GROUP BY ${field}
        ORDER BY ${field} ASC
      `,
    );

    if (result.length === 0) {
      return [];
    }

    const rows = rowsFromResult(result[0]);
    return rows.map((row) => ({
      name: String(row.name),
      count: Number(row.count),
    }));
  });
}

export async function resolveConversationId(
  input: string,
): Promise<ResolvedConversationId> {
  const parsed = parseResolvableId(input);

  if (parsed.prefix.length < 4) {
    throw new ClogError("Conversation IDs must use at least 4 characters.");
  }

  return withDb((db) => {
    const filters = ["id LIKE ?"];
    const params: unknown[] = [`${parsed.prefix}%`];

    if (parsed.source) {
      filters.push("source = ?");
      params.push(parsed.source);
    }

    const result = db.exec(
      `
        SELECT id, source
        FROM conversations
        WHERE ${filters.join(" AND ")}
        ORDER BY source ASC, id ASC
      `,
      params,
    );

    const rows = result.length === 0 ? [] : rowsFromResult(result[0]);

    if (rows.length === 0) {
      throw new ClogError(`No conversation matches "${input}".`);
    }

    if (rows.length > 1) {
      throw new ClogError(buildAmbiguousIdMessage(input, rows));
    }

    return {
      id: String(rows[0].id),
      source: String(rows[0].source),
    };
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await withDb((db) => deleteConversationInDb(db, id));
}

export function insertConversationInDb(
  db: Database,
  conversation: ConversationMeta,
): void {
  db.run(
    `
      INSERT INTO conversations (
        id,
        source_id,
        source,
        title,
        summary,
        author,
        project_name,
        project_path,
        tags_json,
        slug,
        created_at,
        discovered_at,
        modified_at,
        state,
        saved_at,
        saved_message_count,
        save_version,
        source_path,
        file_path,
        source_mtime,
        indexed_at,
        origin
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `,
    conversationToParams(conversation),
  );
}

export function updateConversationInDb(
  db: Database,
  conversation: ConversationMeta,
): void {
  db.run(
    `
      UPDATE conversations
      SET
        source_id = ?,
        source = ?,
        title = ?,
        summary = ?,
        author = ?,
        project_name = ?,
        project_path = ?,
        tags_json = ?,
        slug = ?,
        created_at = ?,
        discovered_at = ?,
        modified_at = ?,
        state = ?,
        saved_at = ?,
        saved_message_count = ?,
        save_version = ?,
        source_path = ?,
        file_path = ?,
        source_mtime = ?,
        indexed_at = ?,
        origin = ?
      WHERE id = ?
    `,
    [
      conversation.sourceId,
      conversation.source,
      conversation.title,
      conversation.summary,
      conversation.author,
      conversation.projectName,
      conversation.projectPath,
      JSON.stringify(conversation.tags),
      conversation.slug,
      conversation.createdAt,
      conversation.discoveredAt,
      conversation.modifiedAt,
      conversation.state,
      conversation.savedAt,
      conversation.savedMessageCount,
      conversation.saveVersion,
      conversation.sourcePath,
      conversation.filePath,
      conversation.sourceMtime,
      conversation.indexedAt,
      conversation.origin,
      conversation.id,
    ],
  );
}

export function deleteConversationInDb(db: Database, id: string): void {
  db.run("DELETE FROM conversations WHERE id = ?", [id]);
}

export function listConversationsInDb(
  db: Database,
  filters: ListConversationFilters = {},
): ConversationMeta[] {
  const whereParts: string[] = [];
  const params: unknown[] = [];

  if (filters.states && filters.states.length > 0) {
    whereParts.push(`state IN (${filters.states.map(() => "?").join(", ")})`);
    params.push(...filters.states);
  }

  if (filters.projectName) {
    whereParts.push("LOWER(COALESCE(project_name, '')) = LOWER(?)");
    params.push(filters.projectName);
  }

  if (filters.author) {
    whereParts.push("author = ?");
    params.push(filters.author);
  }

  if (filters.indexed != null) {
    whereParts.push(filters.indexed ? "indexed_at IS NOT NULL" : "indexed_at IS NULL");
  }

  if (filters.origin === "local") {
    whereParts.push("origin IS NULL");
  } else if (filters.origin === "remote") {
    whereParts.push("origin IS NOT NULL");
  } else if (filters.origin && typeof filters.origin === "object") {
    whereParts.push("origin = ?");
    params.push(filters.origin.url);
  }

  if (filters.curatedDefault) {
    whereParts.push("(author = ? OR origin IS NULL)");
    params.push(filters.curatedDefault.author);
  }

  const whereClause = whereParts.length > 0 ? `WHERE ${whereParts.join(" AND ")}` : "";

  const result = db.exec(
    `
      SELECT *
      FROM conversations
      ${whereClause}
      ORDER BY datetime(created_at) DESC, id ASC
    `,
    params,
  );

  let conversations = resultToConversations(result);

  if (filters.tag) {
    const normalizedTag = filters.tag.trim().toLowerCase();
    conversations = conversations.filter((conversation) =>
      conversation.tags.some((tag) => tag.trim().toLowerCase() === normalizedTag),
    );
  }

  return conversations;
}

export function getConversationBySourceIdentityInDb(
  db: Database,
  source: string,
  sourceId: string,
): ConversationMeta | null {
  const result = db.exec(
    "SELECT * FROM conversations WHERE source = ? AND source_id = ? LIMIT 1",
    [source, sourceId],
  );
  return firstConversation(result);
}

export async function listConversationsNeedingIndex(): Promise<ConversationMeta[]> {
  return withDb((db) =>
    listConversationsInDb(db, {
      states: ["saved"],
      indexed: false,
    }),
  );
}

export async function setConversationIndexedAt(
  id: string,
  indexedAt: string | null,
): Promise<void> {
  await withDb((db) => {
    db.run("UPDATE conversations SET indexed_at = ? WHERE id = ?", [indexedAt, id]);
  });
}

export async function clearSavedIndexedAt(): Promise<void> {
  await withDb((db) => {
    db.run("UPDATE conversations SET indexed_at = NULL WHERE state = 'saved'");
  });
}

function parseResolvableId(input: string): { prefix: string; source: string | null } {
  const atIndex = input.lastIndexOf("@");

  if (atIndex === -1) {
    return { prefix: input, source: null };
  }

  const prefix = input.slice(0, atIndex);
  const source = input.slice(atIndex + 1);

  if (!prefix || !source) {
    throw new ClogError(`Invalid source-qualified ID "${input}".`);
  }

  return { prefix, source };
}

function buildAmbiguousIdMessage(
  input: string,
  rows: Array<Record<string, unknown>>,
): string {
  const candidates = rows
    .map((row) => `${String(row.id)}@${String(row.source)}`)
    .join(", ");

  return `Conversation ID "${input}" is ambiguous. Matches: ${candidates}`;
}

function conversationToParams(conversation: ConversationMeta): unknown[] {
  return [
    conversation.id,
    conversation.sourceId,
    conversation.source,
    conversation.title,
    conversation.summary,
    conversation.author,
    conversation.projectName,
    conversation.projectPath,
    JSON.stringify(conversation.tags),
    conversation.slug,
    conversation.createdAt,
    conversation.discoveredAt,
    conversation.modifiedAt,
    conversation.state,
    conversation.savedAt,
    conversation.savedMessageCount,
    conversation.saveVersion,
    conversation.sourcePath,
    conversation.filePath,
    conversation.sourceMtime,
    conversation.indexedAt,
    conversation.origin,
  ];
}

function firstConversation(
  result: QueryExecResult[],
): ConversationMeta | null {
  const conversations = resultToConversations(result);
  return conversations[0] ?? null;
}

function resultToConversations(result: QueryExecResult[]): ConversationMeta[] {
  if (result.length === 0) {
    return [];
  }

  return rowsFromResult(result[0]).map(rowToConversation);
}

function rowsFromResult(result?: QueryExecResult): Array<Record<string, unknown>> {
  if (!result) {
    return [];
  }

  return result.values.map((values: unknown[]) =>
    Object.fromEntries(
      result.columns.map((column: string, index: number) => [column, values[index]]),
    ),
  );
}

function rowToConversation(row: Record<string, unknown>): ConversationMeta {
  return conversationMetaSchema.parse({
    id: String(row.id),
    sourceId: String(row.source_id),
    source: String(row.source),
    title: String(row.title),
    summary: String(row.summary ?? ""),
    author: String(row.author),
    projectName: nullableString(row.project_name),
    projectPath: nullableString(row.project_path),
    tags: parseTags(row.tags_json),
    slug: nullableString(row.slug),
    createdAt: String(row.created_at),
    discoveredAt: String(row.discovered_at),
    modifiedAt: String(row.modified_at),
    state: String(row.state) as ConversationState,
    savedAt: nullableString(row.saved_at),
    savedMessageCount: nullableInteger(row.saved_message_count),
    saveVersion: Number(row.save_version),
    sourcePath: String(row.source_path),
    filePath: nullableString(row.file_path),
    sourceMtime: nullableString(row.source_mtime),
    indexedAt: nullableString(row.indexed_at),
    origin: nullableString(row.origin),
  });
}

function parseTags(value: unknown): string[] {
  if (typeof value !== "string") {
    return [];
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed)
      ? parsed.filter((entry): entry is string => typeof entry === "string")
      : [];
  } catch {
    return [];
  }
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function nullableInteger(value: unknown): number | null {
  return value == null ? null : Number(value);
}

async function getSqlJs(): Promise<SqlJsStatic> {
  if (!sqlJsPromise) {
    const sqlJsDir = path.resolve("node_modules/sql.js/dist");
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) => pathToFileURL(path.join(sqlJsDir, file)).href,
    });
  }

  return sqlJsPromise;
}

async function loadDatabase(SQL: SqlJsStatic, dbPath: string): Promise<Database> {
  try {
    const buffer = await fs.readFile(dbPath);
    return new SQL.Database(buffer);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return new SQL.Database();
    }

    throw error;
  }
}

async function flushDatabase(db: Database, dbPath: string): Promise<void> {
  const data = db.export();
  await writeFileAtomic(dbPath, Buffer.from(data));
}

async function removeLegacyLockFile(lockPath: string): Promise<void> {
  try {
    const stat = await fs.lstat(lockPath);
    if (stat.isDirectory()) {
      return;
    }

    // Older clog builds created this path as a plain file; proper-lockfile
    // needs to manage it as a directory lock.
    await fs.unlink(lockPath);
  } catch (error) {
    if (
      error instanceof Error &&
      (error as NodeJS.ErrnoException).path === lockPath &&
      ((error as NodeJS.ErrnoException).code === "EPERM" ||
        (error as NodeJS.ErrnoException).code === "EACCES")
    ) {
      throw new ClogError(
        `Cannot replace legacy DB lock file at ${lockPath}. Fix its permissions or remove it manually.`,
      );
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }

    throw error;
  }
}
