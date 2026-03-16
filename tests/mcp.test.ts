import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createMinimalJsonl } from "./helpers/fixtures.js";
import { withDb } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";

import { listHandler, getHandler, updateHandler, browseHandler, resourceHandler } from "../src/mcp/handlers.js";

let env: TestEnv;

const CONV_ID = "aaaaaaaa-1111-2222-3333-444444444444";
const CONV_ID2 = "bbbbbbbb-1111-2222-3333-444444444444";

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id: CONV_ID,
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
    state: "published",
    publishedAt: now,
    publishVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

// ── listHandler ─────────────────────────────────────────────────

describe("listHandler", () => {
  it("returns published conversations", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    const result = await listHandler("published", { limit: 20, offset: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].id).toBe(CONV_ID);
    expect(data.totalCount).toBe(1);
  });

  it("returns staged conversations", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    const result = await listHandler("staged", { limit: 20, offset: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(1);
  });

  it("returns empty when no matches", async () => {
    const result = await listHandler("published", { limit: 20, offset: 0 });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(0);
    expect(data.totalCount).toBe(0);
  });

  it("filters by project", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    const result = await listHandler("published", {
      project: "/Users/testuser/projects/webapp",
      limit: 20,
      offset: 0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(1);
  });

  it("filters by tag", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ tags: ["debug", "frontend"] }));
    });

    const result = await listHandler("published", {
      tags: ["debug"],
      limit: 20,
      offset: 0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(1);
  });

  it("filters by multiple tags on same conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ tags: ["debug", "frontend"] }));
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          tags: ["backend"],
        })
      );
    });

    const result = await listHandler("published", {
      tags: ["debug", "frontend"],
      limit: 20,
      offset: 0,
    });
    const data = JSON.parse(result.content[0].text);
    // First tag is used for DB filter, then multi-tag filter keeps conversations with any matching tag
    expect(data.conversations).toHaveLength(1);
    expect(data.conversations[0].id).toBe(CONV_ID);
  });

  it("paginates with limit and offset", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
      ctx.insertConversation(
        makeConversation({ id: CONV_ID2, sourceId: "source-2" })
      );
    });

    const page1 = await listHandler("published", { limit: 1, offset: 0 });
    const data1 = JSON.parse(page1.content[0].text);
    expect(data1.conversations).toHaveLength(1);
    expect(data1.totalCount).toBe(2);

    const page2 = await listHandler("published", { limit: 1, offset: 1 });
    const data2 = JSON.parse(page2.content[0].text);
    expect(data2.conversations).toHaveLength(1);
  });

  it("filters by grep", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ title: "Fix login CSS" }));
    });

    const result = await listHandler("published", {
      grep: "login",
      limit: 20,
      offset: 0,
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversations).toHaveLength(1);
  });

  it("filters by origin", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          origin: "team",
          author: "other",
        })
      );
    });

    const local = await listHandler("published", {
      origin: "local",
      limit: 20,
      offset: 0,
    });
    expect(JSON.parse(local.content[0].text).conversations).toHaveLength(1);

    const remote = await listHandler("published", {
      origin: "remote",
      limit: 20,
      offset: 0,
    });
    expect(JSON.parse(remote.content[0].text).conversations).toHaveLength(1);
  });
});

// ── getHandler ──────────────────────────────────────────────────

describe("getHandler", () => {
  it("returns conversation with messages", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID, userMessage: "Hello" })
    );

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "staged",
          sourcePath: sourceFile,
          filePath: sourceFile,
        })
      );
    });

    const result = await getHandler({ id: CONV_ID.slice(0, 8), maxMessages: 20 });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.id).toBe(CONV_ID);
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("throws for not-found conversation", async () => {
    await expect(
      getHandler({ id: "zzzz1111", maxMessages: 20 })
    ).rejects.toThrow(/No conversation found/);
  });

  it("returns error for discovered conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "discovered" }));
    });

    const result = await getHandler({ id: CONV_ID.slice(0, 8), maxMessages: 20 });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("discovered");
  });

  it("truncates messages when exceeding maxMessages", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID, hasToolUse: true })
    );

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "staged",
          sourcePath: sourceFile,
          filePath: sourceFile,
        })
      );
    });

    const result = await getHandler({ id: CONV_ID.slice(0, 8), maxMessages: 1 });
    const data = JSON.parse(result.content[0].text);
    expect(data.truncated).toBe(true);
    expect(data.messages).toHaveLength(1);
  });
});

