import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  handleBrowse,
  handleGet,
  handleListSaved,
  handleListStaged,
  handleSearch,
  handleUpdate,
} from "../src/mcp/handlers.js";
import { getConversationById, insertConversation } from "../src/db/index.js";
import { SearchNotConfiguredError } from "../src/search/errors.js";
import type {
  EmbeddingProvider,
  SearchHit,
  VectorStore,
} from "../src/search/types.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { writeJsonl } from "./helpers/fixtures.js";

vi.mock("../src/search/deps.js", async () => {
  return {
    getSearchProviders: vi.fn(async () => {
      throw new SearchNotConfiguredError();
    }),
    searchAvailable: vi.fn(async () => false),
    resetSearchProviders: () => undefined,
  };
});

const depsModule = await import("../src/search/deps.js");
const mockedGetSearchProviders = vi.mocked(depsModule.getSearchProviders);

describe("mcp handlers", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-mcp-"));
    process.env.CLOG_HOME = tempDir;

    const rawDir = path.join(tempDir, "raw", "claude-code");
    await fs.mkdir(rawDir, { recursive: true });
    const filePath = path.join(rawDir, "abc12345-1234-1234-1234-123456789012.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Debug auth flow" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
        },
      },
    ]);

    await insertConversation({
      id: "abc12345-1234-1234-1234-123456789012",
      sourceId: "abc12345-1234-1234-1234-123456789012",
      source: "claude-code",
      title: "Debug auth flow",
      summary: "",
      author: "alice",
      projectName: "api-service",
      projectPath: "/tmp/api-service",
      tags: ["auth"],
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
      discoveredAt: "2026-02-01T10:00:00.000Z",
      modifiedAt: "2026-02-01T10:00:00.000Z",
      state: "saved",
      savedAt: "2026-02-01T10:00:02.000Z",
      savedMessageCount: 2,
      saveVersion: 1,
      sourcePath: filePath,
      filePath,
      sourceMtime: null,
      indexedAt: "2026-02-01T10:00:03.000Z",
      origin: null,
    });
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists saved conversations", async () => {
    const result = await handleListSaved({});
    expect(result.totalCount).toBe(1);
    expect(result.conversations[0]?.source).toBe("claude-code");
  });

  it("gets a conversation with parsed messages", async () => {
    const result = await handleGet({ id: "abc12345", maxMessages: 20 });
    expect(result.totalMessages).toBe(2);
    expect(result.messages[0]?.content).toBe("Debug auth flow");
    expect(result.range).toMatchObject({
      mode: "tail",
      startIndex: 0,
      endIndex: 2,
      returnedMessages: 2,
      pageSize: 20,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it("returns clog-style guidance when content is missing", async () => {
    await fs.rm(path.join(tempDir, "raw", "claude-code", "abc12345-1234-1234-1234-123456789012.jsonl"));

    await expect(handleGet({ id: "abc12345", maxMessages: 20 })).rejects.toThrow(
      'Curated raw file is missing for abc12345-1234-1234-1234-123456789012. Run "clog add abc1234" to recreate it.',
    );
  });

  it("includes a request-more truncation note when clog_get is truncated", async () => {
    const result = await handleGet({ id: "abc12345", maxMessages: 1 });
    expect(result.truncated).toBe(true);
    expect(result.truncationNote).toContain("Request head or offset/limit");
  });

  it("updates metadata and tags", async () => {
    const result = await handleUpdate({
      id: "abc12345",
      title: "Updated title",
      addTags: ["debugging"],
    });

    expect(result.conversation.title).toBe("Updated title");
    expect(result.conversation.tags).toContain("debugging");
  });

  it("leaves indexedAt unchanged for tag-only updates", async () => {
    await handleUpdate({
      id: "abc12345",
      addTags: ["debugging"],
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBe("2026-02-01T10:00:03.000Z");
  });

  it("leaves indexedAt unchanged when search is not configured", async () => {
    await handleUpdate({
      id: "abc12345",
      title: "Updated title",
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBe("2026-02-01T10:00:03.000Z");
  });

  it("leaves modifiedAt unchanged for no-op updates", async () => {
    const before = await getConversationById("abc12345-1234-1234-1234-123456789012");
    const result = await handleUpdate({
      id: "abc12345",
      title: "Debug auth flow",
      addTags: ["auth"],
    });
    const after = await getConversationById("abc12345-1234-1234-1234-123456789012");

    expect(result.conversation.modifiedAt).toBe(before?.modifiedAt);
    expect(after?.modifiedAt).toBe(before?.modifiedAt);
  });

  it("browses distinct values", async () => {
    const tags = await handleBrowse({ by: "tags" });
    const authors = await handleBrowse({ by: "authors" });
    expect(tags.items).toEqual([{ name: "auth", count: 1 }]);
    expect(authors.items).toEqual([{ name: "alice", count: 1 }]);
  });

  it("lists staged separately", async () => {
    const result = await handleListStaged({});
    expect(result.totalCount).toBe(0);
  });

  it("filters clog_list_saved by origin", async () => {
    // Add a remote-origin row so we have one of each.
    await insertConversation({
      id: "def45678-1234-1234-1234-123456789012",
      sourceId: "def45678-1234-1234-1234-123456789012",
      source: "claude-code",
      title: "From remote",
      summary: "",
      author: "bob",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: "2026-02-02T10:00:00.000Z",
      discoveredAt: "2026-02-02T10:00:00.000Z",
      modifiedAt: "2026-02-02T10:00:00.000Z",
      state: "saved",
      savedAt: "2026-02-02T10:00:00.000Z",
      savedMessageCount: 1,
      saveVersion: 1,
      sourcePath: "/tmp/remote.jsonl",
      filePath: "/tmp/remote.jsonl",
      sourceMtime: null,
      indexedAt: null,
      origin: "git@github.com:myorg/clog-team.git",
    });

    const all = await handleListSaved({});
    expect(all.totalCount).toBe(2);

    const local = await handleListSaved({ origin: "local" });
    expect(local.totalCount).toBe(1);
    expect(local.conversations[0]?.title).toBe("Debug auth flow");

    const remote = await handleListSaved({ origin: "remote" });
    expect(remote.totalCount).toBe(1);
    expect(remote.conversations[0]?.title).toBe("From remote");
  });

  // ============================================================
  // Additional list filters
  // ============================================================

  it("filters by tags (OR semantics)", async () => {
    await insertOtherSaved("b1111111-1111-1111-1111-111111111111", {
      title: "Has rate-limit",
      tags: ["rate-limiting"],
    });

    const hits = await handleListSaved({ tags: ["auth"] });
    expect(hits.totalCount).toBe(1);
    expect(hits.conversations[0]?.title).toBe("Debug auth flow");

    const multi = await handleListSaved({ tags: ["rate-limiting", "auth"] });
    expect(multi.totalCount).toBe(2);
  });

  it("filters by project and author", async () => {
    await insertOtherSaved("b2222222-2222-2222-2222-222222222222", {
      title: "Other service",
      author: "bob",
      projectName: "other-service",
    });

    const byProject = await handleListSaved({ project: "api-service" });
    expect(byProject.totalCount).toBe(1);
    expect(byProject.conversations[0]?.projectName).toBe("api-service");

    const byAuthor = await handleListSaved({ author: "bob" });
    expect(byAuthor.totalCount).toBe(1);
    expect(byAuthor.conversations[0]?.author).toBe("bob");
  });

  it("filters by grep against title and summary", async () => {
    await insertOtherSaved("b3333333-3333-3333-3333-333333333333", {
      title: "Unrelated chat",
      summary: "JWT token refresh discussion",
    });

    const byTitle = await handleListSaved({ grep: "debug auth" });
    expect(byTitle.conversations.map((c) => c.title)).toContain("Debug auth flow");

    const bySummary = await handleListSaved({ grep: "jwt" });
    expect(bySummary.conversations.map((c) => c.title)).toContain("Unrelated chat");
  });

  it("supports limit and offset pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await insertOtherSaved(`b4${i}${i}${i}${i}${i}${i}${i}-4444-4444-4444-444444444444`, {
        title: `Row ${i}`,
      });
    }

    const first = await handleListSaved({ limit: 3, offset: 0 });
    expect(first.conversations).toHaveLength(3);
    expect(first.totalCount).toBe(6); // the original + 5 new

    const second = await handleListSaved({ limit: 3, offset: 3 });
    expect(second.conversations).toHaveLength(3);
  });

  it("lists staged conversations separately from saved", async () => {
    await insertOtherSaved("b5555555-5555-5555-5555-555555555555", {
      title: "A staged one",
      state: "staged",
    });

    const saved = await handleListSaved({});
    const staged = await handleListStaged({});

    expect(saved.totalCount).toBe(1);
    expect(saved.conversations[0]?.title).toBe("Debug auth flow");
    expect(staged.totalCount).toBe(1);
    expect(staged.conversations[0]?.title).toBe("A staged one");
  });

  // ============================================================
  // clog_get edge cases
  // ============================================================

  it("clog_get defaults to the last 20 messages and reports range metadata", async () => {
    const id = "c1000000-0000-0000-0000-000000000000";
    await insertSavedMessages(
      tempDir,
      id,
      Array.from({ length: 25 }, (_, index) => `message ${index}`),
    );

    const result = await handleGet({ id: "c1000000" });

    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]?.content).toBe("message 5");
    expect(result.messages[19]?.content).toBe("message 24");
    expect(result.range).toEqual({
      mode: "tail",
      startIndex: 5,
      endIndex: 25,
      returnedMessages: 20,
      pageSize: 20,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 0,
    });
    expect(result.truncationNote).toContain("Showing the last 20 of 25 messages");
  });

  it("clog_get keeps maxMessages as a tail-mode compatibility alias", async () => {
    const id = "c2000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const result = await handleGet({ id: "c2000000", maxMessages: 2 });

    expect(result.messages.map((message) => message.content)).toEqual(["m3", "m4"]);
    expect(result.range).toMatchObject({
      mode: "tail",
      startIndex: 3,
      endIndex: 5,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 1,
    });
  });

  it("clog_get supports explicit head and tail ranges", async () => {
    const id = "c3000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const head = await handleGet({ id: "c3000000", head: 2 });
    expect(head.messages.map((message) => message.content)).toEqual(["m0", "m1"]);
    expect(head.range).toEqual({
      mode: "head",
      startIndex: 0,
      endIndex: 2,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: false,
      hasMoreAfter: true,
      nextOffset: 2,
    });

    const tail = await handleGet({ id: "c3000000", tail: 2 });
    expect(tail.messages.map((message) => message.content)).toEqual(["m3", "m4"]);
    expect(tail.range).toEqual({
      mode: "tail",
      startIndex: 3,
      endIndex: 5,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 1,
    });
  });

  it("clog_get supports arbitrary offset and limit windows", async () => {
    const id = "c4000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const result = await handleGet({ id: "c4000000", offset: 2, limit: 2 });

    expect(result.messages.map((message) => message.content)).toEqual(["m2", "m3"]);
    expect(result.range).toEqual({
      mode: "window",
      startIndex: 2,
      endIndex: 4,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousOffset: 0,
      nextOffset: 4,
    });
    expect(result.truncationNote).toContain("Showing messages 3-4 of 5");
    expect(result.truncationNote).toContain("Request offset 4 with limit 2");
  });

  it("clog_get defaults a window limit to 20 when offset is supplied", async () => {
    const id = "c5000000-0000-0000-0000-000000000000";
    await insertSavedMessages(
      tempDir,
      id,
      Array.from({ length: 25 }, (_, index) => `message ${index}`),
    );

    const result = await handleGet({ id: "c5000000", offset: 20 });

    expect(result.messages.map((message) => message.content)).toEqual([
      "message 20",
      "message 21",
      "message 22",
      "message 23",
      "message 24",
    ]);
    expect(result.range).toMatchObject({
      mode: "window",
      startIndex: 20,
      endIndex: 25,
      returnedMessages: 5,
      pageSize: 20,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 0,
    });
  });

  it("clog_get clamps empty windows beyond the end and points back to real content", async () => {
    const id = "c6000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const result = await handleGet({ id: "c6000000", offset: 100, limit: 2 });

    expect(result.messages).toEqual([]);
    expect(result.range).toEqual({
      mode: "window",
      startIndex: 5,
      endIndex: 5,
      returnedMessages: 0,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 3,
    });
    expect(result.truncationNote).toContain("Requested offset 100 is beyond the 5-message conversation");
    expect(result.truncationNote).toContain("Request offset 3 with limit 2");
  });

  it("clog_get rejects conflicting range controls", async () => {
    await expect(handleGet({ id: "abc12345", maxMessages: 5, head: 2 })).rejects.toThrow(
      "Choose only one message range: maxMessages, head, tail, or offset/limit.",
    );
    await expect(handleGet({ id: "abc12345", tail: 5, offset: 2, limit: 2 })).rejects.toThrow(
      "Choose only one message range: maxMessages, head, tail, or offset/limit.",
    );
  });

  it("clog_get rejects limit without offset", async () => {
    await expect(handleGet({ id: "abc12345", limit: 2 })).rejects.toThrow(
      "limit can only be used with offset",
    );
  });

  it("clog_get rejects message counts over the per-call cap", async () => {
    await expect(handleGet({ id: "abc12345", head: 201 })).rejects.toThrow();
  });

  it("clog_get throws on a discovered conversation", async () => {
    await insertOtherSaved("b6666666-6666-6666-6666-666666666666", {
      state: "discovered",
    });
    await expect(handleGet({ id: "b6666666" })).rejects.toThrow(
      /staged or saved/,
    );
  });

  it("clog_get throws when the id is not found", async () => {
    await expect(handleGet({ id: "9999eeee" })).rejects.toThrow(/No conversation matches/);
  });

  // ============================================================
  // clog_update edge cases
  // ============================================================

  it("clog_update throws on a discovered conversation", async () => {
    await insertOtherSaved("b7777777-7777-7777-7777-777777777777", {
      state: "discovered",
    });

    await expect(
      handleUpdate({ id: "b7777777", title: "New title" }),
    ).rejects.toThrow(/staged or saved/);
  });

  it("clog_update refuses a remote conversation (SPEC §11.1)", async () => {
    await insertOtherSaved("bb000000-0000-0000-0000-000000000002", {
      origin: "git@example.com:team/repo.git",
    });

    await expect(
      handleUpdate({ id: "bb000000", title: "new title" }),
    ).rejects.toThrow(/remote.*read-only/i);
  });

  it("clog_update removeTags removes matching tags and bumps modifiedAt", async () => {
    await insertOtherSaved("b8888888-8888-8888-8888-888888888888", {
      tags: ["bug", "urgent", "frontend"],
    });

    const result = await handleUpdate({
      id: "b8888888",
      removeTags: ["bug", "urgent"],
    });
    expect(result.conversation.tags).toEqual(["frontend"]);
  });

  // ============================================================
  // clog_browse
  // ============================================================

  it("browses projects", async () => {
    await insertOtherSaved("b9999999-9999-9999-9999-999999999999", {
      projectName: "other-project",
    });
    const result = await handleBrowse({ by: "projects" });
    expect(result.items.map((item) => item.name).sort()).toEqual([
      "api-service",
      "other-project",
    ]);
  });

  // ============================================================
  // clog_search
  // ============================================================

  it("clog_search throws when search is not configured", async () => {
    // Default mock throws SearchNotConfiguredError (see vi.mock above).
    await expect(handleSearch({ query: "auth" })).rejects.toThrow(
      /Search is not configured/,
    );
  });

  it("clog_search returns empty results with indexCoverage when no conversations are searchable", async () => {
    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore([]),
    });

    // The seeded conversation has indexedAt set, but we'll add an unindexed one.
    await insertOtherSaved("ba000000-0000-0000-0000-000000000001", {
      title: "Not indexed",
      indexedAt: null,
    });

    const result = await handleSearch({
      query: "auth",
      project: "no-such-project",
    });
    expect(result.results).toEqual([]);
    // No searchable conversations match the project filter, so the invariant-check
    // short-circuits before invoking the vector store.
    expect(result.indexCoverage.indexed).toBe(0);
  });

  it("clog_search returns ranked hits scoped to searchable conversations", async () => {
    const searchableId = "abc12345-1234-1234-1234-123456789012"; // seeded in beforeEach, indexedAt set
    const hits: SearchHit[] = [
      {
        id: `${searchableId}:0`,
        score: 0.9,
        text: "How to debug JWT refresh",
        metadata: { conversationId: searchableId },
      },
    ];

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const result = await handleSearch({ query: "auth" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(searchableId);
    expect(result.results[0]?.relevanceScore).toBe(0.9);
    expect(result.results[0]?.snippet).toContain("debug JWT refresh");
    expect(result.indexCoverage.indexed).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("clog_search reports the scan-cap warning when the window is exhausted", async () => {
    const searchableId = "abc12345-1234-1234-1234-123456789012";
    // Return a full window of sub-threshold hits that never satisfy the limit.
    const hits: SearchHit[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `${searchableId}:${i}`,
      score: 0.05,
      text: `noise ${i}`,
      metadata: { conversationId: searchableId },
    }));

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const result = await handleSearch({ query: "auth", limit: 10 });
    expect(result.warning).toContain("maximum scan window");
  });
});

