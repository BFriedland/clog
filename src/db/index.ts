import initSqlJs, { type Database } from "sql.js";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import lockfile from "proper-lockfile";
import { getDbPath, getClogHome } from "../config/index.js";
import { createTables, migrate } from "./schema.js";
import type {
  ConversationMeta,
  ConversationState,
} from "../models/conversation.js";

let sqlPromise: ReturnType<typeof initSqlJs> | null = null;

function getSql() {
  if (!sqlPromise) {
    sqlPromise = initSqlJs();
  }
  return sqlPromise;
}

async function loadDb(): Promise<Database> {
  const SQL = await getSql();
  const dbPath = getDbPath();
  try {
    const buffer = await readFile(dbPath);
    return new SQL.Database(buffer);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      const db = new SQL.Database();
      createTables(db);
      return db;
    }
    throw err;
  }
}

async function flushDb(db: Database): Promise<void> {
  const dbPath = getDbPath();
  await mkdir(path.dirname(dbPath), { recursive: true });
  const data = db.export();
  await writeFile(dbPath, Buffer.from(data));
}

export async function withDb<T>(fn: (ctx: DbContext) => T | Promise<T>): Promise<T> {
  const clogHome = getClogHome();
  await mkdir(clogHome, { recursive: true });

  // Use the clog home dir as the lockfile target
  let release: (() => Promise<void>) | undefined;
  try {
    release = await lockfile.lock(clogHome, {
      lockfilePath: path.join(clogHome, "clog.db.lock"),
      retries: { retries: 5, minTimeout: 100, maxTimeout: 1000 },
    });
  } catch {
    // If locking fails, proceed without lock (single-process fallback)
  }

  try {
    const db = await loadDb();
    migrate(db);
    const ctx = new DbContext(db);
    const result = await fn(ctx);
    await flushDb(db);
    db.close();
    return result;
  } finally {
    if (release) {
      await release();
    }
  }
}

export class DbContext {
  constructor(private db: Database) {}

