import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { getSearchProviders } from "../src/search/deps.js";
import {
  deindexConversations,
  isConversationSearchable,
} from "../src/search/coherence.js";
import { searchConversations } from "../src/search/indexer.js";
import type {
  EmbeddingProvider,
  VectorResult,
  VectorStore,
} from "../src/search/types.js";
import type { ConversationMeta } from "../src/models/conversation.js";

vi.mock("../src/search/deps.js", () => ({
  getSearchProviders: vi.fn(),
}));

let env: TestEnv;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  env = await createTestEnv();
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  errorSpy.mockRestore();
  vi.mocked(getSearchProviders).mockReset();
  await env.cleanup();
});

describe("deindexConversations", () => {
  it("warns and continues when a delete fails", async () => {
    const deleteFn = vi.fn()
      .mockRejectedValueOnce(new Error("boom"))
      .mockResolvedValueOnce(undefined);

    vi.mocked(getSearchProviders).mockResolvedValue({
      embedding: {} as never,
      vectorStore: {
        delete: deleteFn,
      } as never,
    });

    await deindexConversations([
      "aaaaaaaa-1111-2222-3333-444444444444",
      "bbbbbbbb-1111-2222-3333-444444444444",
    ]);

    expect(deleteFn).toHaveBeenCalledTimes(2);
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("warning: failed to deindex aaaaaaa: boom"),
    );
  });

  it("warns when deindexing cannot be initialized", async () => {
    vi.mocked(getSearchProviders).mockRejectedValue(
      new Error("providers unavailable"),
    );

    await deindexConversations([
      "aaaaaaaa-1111-2222-3333-444444444444",
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "warning: failed to initialize deindexing: providers unavailable",
      ),
    );
  });

  it("does not warn when search is not configured", async () => {
    const err = new Error("not configured");
    err.name = "SearchNotConfiguredError";
    vi.mocked(getSearchProviders).mockRejectedValue(err);

    await deindexConversations([
      "aaaaaaaa-1111-2222-3333-444444444444",
    ]);

    expect(errorSpy).not.toHaveBeenCalled();
  });

  it("warns when search is configured but deindexing deps are unavailable", async () => {
    const err = new Error("deps missing");
    err.name = "SearchDepsError";
    vi.mocked(getSearchProviders).mockRejectedValue(err);

    await deindexConversations([
      "aaaaaaaa-1111-2222-3333-444444444444",
    ]);

    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining(
        "warning: failed to initialize deindexing: deps missing",
      ),
    );
  });
});

describe("isConversationSearchable", () => {
  function makeConversation(
    overrides: Partial<ConversationMeta> = {},
  ): ConversationMeta {
    return {
      id: "aaaaaaaa-1111-2222-3333-444444444444",
      sourceId: "source-1",
      source: "claude-code",
      title: "Test conversation",
      summary: "A test summary",
      author: "testuser",
      project: null,
      tags: [],
      slug: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      state: "published",
      publishedAt: "2026-01-01T00:00:00.000Z",
      publishVersion: 1,
      sourcePath: "/tmp/source.jsonl",
      filePath: "/tmp/raw.jsonl",
      sourceMtime: "2026-01-01T00:00:00.000Z",
      indexedAt: "2026-01-01T00:00:01.000Z",
      origin: null,
      ...overrides,
    };
  }

  it("requires a published conversation to have indexed vectors", () => {
    expect(
      isConversationSearchable(
        makeConversation({ indexedAt: null }),
      ),
    ).toBe(false);
    expect(isConversationSearchable(makeConversation())).toBe(true);
  });
});

