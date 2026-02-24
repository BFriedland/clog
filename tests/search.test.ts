import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { withDb } from "../src/db/index.js";
import { resetSearchProviders } from "../src/search/deps.js";
import { checkPackages } from "../src/search/providers.js";
import { indexConversation, searchConversations } from "../src/search/indexer.js";
import { resetVectraIndex } from "../src/search/vectorstores/vectra.js";
import type { ConversationMeta, Message } from "../src/models/conversation.js";
import { saveConfig, loadConfig } from "../src/config/schema.js";

// Check if the optional search packages are importable (not if config exists)
const hasSearchDeps = await checkPackages(["vectra", "@huggingface/transformers"]);

function makeConversation(
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    sourceId: "aaaaaaaa-1111-2222-3333-444444444444",
    source: "claude-code",
    title: "Debug JWT refresh race condition",
    summary: "Walked through a race condition in token refresh logic",
    author: "testuser",
    project: "/Users/testuser/projects/api-service",
    tags: ["auth", "debugging"],
    slug: "happy-testing-pony",
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "published",
    publishedAt: now,
    publishVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/raw.jsonl",
    sourceMtime: now,
    indexedAt: null,
    ...overrides,
  };
}

function makeMessages(): Message[] {
  return [
    {
      role: "user",
      content:
        "I'm getting a race condition in the JWT token refresh. When two requests fire at the same time, both try to refresh the token.",
      timestamp: "2026-02-20T10:00:00Z",
    },
    {
      role: "assistant",
      content:
        "Let me look at the token refresh logic. The issue is likely that there's no mutex or lock around the refresh operation.",
      timestamp: "2026-02-20T10:00:01Z",
    },
    {
      role: "tool_use",
      content: "Read: src/auth/token.ts",
      timestamp: "2026-02-20T10:00:02Z",
      toolName: "Read",
    },
    {
      role: "tool_result",
      content: "Read: ok",
      timestamp: "2026-02-20T10:00:03Z",
      toolName: "Read",
    },
    {
      role: "assistant",
      content:
        "I see the issue. The refreshToken function doesn't check if a refresh is already in progress. We need to add a promise-based lock so that concurrent callers wait for the first refresh to complete.",
      timestamp: "2026-02-20T10:00:04Z",
    },
  ];
}

describe.skipIf(!hasSearchDeps)("search integration", () => {
  let env: TestEnv;

  beforeEach(async () => {
    env = await createTestEnv();
    resetSearchProviders();
    resetVectraIndex();

    // Configure search in the test environment
    const config = await loadConfig();
    config.search = {
      embedding: { type: "transformers" as const, model: "Xenova/all-MiniLM-L6-v2" },
      vectorStore: { type: "vectra" as const },
    };
    await saveConfig(config);
  });

  afterEach(async () => {
    resetSearchProviders();
    resetVectraIndex();
    // Note: TransformersEmbedding has a module-level pipeline singleton that
    // is NOT reset here. This is fine as long as all tests use the same model.
    // If tests ever need to swap models, add a resetTransformersPipeline().
    await env.cleanup();
  });

  it("indexes a conversation and finds it by search", async () => {
    const conv = makeConversation();
    const messages = makeMessages();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
    });

    const { embedding, vectorStore } = await (
      await import("../src/search/deps.js")
    ).getSearchProviders();

    const chunkCount = await indexConversation(
      conv,
      messages,
      embedding,
      vectorStore,
    );
    expect(chunkCount).toBeGreaterThan(0);

    // Search for the conversation
    const results = await searchConversations(
      "JWT token refresh race condition",
      5,
      embedding,
      vectorStore,
    );

    expect(results.length).toBeGreaterThan(0);
    expect(results[0].conversationId).toBe(conv.id);
    expect(results[0].score).toBeGreaterThan(0);
    expect(results[0].text.length).toBeGreaterThan(0);
  }, 60_000); // Model download can take a while on first run

  it("deduplicates results to one per conversation", async () => {
    const conv = makeConversation();
    const messages = makeMessages();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
    });

    const { embedding, vectorStore } = await (
      await import("../src/search/deps.js")
    ).getSearchProviders();

    await indexConversation(conv, messages, embedding, vectorStore);

    // Search should return at most one result per conversation
    const results = await searchConversations(
      "JWT",
      10,
      embedding,
      vectorStore,
    );

    const convIds = results.map((r) => r.conversationId);
    const uniqueIds = new Set(convIds);
    expect(convIds.length).toBe(uniqueIds.size);
  }, 60_000);

  it("filters by conversation ID set", async () => {
    const conv1 = makeConversation({ id: "aaaa0001-0000-0000-0000-000000000000" });
    const conv2 = makeConversation({
      id: "aaaa0002-0000-0000-0000-000000000000",
      title: "Set up rate limiting middleware",
      summary: "Added rate limiting to API endpoints",
    });

    const messages1 = makeMessages();
    const messages2: Message[] = [
      {
        role: "user",
        content: "Add rate limiting to the API",
        timestamp: "2026-02-20T10:00:00Z",
      },
      {
        role: "assistant",
        content: "I'll add express-rate-limit middleware to the API routes.",
        timestamp: "2026-02-20T10:00:01Z",
      },
    ];

    await withDb((ctx) => {
      ctx.insertConversation(conv1);
      ctx.insertConversation(conv2);
    });

    const { embedding, vectorStore } = await (
      await import("../src/search/deps.js")
    ).getSearchProviders();

    await indexConversation(conv1, messages1, embedding, vectorStore);
    await indexConversation(conv2, messages2, embedding, vectorStore);

    // Search with filter restricting to conv2 only
    const filter = new Set([conv2.id]);
    const results = await searchConversations(
      "rate limiting",
      5,
      embedding,
      vectorStore,
      filter,
    );

    // Should only find conv2, not conv1
    for (const r of results) {
      expect(r.conversationId).toBe(conv2.id);
    }
  }, 60_000);

  it("re-indexes after delete + re-insert", async () => {
    const conv = makeConversation();
    const messages = makeMessages();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
    });

    const { embedding, vectorStore } = await (
      await import("../src/search/deps.js")
    ).getSearchProviders();

    // Index, then re-index (indexConversation deletes existing chunks first)
    await indexConversation(conv, messages, embedding, vectorStore);
    const chunkCount = await indexConversation(
      conv,
      messages,
      embedding,
      vectorStore,
    );
    expect(chunkCount).toBeGreaterThan(0);

    // Should still be searchable
    const results = await searchConversations(
      "JWT refresh",
      5,
      embedding,
      vectorStore,
    );
    expect(results.length).toBeGreaterThan(0);
  }, 60_000);
});
