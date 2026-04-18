import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  browseValues,
  clearPublishedIndexedAt,
  deleteConversation,
  getConversationById,
  getConversationBySourceIdentityInDb,
  insertConversation,
  listConversations,
  listConversationsNeedingIndex,
  resolveConversationId,
  setConversationIndexedAt,
  updateConversation,
  withDb,
} from "../src/db/index.js";
import { nowIso } from "../src/utils/time.js";

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
        state: "published",
        projectName: "api-service",
      }),
    );

    const published = await listConversations({ states: ["published"] });
    expect(published).toHaveLength(1);

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

  it("browses published authors and tags", async () => {
    await insertConversation(
      makeConversation({
        state: "published",
        tags: ["auth", "debugging"],
      }),
    );
    await insertConversation(
      makeConversation({
        id: "c2345678-1234-1234-1234-123456789012",
        sourceId: "c2345678-1234-1234-1234-123456789012",
        state: "published",
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

  it("round-trips origin and filters by local/remote/URL", async () => {
    const local = makeConversation({ state: "published" });
    const remote1 = makeConversation({
      id: "e1234567-1234-1234-1234-123456789012",
      sourceId: "e1234567-1234-1234-1234-123456789012",
      state: "published",
      author: "bob",
      origin: "git@github.com:myorg/clog-team.git",
    });
    const remote2 = makeConversation({
      id: "f1234567-1234-1234-1234-123456789012",
      sourceId: "f1234567-1234-1234-1234-123456789012",
      state: "published",
      author: "carol",
      origin: "git@example.com:other/repo.git",
    });

    await insertConversation(local);
    await insertConversation(remote1);
    await insertConversation(remote2);

    const loaded = await getConversationById(remote1.id);
    expect(loaded?.origin).toBe("git@github.com:myorg/clog-team.git");

    await expect(listConversations({ origin: "local" })).resolves.toHaveLength(1);
    await expect(listConversations({ origin: "remote" })).resolves.toHaveLength(2);
    await expect(
      listConversations({ origin: { url: "git@github.com:myorg/clog-team.git" } }),
    ).resolves.toHaveLength(1);
  });

  it("applies curatedDefault filter (author OR origin IS NULL)", async () => {
    await insertConversation(makeConversation({ state: "published" }));
    await insertConversation(
      makeConversation({
        id: "e1234567-1234-1234-1234-123456789012",
        sourceId: "e1234567-1234-1234-1234-123456789012",
        state: "published",
        author: "alice",
        origin: "git@example.com:repo.git",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "f1234567-1234-1234-1234-123456789012",
        sourceId: "f1234567-1234-1234-1234-123456789012",
        state: "published",
        author: "bob",
        origin: "git@example.com:repo.git",
      }),
    );

    const curated = await listConversations({
      states: ["published"],
      curatedDefault: { author: "alice" },
    });
    expect(curated).toHaveLength(2);
    expect(curated.every((c) => c.author === "alice" || c.origin === null)).toBe(true);
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

  it("rejects inserting a duplicate conversation id (SPEC §3.1)", async () => {
    await insertConversation(makeConversation());
    await expect(insertConversation(makeConversation())).rejects.toThrow();
  });

  // ============================================================
  // listConversations filters (the ones not covered above)
  // ============================================================

  it("lists conversations across multiple states at once", async () => {
    await insertConversation(makeConversation({ state: "discovered" }));
    await insertConversation(
      makeConversation({
        id: "a2345678-1234-1234-1234-123456789012",
        sourceId: "a2345678-1234-1234-1234-123456789012",
        state: "staged",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "a3456789-1234-1234-1234-123456789012",
        sourceId: "a3456789-1234-1234-1234-123456789012",
        state: "published",
      }),
    );

    const curated = await listConversations({ states: ["staged", "published"] });
    expect(curated).toHaveLength(2);
    expect(new Set(curated.map((c) => c.state))).toEqual(new Set(["staged", "published"]));
  });

  it("filters by indexed (null vs non-null indexed_at)", async () => {
    await insertConversation(
      makeConversation({
        state: "published",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "b1111111-1234-1234-1234-123456789012",
        sourceId: "b1111111-1234-1234-1234-123456789012",
        state: "published",
        indexedAt: null,
      }),
    );

    const indexed = await listConversations({ states: ["published"], indexed: true });
    expect(indexed).toHaveLength(1);
    expect(indexed[0]?.indexedAt).toBe("2026-02-01T10:00:00.000Z");

    const unindexed = await listConversations({ states: ["published"], indexed: false });
    expect(unindexed).toHaveLength(1);
    expect(unindexed[0]?.indexedAt).toBeNull();
  });

  it("curatedDefault: null applies no additional author/origin filter", async () => {
    await insertConversation(makeConversation({ state: "published", author: "alice" }));
    await insertConversation(
      makeConversation({
        id: "c1111111-1234-1234-1234-123456789012",
        sourceId: "c1111111-1234-1234-1234-123456789012",
        state: "published",
        author: "bob",
        origin: "git@example.com:repo.git",
      }),
    );

    const all = await listConversations({ states: ["published"], curatedDefault: null });
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
  });

  it("resolveConversationId rejects invalid source-qualified formats like 'prefix@' and '@source'", async () => {
    await insertConversation(makeConversation());
    await expect(resolveConversationId("abcd@")).rejects.toThrow(/Invalid source-qualified/);
    await expect(resolveConversationId("@claude-code")).rejects.toThrow(/Invalid source-qualified/);
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
      state: "published",
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

  it("listConversationsNeedingIndex returns only published conversations with null indexed_at", async () => {
    // Published + null → needs index
    await insertConversation(
      makeConversation({ state: "published", indexedAt: null }),
    );
    // Published + already indexed → excluded
    await insertConversation(
      makeConversation({
        id: "d1111111-1234-1234-1234-123456789012",
        sourceId: "d1111111-1234-1234-1234-123456789012",
        state: "published",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );
    // Staged + null → excluded (only published is searchable)
    await insertConversation(
      makeConversation({
        id: "d2222222-1234-1234-1234-123456789012",
        sourceId: "d2222222-1234-1234-1234-123456789012",
        state: "staged",
        indexedAt: null,
      }),
    );

    const needing = await listConversationsNeedingIndex();
    expect(needing).toHaveLength(1);
    expect(needing[0]?.id).toBe("a1234567-1234-1234-1234-123456789012");
  });

  it("clearPublishedIndexedAt bulk-clears only published rows", async () => {
    await insertConversation(
      makeConversation({
        state: "published",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );
    await insertConversation(
      makeConversation({
        id: "d3333333-1234-1234-1234-123456789012",
        sourceId: "d3333333-1234-1234-1234-123456789012",
        state: "staged",
        indexedAt: "2026-02-01T10:00:00.000Z",
      }),
    );

    await clearPublishedIndexedAt();

    const published = await getConversationById("a1234567-1234-1234-1234-123456789012");
    const staged = await getConversationById("d3333333-1234-1234-1234-123456789012");
    expect(published?.indexedAt).toBeNull();
    expect(staged?.indexedAt).toBe("2026-02-01T10:00:00.000Z");
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
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: ["debugging"],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "discovered" as const,
    publishedAt: null,
    publishedMessageCount: null,
    publishVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: null,
    indexedAt: null,
    origin: null,
  };
}
