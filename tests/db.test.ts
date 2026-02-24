import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { withDb } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    sourceId: "source-1",
    source: "claude-code",
    title: "Test conversation",
    summary: "A test summary",
    author: "testuser",
    project: "/Users/testuser/projects/webapp",
    tags: ["debug"],
    slug: "happy-testing-pony",
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "discovered",
    publishedAt: null,
    publishVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    ...overrides,
  };
}

describe("Schema creation", () => {
  it("is idempotent (call withDb twice)", async () => {
    await withDb((ctx) => {
      const counts = ctx.getCountsByState();
      expect(counts.discovered).toBe(0);
    });

    // Second call opens the same DB file and runs migrate again
    await withDb((ctx) => {
      const counts = ctx.getCountsByState();
      expect(counts.discovered).toBe(0);
    });
  });
});

describe("Insert + get conversation round-trip", () => {
  it("inserts and retrieves a conversation", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const fetched = ctx.getConversation(conv.id);
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(conv.id);
      expect(fetched!.title).toBe(conv.title);
      expect(fetched!.summary).toBe(conv.summary);
      expect(fetched!.author).toBe(conv.author);
      expect(fetched!.project).toBe(conv.project);
      expect(fetched!.tags).toEqual(conv.tags);
      expect(fetched!.slug).toBe(conv.slug);
      expect(fetched!.state).toBe("discovered");
      expect(fetched!.publishVersion).toBe(0);
    });
  });

  it("returns null for non-existent conversation", async () => {
    await withDb((ctx) => {
      const fetched = ctx.getConversation("nonexistent-id");
      expect(fetched).toBeNull();
    });
  });

  it("getConversationBySourceId works", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const fetched = ctx.getConversationBySourceId("claude-code", "source-1");
      expect(fetched).not.toBeNull();
      expect(fetched!.id).toBe(conv.id);
    });
  });
});

describe("resolveId", () => {
  it("resolves exact match", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const resolved = ctx.resolveId(conv.id);
      expect(resolved).toBe(conv.id);
    });
  });

  it("resolves prefix match (4+ chars)", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const resolved = ctx.resolveId("aaaa");
      expect(resolved).toBe(conv.id);
    });
  });

  it("throws on ambiguous prefix", async () => {
    const conv1 = makeConversation({ id: "aaaa1111-0000-0000-0000-000000000000", sourceId: "s1" });
    const conv2 = makeConversation({ id: "aaaa2222-0000-0000-0000-000000000000", sourceId: "s2" });

    await withDb((ctx) => {
      ctx.insertConversation(conv1);
      ctx.insertConversation(conv2);
      expect(() => ctx.resolveId("aaaa")).toThrow(/Ambiguous prefix/);
    });
  });

  it("throws on too-short prefix (< 4 chars)", async () => {
    await withDb((ctx) => {
      expect(() => ctx.resolveId("abc")).toThrow(/too short/);
    });
  });

  it("throws on no match", async () => {
    await withDb((ctx) => {
      expect(() => ctx.resolveId("zzzz")).toThrow(/No conversation found/);
    });
  });
});

describe("listConversations with filters", () => {
  async function insertTestSet() {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0000-0000-0000-0000-000000000001",
          sourceId: "s1",
          state: "discovered",
          project: "/project-a",
          tags: ["bug", "frontend"],
          title: "Fix login CSS",
          summary: "CSS debugging",
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0000-0000-0000-0000-000000000002",
          sourceId: "s2",
          state: "staged",
          project: "/project-b",
          tags: ["feature"],
          title: "Add authentication",
          summary: "Auth middleware",
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "cccc0000-0000-0000-0000-000000000003",
          sourceId: "s3",
          state: "published",
          project: "/project-a",
          tags: ["bug"],
          title: "Database migration fix",
          summary: "Migration script",
        })
      );
    });
  }

  it("filters by state", async () => {
    await insertTestSet();

    await withDb((ctx) => {
      const discovered = ctx.listConversations({ state: "discovered" });
      expect(discovered).toHaveLength(1);
      expect(discovered[0].id).toBe("aaaa0000-0000-0000-0000-000000000001");

      const staged = ctx.listConversations({ state: "staged" });
      expect(staged).toHaveLength(1);
      expect(staged[0].id).toBe("bbbb0000-0000-0000-0000-000000000002");
    });
  });

  it("filters by project", async () => {
    await insertTestSet();

    await withDb((ctx) => {
      const projectA = ctx.listConversations({ project: "/project-a" });
      expect(projectA).toHaveLength(2);
    });
  });

  it("filters by tag", async () => {
    await insertTestSet();

    await withDb((ctx) => {
      const bugs = ctx.listConversations({ tag: "bug" });
      expect(bugs).toHaveLength(2);

      const frontend = ctx.listConversations({ tag: "frontend" });
      expect(frontend).toHaveLength(1);
    });
  });

  it("filters by grep (title or summary)", async () => {
    await insertTestSet();

    await withDb((ctx) => {
      const loginResults = ctx.listConversations({ grep: "login" });
      expect(loginResults).toHaveLength(1);
      expect(loginResults[0].title).toContain("login");

      const migrationResults = ctx.listConversations({ grep: "Migration" });
      expect(migrationResults).toHaveLength(1);
    });
  });

  it("returns all conversations when no filters given", async () => {
    await insertTestSet();

    await withDb((ctx) => {
      const all = ctx.listConversations();
      expect(all).toHaveLength(3);
    });
  });
});

