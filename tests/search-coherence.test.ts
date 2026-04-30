import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getConversationById, insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  isConversationSearchable,
  markConversationIndexStale,
  tryDeleteConversationVectors,
} from "../src/search/coherence.js";
import { SearchNotConfiguredError, SearchDepsError } from "../src/search/errors.js";
import {
  MAX_SEARCH_SCAN_WINDOW,
  searchConversations,
} from "../src/search/indexer.js";
import type {
  EmbeddingProvider,
  SearchHit,
  VectorStore,
} from "../src/search/types.js";

vi.mock("../src/search/deps.js", async () => {
  return {
    getSearchProviders: vi.fn(),
    searchAvailable: vi.fn(),
    resetSearchProviders: () => undefined,
  };
});

const depsModule = await import("../src/search/deps.js");
const mockedGetSearchProviders = vi.mocked(depsModule.getSearchProviders);
const mockedSearchAvailable = vi.mocked(depsModule.searchAvailable);

describe("isConversationSearchable (SPEC §10.7)", () => {
  it("returns true for a saved conversation with a non-null indexedAt", () => {
    const conversation = makeConversation({
      state: "saved",
      indexedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(isConversationSearchable(conversation)).toBe(true);
  });

  it("returns false when indexedAt is null", () => {
    const conversation = makeConversation({ state: "saved", indexedAt: null });
    expect(isConversationSearchable(conversation)).toBe(false);
  });

  it("returns false when state is not saved, even with a non-null indexedAt", () => {
    const conversation = makeConversation({
      state: "staged",
      indexedAt: "2026-02-01T10:00:00.000Z",
    });
    expect(isConversationSearchable(conversation)).toBe(false);
  });

  it("returns false for null and undefined inputs", () => {
    expect(isConversationSearchable(null)).toBe(false);
    expect(isConversationSearchable(undefined)).toBe(false);
  });
});

describe("markConversationIndexStale (SPEC §10.8.1)", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-coherence-stale-"));
    process.env.CLOG_HOME = tempDir;
    mockedGetSearchProviders.mockReset();
    mockedSearchAvailable.mockReset();
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clears indexedAt for a saved conversation that was previously indexed", async () => {
    const conversation = makeConversation({
      state: "saved",
      indexedAt: "2026-02-01T10:00:00.000Z",
    });
    await insertConversation(conversation);

    const next = await markConversationIndexStale(conversation);
    expect(next.indexedAt).toBeNull();

    const reloaded = await getConversationById(conversation.id);
    expect(reloaded?.indexedAt).toBeNull();
  });

  it("is a no-op when indexedAt is already null", async () => {
    const conversation = makeConversation({ state: "saved", indexedAt: null });
    await insertConversation(conversation);

    const next = await markConversationIndexStale(conversation);
    expect(next).toBe(conversation);

    const reloaded = await getConversationById(conversation.id);
    expect(reloaded?.indexedAt).toBeNull();
  });

  it("is a no-op when the conversation is not saved", async () => {
    const conversation = makeConversation({
      state: "staged",
      indexedAt: "2026-02-01T10:00:00.000Z",
    });
    await insertConversation(conversation);

    const next = await markConversationIndexStale(conversation);
    expect(next).toBe(conversation);

    const reloaded = await getConversationById(conversation.id);
    expect(reloaded?.indexedAt).toBe("2026-02-01T10:00:00.000Z");
  });
});

describe("tryDeleteConversationVectors (SPEC §10.8.1)", () => {
  beforeEach(() => {
    mockedGetSearchProviders.mockReset();
    mockedSearchAvailable.mockReset();
  });

  it("returns an empty array when given no conversation ids", async () => {
    const failures = await tryDeleteConversationVectors([]);
    expect(failures).toEqual([]);
    expect(mockedGetSearchProviders).not.toHaveBeenCalled();
  });

  it("silently returns [] when search is not configured", async () => {
    mockedGetSearchProviders.mockRejectedValue(new SearchNotConfiguredError());

    const failures = await tryDeleteConversationVectors(["abc12345-1111-1111-1111-111111111111"]);

    expect(failures).toEqual([]);
  });

  it("reports all ids as failed when deindex dependencies fail to initialize", async () => {
    mockedGetSearchProviders.mockRejectedValue(new SearchDepsError(["vectra"]));

    const ids = [
      "abc12345-1111-1111-1111-111111111111",
      "def67890-2222-2222-2222-222222222222",
    ];
    const failures = await tryDeleteConversationVectors(ids);

    expect(failures).toEqual(ids);
  });

  it("reports only the ids whose per-conversation delete failed", async () => {
    const deleteMock = vi.fn((id: string) => {
      if (id === "bad-id-2222-2222-2222-222222222222") {
        return Promise.reject(new Error("delete failed"));
      }
      return Promise.resolve();
    });

    mockedGetSearchProviders.mockResolvedValue({
      embedding: makeEmbedding(),
      vectorStore: {
        upsert: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        delete: deleteMock,
      },
    });

    const ids = [
      "good-id1-1111-1111-1111-111111111111",
      "bad-id-2222-2222-2222-222222222222",
      "good-id3-3333-3333-3333-333333333333",
    ];
    const failures = await tryDeleteConversationVectors(ids);

    expect(failures).toEqual(["bad-id-2222-2222-2222-222222222222"]);
    expect(deleteMock).toHaveBeenCalledTimes(3);
  });
});