  insertConversation(conv: ConversationMeta): void {
    this.db.run(
      `INSERT OR IGNORE INTO conversations
        (id, source_id, source, title, summary, author, project, tags_json, slug,
         created_at, discovered_at, modified_at, state, published_at, publish_version,
         source_path, file_path, source_mtime, indexed_at, origin)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        conv.id,
        conv.sourceId,
        conv.source,
        conv.title,
        conv.summary,
        conv.author,
        conv.project,
        JSON.stringify(conv.tags),
        conv.slug,
        conv.createdAt,
        conv.discoveredAt,
        conv.modifiedAt,
        conv.state,
        conv.publishedAt,
        conv.publishVersion,
        conv.sourcePath,
        conv.filePath,
        conv.sourceMtime,
        conv.indexedAt,
        conv.origin ?? null,
      ]
    );
  }

  updateConversation(
    id: string,
    updates: Partial<
      Pick<
        ConversationMeta,
        | "title"
        | "summary"
        | "tags"
        | "state"
        | "publishedAt"
        | "publishVersion"
        | "filePath"
        | "sourceMtime"
        | "modifiedAt"
        | "slug"
        | "author"
        | "indexedAt"
        | "origin"
        | "project"
        | "source"
        | "sourcePath"
      >
    >
  ): void {
    let shouldInvalidateIndex = false;
    const touchesIndexedContent =
      updates.title !== undefined ||
      updates.summary !== undefined ||
      updates.tags !== undefined ||
      updates.sourcePath !== undefined ||
      updates.sourceMtime !== undefined ||
      updates.filePath !== undefined;
    const touchesIndexEligibility = updates.state !== undefined;

    if (updates.indexedAt === undefined && (touchesIndexedContent || touchesIndexEligibility)) {
      const stmt = this.db.prepare(
        `SELECT state, indexed_at, title, summary, tags_json, source_path, source_mtime, file_path
         FROM conversations
         WHERE id = ?`,
        [id],
      );
      if (stmt.step()) {
        const row = stmt.getAsObject() as {
          state?: ConversationState;
          indexed_at?: string | null;
          title?: string;
          summary?: string;
          tags_json?: string;
          source_path?: string;
          source_mtime?: string | null;
          file_path?: string | null;
        };
        const existingTags = JSON.parse((row.tags_json as string) || "[]") as string[];
        shouldInvalidateIndex =
          row.state === "published" &&
          Boolean(row.indexed_at) &&
          (
            (updates.title !== undefined && updates.title !== row.title) ||
            (updates.summary !== undefined && updates.summary !== row.summary) ||
            (updates.tags !== undefined &&
              JSON.stringify(updates.tags) !== JSON.stringify(existingTags)) ||
            (updates.sourcePath !== undefined && updates.sourcePath !== row.source_path) ||
            (updates.sourceMtime !== undefined &&
              updates.sourceMtime !== row.source_mtime) ||
            (updates.filePath !== undefined && updates.filePath !== row.file_path) ||
            (updates.state !== undefined && updates.state !== row.state)
          );
      }
      stmt.free();
    }

    const sets: string[] = [];
    const values: unknown[] = [];

    if (updates.title !== undefined) {
      sets.push("title = ?");
      values.push(updates.title);
    }
    if (updates.summary !== undefined) {
      sets.push("summary = ?");
      values.push(updates.summary);
    }
    if (updates.tags !== undefined) {
      sets.push("tags_json = ?");
      values.push(JSON.stringify(updates.tags));
    }
    if (updates.state !== undefined) {
      sets.push("state = ?");
      values.push(updates.state);
    }
    if (updates.publishedAt !== undefined) {
      sets.push("published_at = ?");
      values.push(updates.publishedAt);
    }
    if (updates.publishVersion !== undefined) {
      sets.push("publish_version = ?");
      values.push(updates.publishVersion);
    }
    if (updates.filePath !== undefined) {
      sets.push("file_path = ?");
      values.push(updates.filePath);
    }
    if (updates.sourceMtime !== undefined) {
      sets.push("source_mtime = ?");
      values.push(updates.sourceMtime);
    }
    if (updates.modifiedAt !== undefined) {
      sets.push("modified_at = ?");
      values.push(updates.modifiedAt);
    }
    if (updates.slug !== undefined) {
      sets.push("slug = ?");
      values.push(updates.slug);
    }
    if (updates.author !== undefined) {
      sets.push("author = ?");
      values.push(updates.author);
    }
    if (updates.indexedAt !== undefined) {
      sets.push("indexed_at = ?");
      values.push(updates.indexedAt);
    } else if (shouldInvalidateIndex) {
      sets.push("indexed_at = ?");
      values.push(null);
    }
    if (updates.origin !== undefined) {
      sets.push("origin = ?");
      values.push(updates.origin);
    }
    if (updates.project !== undefined) {
      sets.push("project = ?");
      values.push(updates.project);
    }
    if (updates.source !== undefined) {
      sets.push("source = ?");
      values.push(updates.source);
    }
    if (updates.sourcePath !== undefined) {
      sets.push("source_path = ?");
      values.push(updates.sourcePath);
    }

    if (sets.length === 0) return;
    values.push(id);
    this.db.run(
      `UPDATE conversations SET ${sets.join(", ")} WHERE id = ?`,
      values
    );
  }

  getConversation(id: string): ConversationMeta | null {
    const stmt = this.db.prepare(
      "SELECT * FROM conversations WHERE id = ?",
      [id]
    );
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToConversation(row);
  }

  getConversationBySourceId(
    source: string,
    sourceId: string
  ): ConversationMeta | null {
    const stmt = this.db.prepare(
      "SELECT * FROM conversations WHERE source = ? AND source_id = ?",
      [source, sourceId]
    );
    if (!stmt.step()) {
      stmt.free();
      return null;
    }
    const row = stmt.getAsObject();
    stmt.free();
    return this.rowToConversation(row);
  }

  resolveId(prefix: string): string {
    if (prefix.length < 4) {
      throw new Error(
        `ID prefix too short: "${prefix}" (minimum 4 characters). Run \`clog list --all\` to see available IDs.`
      );
    }

    const stmt = this.db.prepare(
      "SELECT id FROM conversations WHERE id LIKE ?",
      [prefix + "%"]
    );

    const matches: string[] = [];
    while (stmt.step()) {
      const row = stmt.getAsObject();
      matches.push(row.id as string);
    }
    stmt.free();