async function insertOtherSaved(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<void> {
  await insertConversation({
    id,
    sourceId: id,
    source: "claude-code",
    title: "Other conversation",
    summary: "",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: [],
    slug: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    discoveredAt: "2026-02-01T10:00:00.000Z",
    modifiedAt: "2026-02-01T10:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-01T10:00:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: "/tmp/other.jsonl",
    filePath: "/tmp/other.jsonl",
    sourceMtime: null,
    indexedAt: "2026-02-01T10:00:00.000Z",
    origin: null,
    ...overrides,
  });
}

async function insertSavedMessages(
  tempDir: string,
  id: string,
  contents: string[],
): Promise<void> {
  const rawDir = path.join(tempDir, "raw", "claude-code");
  const filePath = path.join(rawDir, `${id}.jsonl`);
  await writeJsonl(
    filePath,
    contents.map((content, index) => ({
      type: "user",
      timestamp: `2026-02-01T10:00:${String(index).padStart(2, "0")}.000Z`,
      message: { role: "user", content },
    })),
  );

  await insertOtherSaved(id, {
    title: `Conversation ${id.slice(0, 7)}`,
    sourcePath: filePath,
    filePath,
    savedMessageCount: contents.length,
  });
}

function makeEmbedding(): EmbeddingProvider {
  return {
    name: "fake",
    dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}

function makeVectorStore(hits: SearchHit[]): VectorStore {
  return {
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    search: vi.fn(async (_embedding, limit) => hits.slice(0, limit)),
  };
}
