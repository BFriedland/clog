import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import lockfile from "proper-lockfile";
import initSqlJs, { type Database, type QueryExecResult, type SqlJsStatic } from "sql.js";

import {
  type LocalConversation,
  requireLocalConversation,
  throwImportedReadOnlyError,
} from "../conversations/write-guards.js";
import {
  type ConversationMeta,
  type OriginKind,
  type SavedConversationMeta,
  savedConversationMetaSchema,
  type UnsavedConversationView,
  parseSummaryExtraction,
} from "../models/conversation.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { ClogError } from "../utils/errors.js";
import { getClogDbPath, getDbLockPath } from "../utils/paths.js";
import { parseSourceQualifiedId } from "../utils/source-keys.js";
import { ensureCurrentSchema } from "./schema.js";
import {
  unsafeInsertConversationInDb,
  unsafeUpdateLocalConversationInDb,
} from "./unsafe-conversations.js";

type DbCallback<T> = (db: Database) => Promise<T> | T;
const require = createRequire(import.meta.url);

export type DbAccessOptions =
  | {
      mode: "read";
      requireExistingHome?: boolean;
    }
  | {
      mode: "write";
      requireExistingHome?: boolean;
    }
  | {
      mode: "diagnostic";
      requireExistingHome?: boolean;
    };

export type OriginFilter =
  | "local"
  | "remote"
  | { kind: OriginKind; ref?: string | null };