    if (matches.length === 0) {
      throw new Error(`No conversation found matching "${prefix}". Run \`clog list --all\` to see available IDs.`);
    }
    if (matches.length > 1) {
      const display = matches
        .slice(0, 5)
        .map((m) => `  ${m.slice(0, 7)}`)
        .join("\n");
      throw new Error(
        `Ambiguous prefix "${prefix}" matches ${matches.length} conversations:\n${display}\nProvide more characters to disambiguate.`
      );
    }
    return matches[0];
  }

  listConversations(filters?: {
    state?: ConversationState;
    project?: string;
    author?: string;
    tag?: string;
    grep?: string;
    origin?: "local" | "remote";
  }): ConversationMeta[] {
    const conditions: string[] = [];
    const values: unknown[] = [];

    if (filters?.state) {
      conditions.push("state = ?");
      values.push(filters.state);
    }
    if (filters?.project) {
      // Case-insensitive match against the last path component (basename).
      // Escape LIKE wildcards (%, _) in the project name.
      const escaped = filters.project.replace(/[%_]/g, "\\$&");
      conditions.push(
        "(project LIKE ? ESCAPE '\\' COLLATE NOCASE OR project = ? COLLATE NOCASE)"
      );
      values.push(`%/${escaped}`, filters.project);
    }
    if (filters?.author) {
      conditions.push("author = ?");
      values.push(filters.author);
    }
    if (filters?.tag) {
      conditions.push(
        "EXISTS (SELECT 1 FROM json_each(tags_json) WHERE json_each.value = ?)"
      );
      values.push(filters.tag);
    }
    if (filters?.grep) {
      conditions.push("(title LIKE ? OR summary LIKE ?)");
      const pattern = `%${filters.grep}%`;
      values.push(pattern, pattern);
    }
    if (filters?.origin === "local") {
      conditions.push("origin IS NULL");
    } else if (filters?.origin === "remote") {
      conditions.push("origin IS NOT NULL");
    }

    const where =
      conditions.length > 0 ? `WHERE ${conditions.join(" AND ")}` : "";
    const sql = `SELECT * FROM conversations ${where} ORDER BY created_at DESC`;

    const results: ConversationMeta[] = [];
    const stmt = this.db.prepare(sql, values);
    while (stmt.step()) {
      results.push(this.rowToConversation(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  listModifiedSincePublish(): ConversationMeta[] {
    const sql = `SELECT * FROM conversations WHERE state = 'published' AND modified_at > published_at ORDER BY created_at DESC`;
    const results: ConversationMeta[] = [];
    const stmt = this.db.prepare(sql);
    while (stmt.step()) {
      results.push(this.rowToConversation(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  getCountsByState(): Record<string, number> {
    const results: Record<string, number> = {
      discovered: 0,
      staged: 0,
      published: 0,
    };
    const stmt = this.db.prepare(
      "SELECT state, COUNT(*) as cnt FROM conversations GROUP BY state"
    );
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results[row.state as string] = row.cnt as number;
    }
    stmt.free();
    return results;
  }

  insertPublishLogEntry(entry: {
    conversationId: string;
    version: number;
    publishedAt: string;
    author: string;
    message: string;
  }): void {
    this.db.run(
      `INSERT INTO publish_log (conversation_id, version, published_at, author, message)
       VALUES (?, ?, ?, ?, ?)`,
      [
        entry.conversationId,
        entry.version,
        entry.publishedAt,
        entry.author,
        entry.message,
      ]
    );
  }

  getPublishLog(): Array<{
    id: number;
    conversationId: string;
    version: number;
    publishedAt: string;
    author: string;
    message: string;
    title: string;
  }> {
    const results: Array<{
      id: number;
      conversationId: string;
      version: number;
      publishedAt: string;
      author: string;
      message: string;
      title: string;
    }> = [];
    const stmt = this.db.prepare(
      `SELECT pl.*, c.title FROM publish_log pl
       LEFT JOIN conversations c ON pl.conversation_id = c.id
       ORDER BY pl.published_at DESC`
    );
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({
        id: row.id as number,
        conversationId: row.conversation_id as string,
        version: row.version as number,
        publishedAt: row.published_at as string,
        author: row.author as string,
        message: (row.message as string) || "",
        title: (row.title as string) || "",
      });
    }
    stmt.free();
    return results;
  }

  getIndexCoverage(): { indexed: number; published: number } {
    const stmt = this.db.prepare(
      `SELECT
         COUNT(*) as published,
         COUNT(indexed_at) as indexed
       FROM conversations WHERE state = 'published'`,
    );
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return {
      indexed: (row.indexed as number) || 0,
      published: (row.published as number) || 0,
    };
  }

  clearAllIndexedAt(): void {
    this.db.run(
      "UPDATE conversations SET indexed_at = NULL WHERE state = 'published' AND indexed_at IS NOT NULL",
    );
  }

  setIndexedAt(id: string, timestamp: string | null): void {
    this.db.run("UPDATE conversations SET indexed_at = ? WHERE id = ?", [
      timestamp,
      id,
    ]);
  }

  listConversationsNeedingIndex(): ConversationMeta[] {
    const sql = `
      SELECT * FROM conversations
      WHERE state = 'published'
        AND indexed_at IS NULL
      ORDER BY created_at DESC
    `;
    const results: ConversationMeta[] = [];
    const stmt = this.db.prepare(sql);
    while (stmt.step()) {
      results.push(this.rowToConversation(stmt.getAsObject()));
    }
    stmt.free();
    return results;
  }

  deleteConversation(id: string): void {
    this.db.run("DELETE FROM conversations WHERE id = ?", [id]);
  }

  deleteByOrigin(origin: string): number {
    this.db.run("DELETE FROM conversations WHERE origin = ?", [origin]);
    const result = this.db.exec("SELECT changes()");
    return (result[0]?.values[0]?.[0] as number) || 0;
  }

  renameAuthor(oldName: string, newName: string): number {
    this.db.run(
      "UPDATE conversations SET author = ? WHERE author = ? AND origin IS NULL",
      [newName, oldName]
    );
    const result = this.db.exec("SELECT changes()");
    return (result[0]?.values[0]?.[0] as number) || 0;
  }

  countByOrigin(origin: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM conversations WHERE origin = ?",
      [origin]
    );
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return (row.cnt as number) || 0;
  }

  countByAuthorLocal(author: string): number {
    const stmt = this.db.prepare(
      "SELECT COUNT(*) as cnt FROM conversations WHERE author = ? AND origin IS NULL",
      [author]
    );
    stmt.step();
    const row = stmt.getAsObject();
    stmt.free();
    return (row.cnt as number) || 0;
  }

  browseDistinct(
    field: "tags" | "projects" | "authors"
  ): Array<{ name: string; count: number }> {
    let sql: string;
    if (field === "tags") {
      sql = `SELECT j.value as name, COUNT(DISTINCT c.id) as count
             FROM conversations c, json_each(c.tags_json) j
             WHERE c.state = 'published'
             GROUP BY j.value ORDER BY count DESC`;
    } else if (field === "projects") {
      sql = `SELECT project as name, COUNT(*) as count
             FROM conversations WHERE state = 'published' AND project IS NOT NULL
             GROUP BY project ORDER BY count DESC`;
    } else {
      sql = `SELECT author as name, COUNT(*) as count
             FROM conversations WHERE state = 'published'
             GROUP BY author ORDER BY count DESC`;
    }

    const results: Array<{ name: string; count: number }> = [];
    const stmt = this.db.prepare(sql);
    while (stmt.step()) {
      const row = stmt.getAsObject();
      results.push({ name: row.name as string, count: row.count as number });
    }
    stmt.free();
    return results;
  }

  private rowToConversation(row: Record<string, unknown>): ConversationMeta {
    return {
      id: row.id as string,
      sourceId: row.source_id as string,
      source: row.source as string,
      title: row.title as string,
      summary: (row.summary as string) || "",
      author: row.author as string,
      project: (row.project as string) || null,
      tags: JSON.parse((row.tags_json as string) || "[]") as string[],
      slug: (row.slug as string) || null,
      createdAt: row.created_at as string,
      discoveredAt: row.discovered_at as string,
      modifiedAt: row.modified_at as string,
      state: row.state as ConversationMeta["state"],
      publishedAt: (row.published_at as string) || null,
      publishVersion: (row.publish_version as number) || 0,
      sourcePath: row.source_path as string,
      filePath: (row.file_path as string) || null,
      sourceMtime: (row.source_mtime as string) || null,
      indexedAt: (row.indexed_at as string) || null,
      origin: (row.origin as string) || null,
    };
  }
}