describe("searchConversations expanding window (SPEC §10.9)", () => {
  it("starts with a small window and doubles until the limit is satisfied", async () => {
    const requestedSizes: number[] = [];
    // MIN_SEARCH_SCORE is 0.15, so score 0.1 is below the threshold and filtered out.
    const lowScore: SearchHit[] = Array.from({ length: 20 }, (_, index) => ({
      id: `conv-low-${index}:0`,
      score: 0.1,
      text: `low ${index}`,
      metadata: { conversationId: `conv-low-${index}` },
    }));
    // Second window is a full 40-entry response that includes enough high-score hits.
    const secondWindow: SearchHit[] = Array.from({ length: 40 }, (_, index) => ({
      id: `conv-high-${index}:0`,
      score: 0.9,
      text: `high ${index}`,
      metadata: { conversationId: `conv-high-${index}` },
    }));

    let callCount = 0;
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async (_embedding, limit) => {
        requestedSizes.push(limit);
        callCount += 1;
        return callCount === 1 ? lowScore : secondWindow;
      }),
    };

    const results = await searchConversations("anything", 5, makeEmbedding(), vectorStore);

    expect(results).toHaveLength(5);
    // First request = max(limit*3, 20) = 20; second request doubles to 40.
    expect(requestedSizes[0]).toBe(20);
    expect(requestedSizes[1]).toBe(40);
  });

  it("stops at the 5,000-entry scan cap and signals incompleteness", async () => {
    const onScanCapReached = vi.fn();
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      // Always return a full window so the loop keeps doubling.
      search: vi.fn(async (_embedding, limit) =>
        Array.from({ length: limit }, (_, index) => ({
          id: `conv-${index}:0`,
          score: 0.1, // Below min; zero valid results.
          text: `chunk ${index}`,
          metadata: { conversationId: `conv-${index}` },
        })),
      ),
    };

    await searchConversations("anything", 10_000, makeEmbedding(), vectorStore, {
      onScanCapReached,
    });

    expect(onScanCapReached).toHaveBeenCalledTimes(1);
    // The last call should have requested exactly MAX_SEARCH_SCAN_WINDOW.
    const lastCall = vi.mocked(vectorStore.search).mock.calls.at(-1);
    expect(lastCall?.[1]).toBe(MAX_SEARCH_SCAN_WINDOW);
  });

  it("does not signal incompleteness when the store runs dry below the cap", async () => {
    const onScanCapReached = vi.fn();
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      // Returns fewer results than requested → stream is exhausted.
      search: vi.fn(async () => []),
    };

    const results = await searchConversations("anything", 10, makeEmbedding(), vectorStore, {
      onScanCapReached,
    });

    expect(results).toEqual([]);
    expect(onScanCapReached).not.toHaveBeenCalled();
  });

  it("does not signal incompleteness when enough valid results are found within the cap", async () => {
    const onScanCapReached = vi.fn();
    const hits: SearchHit[] = Array.from({ length: 20 }, (_, index) => ({
      id: `conv-${index}:0`,
      score: 0.9,
      text: `chunk ${index}`,
      metadata: { conversationId: `conv-${index}` },
    }));
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async () => hits),
    };

    const results = await searchConversations("anything", 5, makeEmbedding(), vectorStore, {
      onScanCapReached,
    });

    expect(results).toHaveLength(5);
    expect(onScanCapReached).not.toHaveBeenCalled();
  });
});

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = "2026-02-01T10:00:00.000Z";
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    sourceId: "aaaaaaaa-1111-2222-3333-444444444444",
    source: "claude-code",
    title: "Test",
    summary: "",
    author: "testuser",
    projectName: "proj",
    projectPath: "/tmp/proj",
    tags: [],
    slug: null,
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "discovered",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}

function makeEmbedding(): EmbeddingProvider {
  return {
    name: "fake",
    dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}