describe("searchConversations", () => {
  it("keeps expanding the query window until it finds enough valid results", async () => {
    const embedding: EmbeddingProvider = {
      name: "test",
      dimensions: 1,
      embed: vi.fn().mockResolvedValue([[1]]),
    };

    const firstBatch: VectorResult[] = [
      { conversationId: "stale-1", chunkIndex: 0, score: 0.95, text: "stale 1" },
      { conversationId: "stale-2", chunkIndex: 0, score: 0.94, text: "stale 2" },
      { conversationId: "valid-1", chunkIndex: 0, score: 0.93, text: "valid 1" },
      { conversationId: "valid-2", chunkIndex: 0, score: 0.92, text: "valid 2" },
      { conversationId: "valid-3", chunkIndex: 0, score: 0.91, text: "valid 3" },
      { conversationId: "valid-4", chunkIndex: 0, score: 0.90, text: "valid 4" },
      { conversationId: "stale-3", chunkIndex: 0, score: 0.89, text: "stale 3" },
      { conversationId: "stale-4", chunkIndex: 0, score: 0.88, text: "stale 4" },
      { conversationId: "stale-5", chunkIndex: 0, score: 0.87, text: "stale 5" },
      { conversationId: "stale-6", chunkIndex: 0, score: 0.86, text: "stale 6" },
      { conversationId: "stale-7", chunkIndex: 0, score: 0.85, text: "stale 7" },
      { conversationId: "stale-8", chunkIndex: 0, score: 0.84, text: "stale 8" },
      { conversationId: "stale-9", chunkIndex: 0, score: 0.83, text: "stale 9" },
      { conversationId: "stale-10", chunkIndex: 0, score: 0.82, text: "stale 10" },
      { conversationId: "stale-11", chunkIndex: 0, score: 0.81, text: "stale 11" },
    ];
    const secondBatch: VectorResult[] = [
      ...firstBatch,
      { conversationId: "valid-5", chunkIndex: 0, score: 0.89, text: "valid 5" },
      { conversationId: "valid-6", chunkIndex: 0, score: 0.88, text: "valid 6" },
    ];

    const vectorStore: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn()
        .mockResolvedValueOnce(firstBatch)
        .mockResolvedValueOnce(secondBatch),
    };

    const isSearchable = vi.fn(async (conversationId: string) =>
      conversationId.startsWith("valid-"),
    );

    const results = await searchConversations(
      "query",
      5,
      embedding,
      vectorStore,
      undefined,
      undefined,
      isSearchable,
    );

    expect(results.map((r) => r.conversationId)).toEqual([
      "valid-1",
      "valid-2",
      "valid-3",
      "valid-4",
      "valid-5",
    ]);
    expect(vectorStore.query).toHaveBeenNthCalledWith(1, [1], 15);
    expect(vectorStore.query).toHaveBeenNthCalledWith(2, [1], 30);
    expect(isSearchable).toHaveBeenCalledWith("stale-1");
    expect(isSearchable).toHaveBeenCalledWith("valid-5");
  });

  it("reports when the maximum scan window is reached while still scanning for valid results", async () => {
    const embedding: EmbeddingProvider = {
      name: "test",
      dimensions: 1,
      embed: vi.fn().mockResolvedValue([[1]]),
    };

    const raw: VectorResult[] = Array.from({ length: 5001 }, (_, i) => ({
      conversationId: `stale-${i}`,
      chunkIndex: 0,
      score: 1 - i / 10000,
      text: `stale ${i}`,
    }));

    const vectorStore: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn(async (_vector, topK) => raw.slice(0, topK)),
    };

    const onIncompleteResults = vi.fn();
    const results = await searchConversations(
      "query",
      10,
      embedding,
      vectorStore,
      undefined,
      undefined,
      async () => false,
      onIncompleteResults,
    );

    expect(results).toEqual([]);
    expect(onIncompleteResults).toHaveBeenCalledTimes(1);
    expect(vectorStore.query).toHaveBeenLastCalledWith([1], 5000);
    expect(vectorStore.query).toHaveBeenCalledWith([1], 5000);
  });

  it("does not report incomplete results when the cap is reached but enough valid results were found", async () => {
    const embedding: EmbeddingProvider = {
      name: "test",
      dimensions: 1,
      embed: vi.fn().mockResolvedValue([[1]]),
    };

    const raw: VectorResult[] = Array.from({ length: 5000 }, (_, i) => ({
      conversationId: `valid-${i}`,
      chunkIndex: 0,
      score: 1 - i / 10000,
      text: `valid ${i}`,
    }));

    const vectorStore: VectorStore = {
      upsert: vi.fn(),
      delete: vi.fn(),
      query: vi.fn(async (_vector, topK) => raw.slice(0, topK)),
    };

    const onIncompleteResults = vi.fn();
    await searchConversations(
      "query",
      10,
      embedding,
      vectorStore,
      undefined,
      undefined,
      async (conversationId) => conversationId.startsWith("valid-"),
      onIncompleteResults,
    );

    expect(onIncompleteResults).not.toHaveBeenCalled();
  });
});