describe("State transitions", () => {
  it("updates state from discovered to staged", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, { state: "staged" });

      const updated = ctx.getConversation(conv.id);
      expect(updated!.state).toBe("staged");
    });
  });

  it("updates state from staged to published with version", async () => {
    const conv = makeConversation({ state: "staged" });
    const publishedAt = new Date().toISOString();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        state: "published",
        publishVersion: 1,
        publishedAt,
      });

      const updated = ctx.getConversation(conv.id);
      expect(updated!.state).toBe("published");
      expect(updated!.publishVersion).toBe(1);
      expect(updated!.publishedAt).toBe(publishedAt);
    });
  });
});

describe("getCountsByState", () => {
  it("returns correct counts", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ id: "a1000000-0000-0000-0000-000000000000", sourceId: "s1", state: "discovered" })
      );
      ctx.insertConversation(
        makeConversation({ id: "b1000000-0000-0000-0000-000000000000", sourceId: "s2", state: "discovered" })
      );
      ctx.insertConversation(
        makeConversation({ id: "c1000000-0000-0000-0000-000000000000", sourceId: "s3", state: "staged" })
      );
      ctx.insertConversation(
        makeConversation({ id: "d1000000-0000-0000-0000-000000000000", sourceId: "s4", state: "published" })
      );

      const counts = ctx.getCountsByState();
      expect(counts.discovered).toBe(2);
      expect(counts.staged).toBe(1);
      expect(counts.published).toBe(1);
    });
  });

  it("returns zeros when empty", async () => {
    await withDb((ctx) => {
      const counts = ctx.getCountsByState();
      expect(counts.discovered).toBe(0);
      expect(counts.staged).toBe(0);
      expect(counts.published).toBe(0);
    });
  });
});

describe("Publish log", () => {
  it("insertPublishLogEntry + getPublishLog round-trip", async () => {
    const conv = makeConversation();
    const publishedAt = new Date().toISOString();

    await withDb((ctx) => {
      ctx.insertConversation(conv);

      ctx.insertPublishLogEntry({
        conversationId: conv.id,
        version: 1,
        publishedAt,
        author: "testuser",
        message: "Initial publish",
      });

      const log = ctx.getPublishLog();
      expect(log).toHaveLength(1);
      expect(log[0].conversationId).toBe(conv.id);
      expect(log[0].version).toBe(1);
      expect(log[0].author).toBe("testuser");
      expect(log[0].message).toBe("Initial publish");
      expect(log[0].title).toBe(conv.title);
    });
  });

  it("getPublishLog returns entries in descending order", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);

      ctx.insertPublishLogEntry({
        conversationId: conv.id,
        version: 1,
        publishedAt: "2026-01-01T00:00:00.000Z",
        author: "testuser",
        message: "First",
      });
      ctx.insertPublishLogEntry({
        conversationId: conv.id,
        version: 2,
        publishedAt: "2026-02-01T00:00:00.000Z",
        author: "testuser",
        message: "Second",
      });

      const log = ctx.getPublishLog();
      expect(log).toHaveLength(2);
      expect(log[0].version).toBe(2);
      expect(log[1].version).toBe(1);
    });
  });
});