export interface ListConversationFilters {
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

export type ConversationRemovalFileEffect = "raw" | "import" | "none";

export interface RemovedConversationCopy {
  id: string;
  source: string;
  fileEffect: ConversationRemovalFileEffect;
}

interface SqlWhere {
  sql: string;
  params: unknown[];
}

let sqlJsPromise: Promise<SqlJsStatic> | null = null;

export async function withDb<T>(
  callback: DbCallback<T>,
  options: DbAccessOptions,
): Promise<T> {
  const dbPath = getClogDbPath();
  const lockPath = getDbLockPath();
  const requireExistingHome = options.requireExistingHome ?? false;
  const shouldEnsureSchema = options.mode !== "diagnostic";

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

  let db: Database | null = null;

  try {
    const SQL = await getSqlJs();
    db = await loadDatabase(SQL, dbPath);
    const schemaChanged = shouldEnsureSchema
      ? ensureCurrentSchema(db)
      : false;
    if (options.mode === "read") {
      db.exec("PRAGMA query_only = ON");
    }
    const result = await callback(db);
    if (options.mode === "write" || schemaChanged) {
      await flushDatabase(db, dbPath);
    }
    return result;
  } finally {
    try {
      db?.close();
    } finally {
      await release();
    }
  }
}

export async function getConversationById(
  id: string,
): Promise<SavedConversationMeta | null> {
  return withDb((db) => getConversationByIdInDb(db, id), { mode: "read" });
}

export function getConversationByIdInDb(
  db: Database,
  id: string,
): SavedConversationMeta | null {
  const result = db.exec("SELECT * FROM conversations WHERE id = ?", [id]);
  return firstConversation(result);
}

export async function listConversations(
  filters: ListConversationFilters = {},
): Promise<SavedConversationMeta[]> {
  return withDb((db) => listConversationsInDb(db, filters), { mode: "read" });
}

export async function browseValues(
  field: "author" | "project_name" | "tags_json",
): Promise<Array<{ name: string; count: number }>> {
  return withDb((db) => {
    if (field === "tags_json") {
      const conversations = resultToConversations(
        db.exec("SELECT * FROM conversations"),
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
        WHERE ${field} IS NOT NULL AND ${field} != ''
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
  }, { mode: "read" });
}

export async function resolveConversationId(
  input: string,
): Promise<ResolvedConversationId> {
  const parsed = parseSourceQualifiedId(input);
  if (!parsed.ok) {
    throw new ClogError(`Invalid source-qualified ID "${input}".`);
  }

  if (parsed.value.prefix.length < 4) {
    throw new ClogError("Conversation IDs must use at least 4 characters.");
  }

  return withDb((db) => {
    const filters = ["id LIKE ?"];
    const params: unknown[] = [`${parsed.value.prefix}%`];

    if (parsed.value.source) {
      filters.push("source = ?");
      params.push(parsed.value.source);
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
  }, { mode: "read" });
}

export function isLocalConversation(
  conversation: Pick<ConversationMeta, "originKind">,
): boolean {
  return conversation.originKind === "local";
}

export function isNonLocalConversation(
  conversation: Pick<ConversationMeta, "originKind">,
): boolean {
  return conversation.originKind !== "local";
}

export function isGitConversation(
  conversation: Pick<ConversationMeta, "originKind">,
): boolean {
  return conversation.originKind === "git";
}

export function isFileConversation(
  conversation: Pick<ConversationMeta, "originKind">,
): boolean {
  return conversation.originKind === "file";
}

export function isGitConversationForRemote(
  conversation: Pick<ConversationMeta, "originKind" | "originRef">,
  remoteUrl: string,
): boolean {
  return conversation.originKind === "git" && conversation.originRef === remoteUrl;
}

export function gitOriginFilter(remoteUrl: string): OriginFilter {
  return { kind: "git", ref: remoteUrl };
}

export async function updateLocalConversation(
  conversation: SavedConversationMeta,
  options: { command: string },
): Promise<LocalConversation<SavedConversationMeta>> {
  return withDb((db) => updateLocalConversationInDb(db, conversation, options), {
    mode: "write",
  });
}

export async function saveLocalConversation(
  conversation: SavedConversationMeta,
  options: { command: string },
): Promise<LocalConversation<SavedConversationMeta>> {
  return updateLocalConversation(conversation, options);
}

export function updateLocalConversationInDb(
  db: Database,
  conversation: SavedConversationMeta,
  options: { command: string },
): LocalConversation<SavedConversationMeta> {
  const requested = requireLocalConversation(conversation, options.command);
  const current = getConversationByIdInDb(db, conversation.id);
  if (!current) {
    throw new ClogError(`Conversation "${conversation.id}" not found.`);
  }
  requireLocalConversation(current, options.command);

  const modified = unsafeUpdateLocalConversationInDb(db, requested);
  if (modified !== 1) {
    throwImportedReadOnlyError(requested, options.command);
  }

  const updated = getConversationByIdInDb(db, conversation.id);
  if (!updated) {
    throw new ClogError(`Conversation "${conversation.id}" not found after update.`);
  }

  return requireLocalConversation(updated, options.command);
}

export async function insertFirstSavedConversation(
  unsaved: UnsavedConversationView,
  prepareSavedConversation: () => Promise<SavedConversationMeta>,
): Promise<LocalConversation<SavedConversationMeta>> {
  return withDb(async (db) => {
    const owner = getConversationBySourceIdentityInDb(
      db,
      unsaved.source,
      unsaved.sourceId,
    );
    if (owner) {
      throwFirstSaveIdentityCollision(unsaved, owner);
    }

    const saved = savedConversationMetaSchema.parse(
      await prepareSavedConversation(),
    );
    if (saved.source !== unsaved.source || saved.sourceId !== unsaved.sourceId) {
      throw new ClogError("First save changed the conversation's source identity.");
    }

    try {
      unsafeInsertConversationInDb(db, saved);
    } catch (error) {
      const racedOwner = getConversationBySourceIdentityInDb(
        db,
        unsaved.source,
        unsaved.sourceId,
      );
      if (racedOwner) {
        throwFirstSaveIdentityCollision(unsaved, racedOwner);
      }
      throw error;
    }

    return requireLocalConversation(saved, "clog save");
  }, { mode: "write" });
}

function throwFirstSaveIdentityCollision(
  unsaved: UnsavedConversationView,
  owner: SavedConversationMeta,
): never {
  const shortId = unsaved.id.slice(0, 8);
  if (owner.originKind === "local") {
    throw new ClogError(
      `Conversation ${shortId} was saved by another clog process. No additional change was made. Run 'clog save ${shortId}' again to refresh the saved conversation.`,
    );
  }

  throw new ClogError(
    `Conversation ${shortId} was imported by another clog process before it could be saved. Inspect the saved copy with 'clog show ${shortId}'. If the local source conversation is the copy you want, run 'clog remove ${shortId}' and retry the save.`,
  );
}

export async function renameLocalAuthor(
  oldName: string,
  newName: string,
  options: { modifiedAt: string },
): Promise<number> {
  return withDb((db) => {
    db.run(
      `
        UPDATE conversations
        SET author = ?, modified_at = ?
        WHERE author = ?
          AND origin_kind = 'local'
          AND origin_ref IS NULL
      `,
      [newName, options.modifiedAt, oldName],
    );
    return db.getRowsModified();
  }, { mode: "write" });
}

export async function removeConversationCopy(
  conversation: ConversationMeta,
  options: { command: string },
): Promise<RemovedConversationCopy> {
  const [removed] = await removeConversationCopies([conversation], options);
  return removed!;
}

export async function removeConversationCopies(
  conversations: ConversationMeta[],
  options: { command: string },
): Promise<RemovedConversationCopy[]> {
  return withDb((db) => removeConversationCopiesInDb(db, conversations, options), {
    mode: "write",
  });
}

export function removeConversationCopiesInDb(
  db: Database,
  conversations: ConversationMeta[],
  options: { command: string },
): RemovedConversationCopy[] {
  const currentRows: ConversationMeta[] = [];
  const seenIds = new Set<string>();

  for (const conversation of conversations) {
    if (seenIds.has(conversation.id)) {
      continue;
    }
    seenIds.add(conversation.id);

    const current = getConversationByIdInDb(db, conversation.id);
    if (!current || !sameRemovalTarget(conversation, current)) {
      throw new ClogError(
        `${options.command} cannot remove conversation ${conversation.id.slice(0, 8)} because it changed after preview. Run '${options.command}' again to review the current row.`,
      );
    }
    currentRows.push(current);
  }

  return currentRows.map((conversation) =>
    removeValidatedConversationCopyInDb(db, conversation, options),
  );
}

function removeValidatedConversationCopyInDb(
  db: Database,
  conversation: ConversationMeta,
  options: { command: string },
): RemovedConversationCopy {
  if (conversation.originKind === "local") {
    db.run(
      `
        DELETE FROM conversations
        WHERE id = ?
          AND origin_kind = 'local'
          AND origin_ref IS NULL
      `,
      [conversation.id],
    );
    return removedConversationCopy(db, conversation, "raw");
  } else if (conversation.originKind === "file") {
    db.run(
      `
        DELETE FROM conversations
        WHERE id = ?
          AND origin_kind = 'file'
          AND origin_ref IS NULL
      `,
      [conversation.id],
    );
    return removedConversationCopy(db, conversation, "import");
  } else {
    if (conversation.originRef == null) {
      throw new ClogError(
        `${options.command} cannot remove conversation ${conversation.id.slice(0, 8)} because its git remote is missing.`,
      );
    }
    db.run(
      `
        DELETE FROM conversations
        WHERE id = ?
          AND origin_kind = 'git'
          AND origin_ref = ?
      `,
      [conversation.id, conversation.originRef],
    );
    return removedConversationCopy(db, conversation, "none");
  }
}

function removedConversationCopy(
  db: Database,
  conversation: ConversationMeta,
  fileEffect: ConversationRemovalFileEffect,
): RemovedConversationCopy {
  const removedCount = db.getRowsModified();
  if (removedCount !== 1) {
    throw new ClogError(
      `Conversation ${conversation.id.slice(0, 8)} changed before it could be removed. Run the command again to review the current row.`,
    );
  }

  return {
    id: conversation.id,
    source: conversation.source,
    fileEffect,
  };
}

function sameRemovalTarget(
  previewed: ConversationMeta,
  current: ConversationMeta,
): boolean {
  return Object.keys(removalTargetFields).every((field) => {
    const key = field as keyof ConversationMeta;
    return JSON.stringify(previewed[key]) === JSON.stringify(current[key]);
  });
}

const removalTargetFields = {
  id: true,
  sourceId: true,
  source: true,
  title: true,
  summary: true,
  summaryKind: true,
  summaryExtraction: true,
  author: true,
  projectName: true,
  projectPath: true,
  tags: true,
  slug: true,
  createdAt: true,
  discoveredAt: true,
  modifiedAt: true,
  state: true,
  savedAt: true,
  savedMessageCount: true,
  saveVersion: true,
  sourcePath: true,
  filePath: true,
  sourceMtime: true,
  indexedAt: true,
  originKind: true,
  originRef: true,
} satisfies Record<keyof ConversationMeta, true>;

export function removeGitConversationsForRemoteInDb(
  db: Database,
  remoteUrl: string,
): number {
  db.run(
    `
      DELETE FROM conversations
      WHERE origin_kind = 'git'
        AND origin_ref = ?
    `,
    [remoteUrl],
  );
  return db.getRowsModified();
}

export function listConversationsInDb(
  db: Database,
  filters: ListConversationFilters = {},
): SavedConversationMeta[] {
  const whereParts: string[] = [];
  const params: unknown[] = [];

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

  if (filters.origin) {
    const where = provenanceWhere(filters.origin);
    whereParts.push(where.sql);
    params.push(...where.params);
  }

  if (filters.curatedDefault) {
    whereParts.push("(origin_kind = 'local' OR (origin_kind != 'local' AND author = ?))");
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
): SavedConversationMeta | null {
  const result = db.exec(
    "SELECT * FROM conversations WHERE source = ? AND source_id = ? LIMIT 1",
    [source, sourceId],
  );
  return firstConversation(result);
}

export async function listConversationsNeedingIndex(): Promise<ConversationMeta[]> {
  return withDb((db) => {
    const result = db.exec(
      `
        SELECT *
        FROM conversations
        WHERE (
            indexed_at IS NULL
            OR saved_at IS NULL
            OR indexed_at < saved_at
          )
        ORDER BY datetime(created_at) DESC, id ASC
      `,
    );

    return resultToConversations(result);
  }, { mode: "read" });
}

export async function setConversationIndexedAt(
  id: string,
  indexedAt: string | null,
): Promise<void> {
  await withDb((db) => {
    db.run("UPDATE conversations SET indexed_at = ? WHERE id = ?", [indexedAt, id]);
  }, { mode: "write" });
}

export async function clearSavedIndexedAt(): Promise<void> {
  await withDb((db) => {
    db.run("UPDATE conversations SET indexed_at = NULL");
  }, { mode: "write" });
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

function provenanceWhere(filter: OriginFilter): SqlWhere {
  if (filter === "local") {
    return { sql: "origin_kind = 'local'", params: [] };
  }

  if (filter === "remote") {
    return { sql: "origin_kind != 'local'", params: [] };
  }

  const params: unknown[] = [filter.kind];
  let sql = "origin_kind = ?";
  if (filter.ref !== undefined) {
    if (filter.ref == null) {
      sql += " AND origin_ref IS NULL";
    } else {
      sql += " AND origin_ref = ?";
      params.push(filter.ref);
    }
  }
  return { sql, params };
}

function normalizeSummaryKindFromRow(
  raw: unknown,
  summary: string,
): ConversationMeta["summaryKind"] {
  const value = typeof raw === "string" ? raw : null;
  if (
    value === "none" ||
    value === "imported" ||
    value === "generated" ||
    value === "curated"
  ) {
    return value;
  }
  return summary.trim() ? "curated" : "none";
}

function firstConversation(
  result: QueryExecResult[],
): SavedConversationMeta | null {
  const conversations = resultToConversations(result);
  return conversations[0] ?? null;
}

function resultToConversations(result: QueryExecResult[]): SavedConversationMeta[] {
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

function rowToConversation(row: Record<string, unknown>): SavedConversationMeta {
  const summaryText = String(row.summary ?? "");
  return savedConversationMetaSchema.parse({
    id: String(row.id),
    sourceId: String(row.source_id),
    source: String(row.source),
    title: String(row.title),
    summary: summaryText,
    summaryKind: normalizeSummaryKindFromRow(row.summary_kind, summaryText),
    summaryExtraction: parseSummaryExtraction(row.summary_extraction),
    author: String(row.author),
    projectName: nullableString(row.project_name),
    projectPath: nullableString(row.project_path),
    tags: parseTags(row.tags_json),
    slug: nullableString(row.slug),
    createdAt: String(row.created_at),
    discoveredAt: String(row.discovered_at),
    modifiedAt: String(row.modified_at),
    state: "saved",
    savedAt: nullableString(row.saved_at),
    savedMessageCount: nullableInteger(row.saved_message_count),
    saveVersion: Number(row.save_version),
    sourcePath: String(row.source_path),
    filePath: nullableString(row.file_path),
    sourceMtime: nullableString(row.source_mtime),
    indexedAt: nullableString(row.indexed_at),
    originKind: parseOriginKind(row.origin_kind),
    originRef: nullableString(row.origin_ref),
  });
}

function parseOriginKind(value: unknown): OriginKind {
  if (value === "local" || value === "git" || value === "file") {
    return value;
  }
  return "local";
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
    sqlJsPromise = initSqlJs({
      locateFile: (file: string) =>
        pathToFileURL(require.resolve(`sql.js/dist/${file}`)).href,
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