// ── updateHandler ───────────────────────────────────────────────

describe("updateHandler", () => {
  it("updates title and summary", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    const result = await updateHandler({
      id: CONV_ID.slice(0, 8),
      title: "New title",
      summary: "New summary",
    });
    expect(result.isError).toBeUndefined();
    const data = JSON.parse(result.content[0].text);
    expect(data.conversation.title).toBe("New title");
    expect(data.conversation.summary).toBe("New summary");
  });

  it("adds and removes tags", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", tags: ["existing"] })
      );
    });

    const result = await updateHandler({
      id: CONV_ID.slice(0, 8),
      addTags: ["new-tag"],
      removeTags: ["existing"],
    });
    const data = JSON.parse(result.content[0].text);
    expect(data.conversation.tags).toContain("new-tag");
    expect(data.conversation.tags).not.toContain("existing");
  });

  it("returns error for not-found conversation", async () => {
    const result = await updateHandler({
      id: "zzzz1111",
      title: "x",
    });
    expect(result.isError).toBe(true);
  });

  it("returns error for discovered conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "discovered" }));
    });

    const result = await updateHandler({
      id: CONV_ID.slice(0, 8),
      title: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("discovered");
  });

  it("returns error for remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "team" })
      );
    });

    const result = await updateHandler({
      id: CONV_ID.slice(0, 8),
      title: "x",
    });
    expect(result.isError).toBe(true);
    expect(result.content[0].text).toContain("remote");
  });

  it("clears indexedAt when editing published+indexed conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "published",
          indexedAt: new Date().toISOString(),
        })
      );
    });

    await updateHandler({
      id: CONV_ID.slice(0, 8),
      title: "Updated",
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.indexedAt).toBeNull();
    });
  });
});

// ── browseHandler ───────────────────────────────────────────────

describe("browseHandler", () => {
  it("browses tags", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ tags: ["debug", "frontend"] })
      );
    });

    const result = await browseHandler({ by: "tags" });
    const data = JSON.parse(result.content[0].text);
    expect(data.items.length).toBeGreaterThan(0);
  });

  it("browses projects", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    const result = await browseHandler({ by: "projects" });
    const data = JSON.parse(result.content[0].text);
    expect(data.items.length).toBeGreaterThan(0);
  });

  it("browses authors", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    const result = await browseHandler({ by: "authors" });
    const data = JSON.parse(result.content[0].text);
    expect(data.items.length).toBeGreaterThan(0);
  });

  it("returns empty for no published conversations", async () => {
    const result = await browseHandler({ by: "tags" });
    const data = JSON.parse(result.content[0].text);
    expect(data.items).toHaveLength(0);
  });
});

// ── resourceHandler ─────────────────────────────────────────────

describe("resourceHandler", () => {
  it("returns conversation with messages", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID })
    );

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          sourcePath: sourceFile,
          filePath: sourceFile,
        })
      );
    });

    const result = await resourceHandler(CONV_ID.slice(0, 8), "clog://conversations/" + CONV_ID);
    const text = result.contents[0].text;
    const data = JSON.parse(text);
    expect(data.id).toBe(CONV_ID);
    expect(data.messages.length).toBeGreaterThan(0);
  });

  it("returns error for not-found conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    // staged, not published — should return error
    const result = await resourceHandler(CONV_ID.slice(0, 8), "clog://test");
    const data = JSON.parse(result.contents[0].text);
    expect(data.error).toBeDefined();
  });
});
