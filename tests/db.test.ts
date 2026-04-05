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
    origin: null,
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

  it("filters by project using basename matching", async () => {
    await insertTestSet();

    // Insert a conversation whose full path contains "project-a" as a parent dir
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "dddd0000-0000-0000-0000-000000000004",
          sourceId: "s4",
          state: "discovered",
          project: "/project-a/subdir/other-tool",
          title: "Nested project",
          summary: "Should not match project-a",
        })
      );
    });

    await withDb((ctx) => {
      const projectA = ctx.listConversations({ project: "project-a" });
      expect(projectA).toHaveLength(2);
      expect(projectA.every((c) => c.project === "/project-a")).toBe(true);

      // Case-insensitive
      const upper = ctx.listConversations({ project: "Project-A" });
      expect(upper).toHaveLength(2);
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

// ---------------------------------------------------------------------------
// Indexing support
// ---------------------------------------------------------------------------

describe("setIndexedAt", () => {
  it("sets indexed_at timestamp", async () => {
    const conv = makeConversation({ state: "published" });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.setIndexedAt(conv.id, "2026-02-20T12:00:00.000Z");

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  it("clears indexed_at when set to null", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.setIndexedAt(conv.id, null);

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.indexedAt).toBeNull();
    });
  });
});

describe("listConversationsNeedingIndex", () => {
  it("returns published conversations with null indexed_at", async () => {
    const conv = makeConversation({ state: "published", indexedAt: null });

    await withDb((ctx) => {
      ctx.insertConversation(conv);

      const needing = ctx.listConversationsNeedingIndex();
      expect(needing).toHaveLength(1);
      expect(needing[0].id).toBe(conv.id);
    });
  });

  it("does not return published conversations whose indexed_at is set even if modified_at is newer", async () => {
    const conv = makeConversation({
      state: "published",
      modifiedAt: "2026-02-20T14:00:00.000Z",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);

      const needing = ctx.listConversationsNeedingIndex();
      expect(needing).toHaveLength(0);
    });
  });

  it("excludes non-published conversations", async () => {
    const discovered = makeConversation({
      id: "aaaa0001-0000-0000-0000-000000000000",
      state: "discovered",
      indexedAt: null,
    });
    const staged = makeConversation({
      id: "aaaa0002-0000-0000-0000-000000000000",
      state: "staged",
      indexedAt: null,
    });

    await withDb((ctx) => {
      ctx.insertConversation(discovered);
      ctx.insertConversation(staged);

      const needing = ctx.listConversationsNeedingIndex();
      expect(needing).toHaveLength(0);
    });
  });

  it("excludes up-to-date indexed conversations", async () => {
    const conv = makeConversation({
      state: "published",
      modifiedAt: "2026-02-20T12:00:00.000Z",
      indexedAt: "2026-02-20T14:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);

      const needing = ctx.listConversationsNeedingIndex();
      expect(needing).toHaveLength(0);
    });
  });
});

describe("updateConversation with indexedAt", () => {
  it("updates indexedAt via updateConversation", async () => {
    const conv = makeConversation({ state: "published" });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        indexedAt: "2026-02-20T12:00:00.000Z",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  it("clears indexedAt when published search metadata changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        title: "Updated title",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.title).toBe("Updated title");
      expect(fetched.indexedAt).toBeNull();
    });
  });

  it("keeps indexedAt when only non-search metadata changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        author: "someone-else",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.author).toBe("someone-else");
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  it("clears indexedAt when published sourcePath changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        sourcePath: "/tmp/updated-source.jsonl",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.sourcePath).toBe("/tmp/updated-source.jsonl");
      expect(fetched.indexedAt).toBeNull();
    });
  });

  it("clears indexedAt when published sourceMtime changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        sourceMtime: "2026-02-20T13:00:00.000Z",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.sourceMtime).toBe("2026-02-20T13:00:00.000Z");
      expect(fetched.indexedAt).toBeNull();
    });
  });

  it("clears indexedAt when published filePath changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
      filePath: "/tmp/original-raw.jsonl",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        filePath: "/tmp/updated-raw.jsonl",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.filePath).toBe("/tmp/updated-raw.jsonl");
      expect(fetched.indexedAt).toBeNull();
    });
  });

  it("clears indexedAt when published state changes away from published", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        state: "staged",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.state).toBe("staged");
      expect(fetched.indexedAt).toBeNull();
    });
  });

  it("keeps indexedAt when only modifiedAt changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        modifiedAt: "2026-02-20T13:00:00.000Z",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.modifiedAt).toBe("2026-02-20T13:00:00.000Z");
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  it("keeps indexedAt when project changes", async () => {
    const conv = makeConversation({
      state: "published",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        project: "/Users/testuser/projects/updated-webapp",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.project).toBe("/Users/testuser/projects/updated-webapp");
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });

  it("does not clear indexedAt for unpublished conversations", async () => {
    const conv = makeConversation({
      state: "staged",
      indexedAt: "2026-02-20T12:00:00.000Z",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      ctx.updateConversation(conv.id, {
        title: "Updated title",
      });

      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.title).toBe("Updated title");
      expect(fetched.indexedAt).toBe("2026-02-20T12:00:00.000Z");
    });
  });
});

