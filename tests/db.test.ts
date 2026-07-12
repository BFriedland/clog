import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  browseValues,
  clearSavedIndexedAt,
  getConversationById,
  getConversationBySourceIdentityInDb,
  listConversations,
  listConversationsNeedingIndex,
  resolveConversationId,
  setConversationIndexedAt,
  withDb,
} from "../src/db/index.js";
import { nowIso } from "../src/utils/time.js";
import { deleteConversation, insertConversation, updateConversation } from "./helpers/db.js";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

describe("db", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-db-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("initializes when the working directory has no node_modules", async () => {
    const workingDir = path.join(tempDir, "working");
    const childHome = path.join(tempDir, "child-home");
    await fs.mkdir(workingDir);

    const dbModuleUrl = new URL("../src/db/index.ts", import.meta.url).href;
    const script = `
      import { withDb } from ${JSON.stringify(dbModuleUrl)};
      await withDb(() => undefined);
    `;

    await execFileAsync(
      process.execPath,
      [
        "--import",
        require.resolve("tsx"),
        "--input-type=module",
        "--eval",
        script,
      ],
      {
        cwd: workingDir,
        env: {
          ...process.env,
          CLOG_HOME: childHome,
        },
      },
    );

    await expect(fs.stat(path.join(childHome, "clog.db"))).resolves.toBeTruthy();
    await expect(fs.stat(path.join(workingDir, "node_modules"))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("creates schema on first access", async () => {
    await withDb(() => undefined);

    const dbPath = path.join(tempDir, "clog.db");
    await expect(fs.stat(dbPath)).resolves.toBeTruthy();
  });

  it("removes a legacy file-shaped db lock path before acquiring the lock", async () => {
    const legacyLockPath = path.join(tempDir, "clog.db.lock");
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(legacyLockPath, "", "utf8");

    await withDb(() => undefined);

    await expect(fs.stat(legacyLockPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("inserts and reads a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    const loaded = await getConversationById(conversation.id);
    expect(loaded).toEqual(conversation);
  });

  it("updates a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    const updated = {
      ...conversation,
      title: "Updated title",
      projectName: "other-project",
      tags: ["debugging", "auth"],
    };

    await updateConversation(updated);

    await expect(getConversationById(conversation.id)).resolves.toEqual(updated);
  });

  it("lists conversations with state and project filters", async () => {
    await insertConversation(makeConversation());
    await insertConversation(
      makeConversation({
        id: "b2345678-1234-1234-1234-123456789012",
        sourceId: "b2345678-1234-1234-1234-123456789012",
        state: "saved",
        projectName: "api-service",
      }),
    );

    const saved = await listConversations({ states: ["saved"] });
    expect(saved).toHaveLength(1);

    const byProject = await listConversations({ projectName: "api-service" });
    expect(byProject).toHaveLength(2);
  });

  it("filters tags by exact case-insensitive match", async () => {
    await insertConversation(
      makeConversation({
        tags: ["debugging"],
      }),
    );
    await insertConversation(
      makeConversation({
        id: "d2345678-1234-1234-1234-123456789012",
        sourceId: "d2345678-1234-1234-1234-123456789012",
        tags: ["bug"],
      }),
    );

    const bug = await listConversations({ tag: "BUG" });
    const debugging = await listConversations({ tag: "debugging" });

    expect(bug).toHaveLength(1);
    expect(bug[0]?.tags).toEqual(["bug"]);
    expect(debugging).toHaveLength(1);
    expect(debugging[0]?.tags).toEqual(["debugging"]);
  });

  it("resolves short ids and source-qualified ids", async () => {
    await insertConversation(makeConversation());
    await insertConversation(
      makeConversation({
        id: "a123ffff-1234-1234-1234-123456789012",
        sourceId: "a123ffff-1234-1234-1234-123456789012",
        source: "codex-cli",
      }),
    );

    await expect(resolveConversationId("a123")).rejects.toThrow(/ambiguous/i);
    await expect(resolveConversationId("a123@claude-code")).resolves.toEqual({
      id: "a1234567-1234-1234-1234-123456789012",
      source: "claude-code",
    });
  });

  it("resolves source-qualified ids with open source-key syntax", async () => {
    await insertConversation(
      makeConversation({
        id: "a1240000-1234-1234-1234-123456789012",
        sourceId: "a1240000-1234-1234-1234-123456789012",
        source: "future.agent",
      }),
    );

    await expect(resolveConversationId("a124@future.agent")).resolves.toEqual({
      id: "a1240000-1234-1234-1234-123456789012",
      source: "future.agent",
    });
  });

  it("browses saved authors and tags", async () => {
    await insertConversation(
      makeConversation({
        state: "saved",
        tags: ["auth", "debugging"],
      }),
    );
    await insertConversation(
      makeConversation({
        id: "c2345678-1234-1234-1234-123456789012",
        sourceId: "c2345678-1234-1234-1234-123456789012",
        state: "saved",
        author: "bob",
        tags: ["auth"],
      }),
    );

    await expect(browseValues("author")).resolves.toEqual([
      { name: "alice", count: 1 },
      { name: "bob", count: 1 },
    ]);
    await expect(browseValues("tags_json")).resolves.toEqual([
      { name: "auth", count: 2 },
      { name: "debugging", count: 1 },
    ]);
  });

  it("deletes a conversation", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    await deleteConversation(conversation.id);

    await expect(getConversationById(conversation.id)).resolves.toBeNull();
  });

  it("round-trips provenance and filters by local/remote/kind-ref", async () => {
    const local = makeConversation({ state: "saved" });
    const remote1 = makeConversation({
      id: "e1234567-1234-1234-1234-123456789012",
      sourceId: "e1234567-1234-1234-1234-123456789012",
      state: "saved",
      author: "bob",
      originKind: "git",
      originRef: "git@github.com:myorg/clog-team.git",
    });
    const remote2 = makeConversation({
      id: "f1234567-1234-1234-1234-123456789012",
      sourceId: "f1234567-1234-1234-1234-123456789012",
      state: "saved",
      author: "carol",
      originKind: "file",
      originRef: null,
    });

    await insertConversation(local);
    await insertConversation(remote1);
    await insertConversation(remote2);

    const loaded = await getConversationById(remote1.id);
    expect(loaded?.originKind).toBe("git");
    expect(loaded?.originRef).toBe("git@github.com:myorg/clog-team.git");

    await expect(listConversations({ origin: "local" })).resolves.toHaveLength(1);
    await expect(listConversations({ origin: "remote" })).resolves.toHaveLength(2);
    await expect(
      listConversations({
        origin: { kind: "git", ref: "git@github.com:myorg/clog-team.git" },
      }),
    ).resolves.toHaveLength(1);
    await expect(listConversations({ origin: { kind: "file", ref: null } })).resolves.toHaveLength(1);
  });

  it("applies curatedDefault filter using local plus same-author imports", async () => {
    await insertConversation(makeConversation({ state: "saved" }));
    await insertConversation(
      makeConversation({
        id: "e1234567-1234-1234-1234-123456789012",
        sourceId: "e1234567-1234-1234-1234-123456789012",
        state: "saved",
        author: "alice",
        originKind: "file",
        originRef: null,
      }),
    );
    await insertConversation(
      makeConversation({
        id: "f1234567-1234-1234-1234-123456789012",
        sourceId: "f1234567-1234-1234-1234-123456789012",
        state: "saved",
        author: "bob",
        originKind: "file",
        originRef: null,
      }),
    );

    const curated = await listConversations({
      states: ["saved"],
      curatedDefault: { author: "alice" },
    });
    expect(curated).toHaveLength(2);
    expect(curated.every((c) => c.originKind === "local" || c.author === "alice")).toBe(true);
  });

  // ============================================================
  // Schema migration and constraint enforcement
  // ============================================================

  it("applyMigrations is idempotent across successive withDb calls (SPEC §3.4.1)", async () => {
    await withDb(() => undefined);
    await withDb(() => undefined);
    await insertConversation(makeConversation());
    await expect(getConversationById("a1234567-1234-1234-1234-123456789012")).resolves.toBeTruthy();
  });

  it("migrates legacy origin into origin_kind and origin_ref", async () => {
    await withDb((db) => {
      db.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (6);
        CREATE TABLE conversations (
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
      `);
      db.run(
        `
          INSERT INTO conversations (
            id, source_id, source, title, summary, summary_kind, summary_extraction,
            author, project_name, project_path, tags_json, slug, created_at,
            discovered_at, modified_at, state, saved_at, saved_message_count,
            save_version, source_path, file_path, source_mtime, indexed_at, origin
          ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        `,
        [
          "e2222222-1234-1234-1234-123456789012",
          "e2222222-1234-1234-1234-123456789012",
          "claude-code",
          "Remote legacy row",
          "",
          "none",
          null,
          "bob",
          null,
          null,
          "[]",
          null,
          "2026-02-01T10:00:00.000Z",
          "2026-02-01T10:00:00.000Z",
          "2026-02-01T10:00:00.000Z",
          "saved",
          "2026-02-01T10:00:00.000Z",
          1,
          1,
          "/tmp/remote.jsonl",
          "/tmp/remote.jsonl",
          null,
          null,
          "git@example.com:repo.git",
        ],
      );
    }, { applyMigrations: false });

    await withDb(() => undefined);

    const loaded = await getConversationById("e2222222-1234-1234-1234-123456789012");
    expect(loaded?.originKind).toBe("git");
    expect(loaded?.originRef).toBe("git@example.com:repo.git");
  });

  it("renames the legacy 'discovered' state to 'unsaved' on migration", async () => {
    await withDb((db) => {
      db.exec(`
        CREATE TABLE schema_version (version INTEGER NOT NULL);
        INSERT INTO schema_version (version) VALUES (7);
        CREATE TABLE conversations (
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
          UNIQUE(source, source_id)
        );
      `);
      db.run(
        `INSERT INTO conversations (id, source_id, source, title, author,
          created_at, discovered_at, modified_at, state, save_version, source_path,
          origin_kind, origin_ref)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          "f4444444-1234-1234-1234-123456789012",
          "f4444444-1234-1234-1234-123456789012",
          "claude-code",
          "Legacy discovered row",
          "alice",
          "2026-02-01T10:00:00.000Z",
          "2026-02-01T10:00:00.000Z",
          "2026-02-01T10:00:00.000Z",
          "discovered",
          0,
          "/tmp/legacy.jsonl",
          "local",
          null,
        ],
      );
    }, { applyMigrations: false });

    await withDb(() => undefined);

    const loaded = await getConversationById("f4444444-1234-1234-1234-123456789012");
    expect(loaded?.state).toBe("unsaved");
  });

  it("enforces origin_kind and origin_ref constraints", async () => {
    await withDb((db) => {
      expect(() => {
        db.run(
          `
            INSERT INTO conversations (
              id, source_id, source, title, summary, summary_kind, summary_extraction,
              author, project_name, project_path, tags_json, slug, created_at,
              discovered_at, modified_at, state, saved_at, saved_message_count,
              save_version, source_path, file_path, source_mtime, indexed_at,
              origin_kind, origin_ref
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `,
          [
            "e3333333-1234-1234-1234-123456789012",
            "e3333333-1234-1234-1234-123456789012",
            "claude-code",
            "Bad row",
            "",
            "none",
            null,
            "bob",
            null,
            null,
            "[]",
            null,
            "2026-02-01T10:00:00.000Z",
            "2026-02-01T10:00:00.000Z",
            "2026-02-01T10:00:00.000Z",
            "saved",
            "2026-02-01T10:00:00.000Z",
            1,
            1,
            "/tmp/file.jsonl",
            "/tmp/file.jsonl",
            null,
            null,
            "file",
            "git@example.com:repo.git",
          ],
        );
      }).toThrow();
    });
  });

  it("rejects inserting a duplicate conversation id (SPEC §3.1)", async () => {
    await insertConversation(makeConversation());
    await expect(insertConversation(makeConversation())).rejects.toThrow();
  });

  // ============================================================
  // listConversations filters (the ones not covered above)
  // ============================================================

  it("lists conversations across multiple states at once", async () => {
    await insertConversation(makeConversation({ state: "unsaved" }));
    await insertConversation(
      makeConversation({
        id: "a2345678-1234-1234-1234-123456789012",
        sourceId: "a2345678-1234-1234-1234-123456789012",
        state: "saved",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "a3456789-1234-1234-1234-123456789012",
        sourceId: "a3456789-1234-1234-1234-123456789012",
        state: "saved",
      }),
    );

    const curated = await listConversations({ states: ["saved"] });
    expect(curated).toHaveLength(2);
    expect(new Set(curated.map((c) => c.state))).toEqual(new Set(["saved"]));
  });

  it("filters by indexed (null vs non-null indexed_at)", async () => {
    await insertConversation(
      makeConversation({
        state: "saved",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "b1111111-1234-1234-1234-123456789012",
        sourceId: "b1111111-1234-1234-1234-123456789012",
        state: "saved",
        indexedAt: null,
      }),
    );

    const indexed = await listConversations({ states: ["saved"], indexed: true });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.indexedAt).toBe("2026-02-01T10:00:00.000Z");

    const unindexed = await listConversations({ states: ["saved"], indexed: false });
    expect(unindexed).toHaveLength(1);
    expect(unindexed[0]?.indexedAt).toBeNull();
  });

  it("curatedDefault: null applies no additional author/origin filter", async () => {
    await insertConversation(makeConversation({ state: "saved", author: "alice" }));
    await insertConversation(
      makeConversation({
        id: "c1111111-1234-1234-1234-123456789012",
        sourceId: "c1111111-1234-1234-1234-123456789012",
        state: "saved",
        author: "bob",
        originKind: "git",
        originRef: "git@example.com:repo.git",
      }),
    );

    const all = await listConversations({ states: ["saved"], curatedDefault: null });
    expect(all).toHaveLength(2);
  });

  // ============================================================
  // resolveConversationId edge cases (SPEC §3.3)
  // ============================================================

  it("resolveConversationId rejects prefixes shorter than 4 characters", async () => {
    await insertConversation(makeConversation());
    await expect(resolveConversationId("abc")).rejects.toThrow(/at least 4 characters/);
  });

  it("resolveConversationId resolves a full UUID match", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);
    await expect(resolveConversationId(conversation.id)).resolves.toEqual({
      id: conversation.id,
      source: "claude-code",
    });
  });

  it("resolveConversationId reports 'No conversation matches' when nothing matches", async () => {
    await insertConversation(makeConversation());
    await expect(resolveConversationId("9999")).rejects.toThrow(/No conversation matches/);
    await expect(resolveConversationId("zzzz@claude-code")).rejects.toThrow(/No conversation matches/);
  });

  it("resolveConversationId rejects invalid source-qualified formats like 'prefix@' and '@source'", async () => {
    await insertConversation(makeConversation());
    await expect(resolveConversationId("abcd@")).rejects.toThrow(/Invalid source-qualified/);
    await expect(resolveConversationId("@claude-code")).rejects.toThrow(/Invalid source-qualified/);
    await expect(resolveConversationId("abcd@CLAUDE-CODE")).rejects.toThrow(/Invalid source-qualified/);
    await expect(resolveConversationId("abcd@extra@claude-code")).rejects.toThrow(/Invalid source-qualified/);
  });

  it("resolveConversationId reports no-match when the source is unknown", async () => {
    await insertConversation(makeConversation());
    await expect(resolveConversationId("a123@made-up-source")).rejects.toThrow(
      /No conversation matches/,
    );
  });

  // ============================================================
  // getConversationBySourceIdentityInDb (used by scan and sync)
  // ============================================================

  it("getConversationBySourceIdentityInDb looks up by (source, sourceId)", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);

    const loaded = await withDb((db) =>
      getConversationBySourceIdentityInDb(db, conversation.source, conversation.sourceId),
    );
    expect(loaded?.id).toBe(conversation.id);
  });

  it("getConversationBySourceIdentityInDb returns null when nothing matches", async () => {
    const loaded = await withDb((db) =>
      getConversationBySourceIdentityInDb(db, "claude-code", "not-a-real-id"),
    );
    expect(loaded).toBeNull();
  });

  // ============================================================
  // indexed_at helpers (Phase 2 staleness surface — SPEC §10.7)
  // ============================================================

  it("setConversationIndexedAt sets and clears indexed_at without touching other fields", async () => {
    const conversation = makeConversation({
      state: "saved",
      indexedAt: null,
    });
    await insertConversation(conversation);

    await setConversationIndexedAt(conversation.id, "2026-02-01T12:00:00.000Z");
    let reloaded = await getConversationById(conversation.id);
    expect(reloaded?.indexedAt).toBe("2026-02-01T12:00:00.000Z");
    expect(reloaded?.title).toBe(conversation.title);

    await setConversationIndexedAt(conversation.id, null);
    reloaded = await getConversationById(conversation.id);
    expect(reloaded?.indexedAt).toBeNull();
  });

  it("listConversationsNeedingIndex returns saved conversations with missing or stale indexed_at", async () => {
    // Saved + null → needs index
    await insertConversation(
      makeConversation({ state: "saved", indexedAt: null }),
    );
    // Saved + indexed before saved_at → needs index
    await insertConversation(
      makeConversation({
        id: "d0000000-1234-1234-1234-123456789012",
        sourceId: "d0000000-1234-1234-1234-123456789012",
        state: "saved",
        savedAt: "2026-02-01T10:00:00.000Z",
        indexedAt: "2026-02-01T09:59:59.000Z",
      }),
    );
    // Saved + already indexed → excluded
    await insertConversation(
      makeConversation({
        id: "d1111111-1234-1234-1234-123456789012",
        sourceId: "d1111111-1234-1234-1234-123456789012",
        state: "saved",
        savedAt: "2026-02-01T10:00:00.000Z",
        indexedAt: "2026-02-01T10:00:01.000Z",
      }),
    );
    // Discovered + null → excluded (only saved is searchable)
    await insertConversation(
      makeConversation({
        id: "d2222222-1234-1234-1234-123456789012",
        sourceId: "d2222222-1234-1234-1234-123456789012",
        state: "unsaved",
        indexedAt: null,
      }),
    );

    const needing = await listConversationsNeedingIndex();
    expect(needing.map((conversation) => conversation.id)).toEqual([
      "a1234567-1234-1234-1234-123456789012",
      "d0000000-1234-1234-1234-123456789012",
    ]);
  });

  it("clearSavedIndexedAt bulk-clears only saved rows", async () => {
    await insertConversation(
      makeConversation({
        state: "saved",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "d3333333-1234-1234-1234-123456789012",
        sourceId: "d3333333-1234-1234-1234-123456789012",
        state: "unsaved",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );

    await clearSavedIndexedAt();

    const saved = await getConversationById("a1234567-1234-1234-1234-123456789012");
    const discovered = await getConversationById("d3333333-1234-1234-1234-123456789012");
    expect(saved?.indexedAt).toBeNull();
    expect(discovered?.indexedAt).toBe("2026-02-01T10:00:00.000Z");
  });
});

function makeConversation(
  overrides: Partial<ReturnType<typeof baseConversation>> = {},
) {
  return {
    ...baseConversation(),
    ...overrides,
  };
}

function baseConversation() {
  const timestamp = nowIso();

  return {
    id: "a1234567-1234-1234-1234-123456789012",
    sourceId: "a1234567-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Debug auth",
    summary: "",
    summaryKind: "none" as const,
    summaryExtraction: null,
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: ["debugging"],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "unsaved" as const,
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: null,
    indexedAt: null,
    originKind: "local" as const,
    originRef: null,
  };
}
