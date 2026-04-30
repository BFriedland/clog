import { describe, expect, it, vi } from "vitest";

import type { ConversationMeta, Message } from "../src/models/conversation.js";
import { indexConversation, searchConversations } from "../src/search/indexer.js";
import type { EmbeddingProvider, IndexedChunk, SearchHit, VectorStore } from "../src/search/types.js";

describe("search indexer", () => {
  it("indexes conversation chunks into the vector store", async () => {
    const upsert = vi.fn(async () => undefined);
    const remove = vi.fn(async () => undefined);
    const embedding: EmbeddingProvider = {
      name: "fake",
      dimensions: 3,
      embed: vi.fn(async (texts: string[]) => texts.map(() => [1, 2, 3])),
    };
    const vectorStore: VectorStore = {
      upsert,
      search: vi.fn(async () => []),
      delete: remove,
    };

    const chunkCount = await indexConversation(
      makeConversation(),
      makeMessages(),
      embedding,
      vectorStore,
    );

    expect(remove).toHaveBeenCalledWith("abc12345-1234-1234-1234-123456789012");
    expect(upsert).toHaveBeenCalledTimes(1);
    expect(chunkCount).toBeGreaterThan(0);
    expect(upsert.mock.calls[0]?.[0]).toBe("abc12345-1234-1234-1234-123456789012");
    expect((upsert.mock.calls[0]?.[1] as IndexedChunk[])[0]?.text).toContain("Title:");
  });

  it("deduplicates hits by conversation and filters by searchability", async () => {
    const embedding: EmbeddingProvider = {
      name: "fake",
      dimensions: 3,
      embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    };
    const hits: SearchHit[] = [
      {
        id: "conv-a:0",
        score: 0.9,
        text: "chunk one",
        metadata: { conversationId: "conv-a" },
      },
      {
        id: "conv-a:1",
        score: 0.7,
        text: "chunk two",
        metadata: { conversationId: "conv-a" },
      },
      {
        id: "conv-b:0",
        score: 0.8,
        text: "chunk three",
        metadata: { conversationId: "conv-b" },
      },
    ];
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async () => hits),
    };

    const results = await searchConversations("auth", 10, embedding, vectorStore, {
      isConversationSearchable: async (conversationId) => conversationId !== "conv-b",
    });

    expect(results).toHaveLength(1);
    expect(results[0]?.conversationId).toBe("conv-a");
    expect(results[0]?.text).toBe("chunk one");
  });

  it("reports scan-cap incompleteness when the vector store keeps returning a full window", async () => {
    const embedding: EmbeddingProvider = {
      name: "fake",
      dimensions: 3,
      embed: vi.fn(async () => [[0.1, 0.2, 0.3]]),
    };
    const vectorStore: VectorStore = {
      upsert: vi.fn(async () => undefined),
      delete: vi.fn(async () => undefined),
      search: vi.fn(async (_embedding, limit) =>
        Array.from({ length: limit }, (_, index) => ({
          id: `conv-${index}:0`,
          score: 0.2,
          text: `chunk ${index}`,
          metadata: { conversationId: `conv-${index}` },
        })),
      ),
    };

    let warned = false;
    await searchConversations("auth", 6000, embedding, vectorStore, {
      onScanCapReached: () => {
        warned = true;
      },
      isConversationSearchable: () => false,
    });

    expect(warned).toBe(true);
  });
});

function makeConversation(): ConversationMeta {
  return {
    id: "abc12345-1234-1234-1234-123456789012",
    sourceId: "abc12345-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Debug auth",
    summary: "Session refresh issue",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: ["auth"],
    slug: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    discoveredAt: "2026-02-01T10:00:00.000Z",
    modifiedAt: "2026-02-01T10:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-01T10:00:00.000Z",
    savedMessageCount: 2,
    saveVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/raw.jsonl",
    sourceMtime: null,
    indexedAt: null,
    origin: null,
  };
}

function makeMessages(): Message[] {
  return [
    { role: "user", content: "How did we fix auth?", timestamp: null },
    { role: "assistant", content: "We refreshed the token and retried.", timestamp: null },
  ];
}