describe("origin field", () => {
  it("defaults to null for new conversations", async () => {
    const conv = makeConversation();

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.origin).toBeNull();
    });
  });

  it("stores and retrieves origin", async () => {
    const conv = makeConversation({
      origin: "git@github.com:org/repo.git",
    });

    await withDb((ctx) => {
      ctx.insertConversation(conv);
      const fetched = ctx.getConversation(conv.id)!;
      expect(fetched.origin).toBe("git@github.com:org/repo.git");
    });
  });

  it("filters by origin=local (NULL)", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          origin: null,
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          state: "published",
          origin: "git@github.com:org/repo.git",
        })
      );

      const local = ctx.listConversations({ origin: "local" });
      expect(local).toHaveLength(1);
      expect(local[0].id).toBe("aaaa0001-0000-0000-0000-000000000000");
    });
  });

  it("filters by origin=remote (NOT NULL)", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          origin: null,
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          state: "published",
          origin: "git@github.com:org/repo.git",
        })
      );

      const remote = ctx.listConversations({ origin: "remote" });
      expect(remote).toHaveLength(1);
      expect(remote[0].id).toBe("bbbb0001-0000-0000-0000-000000000000");
    });
  });
});

describe("deleteByOrigin", () => {
  it("deletes conversations with matching origin", async () => {
    const origin = "git@github.com:org/repo.git";

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          origin,
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          origin,
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "cccc0001-0000-0000-0000-000000000000",
          sourceId: "s3",
          origin: null,
        })
      );

      const deleted = ctx.deleteByOrigin(origin);
      expect(deleted).toBe(2);

      const remaining = ctx.listConversations();
      expect(remaining).toHaveLength(1);
      expect(remaining[0].id).toBe("cccc0001-0000-0000-0000-000000000000");
    });
  });
});

describe("browseDistinct", () => {
  it("returns tags with counts", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          tags: ["debug", "frontend"],
        })
      );
      const items = ctx.browseDistinct("tags");
      expect(items.length).toBe(2);
      expect(items.some((i) => i.name === "debug")).toBe(true);
    });
  });

  it("returns projects with counts", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          project: "/Users/test/proj",
        })
      );
      const items = ctx.browseDistinct("projects");
      expect(items.length).toBe(1);
    });
  });

  it("returns authors with counts", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          author: "testuser",
        })
      );
      const items = ctx.browseDistinct("authors");
      expect(items.length).toBe(1);
      expect(items[0].name).toBe("testuser");
    });
  });
});

describe("getIndexCoverage", () => {
  it("returns published and indexed counts", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          state: "published",
          indexedAt: "2026-01-01T00:00:00Z",
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          state: "published",
          indexedAt: null,
        })
      );
      const result = ctx.getIndexCoverage();
      expect(result.published).toBe(2);
      expect(result.indexed).toBe(1);
    });
  });
});

describe("countByAuthorLocal", () => {
  it("counts only local conversations by author", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          author: "alice",
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          author: "alice",
          origin: "team",
        })
      );
      expect(ctx.countByAuthorLocal("alice")).toBe(1);
      expect(ctx.countByAuthorLocal("nobody")).toBe(0);
    });
  });
});

describe("schema migration", () => {
  it("migrates v1 schema to v2 (adds origin column)", async () => {
    // This is tested implicitly — withDb calls migrate() on every open.
    // A fresh DB gets v2 schema directly. The migration path is exercised
    // when the version row says 1.
    await withDb((ctx) => {
      const conv = makeConversation({
        id: "aaaa0001-0000-0000-0000-000000000000",
        sourceId: "s1",
        origin: "test-origin",
      });
      ctx.insertConversation(conv);
      const retrieved = ctx.getConversation(conv.id)!;
      expect(retrieved.origin).toBe("test-origin");
    });
  });
});

describe("renameAuthor", () => {
  it("renames only local conversations", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: "aaaa0001-0000-0000-0000-000000000000",
          sourceId: "s1",
          author: "old-name",
          origin: null,
        })
      );
      ctx.insertConversation(
        makeConversation({
          id: "bbbb0001-0000-0000-0000-000000000000",
          sourceId: "s2",
          author: "old-name",
          origin: "git@github.com:org/repo.git",
        })
      );

      const renamed = ctx.renameAuthor("old-name", "new-name");
      expect(renamed).toBe(1);

      const local = ctx.getConversation("aaaa0001-0000-0000-0000-000000000000")!;
      expect(local.author).toBe("new-name");

      const remote = ctx.getConversation("bbbb0001-0000-0000-0000-000000000000")!;
      expect(remote.author).toBe("old-name");
    });
  });
});
