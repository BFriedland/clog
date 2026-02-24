import path from "node:path";
import { mkdir, writeFile, access, copyFile } from "node:fs/promises";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createMinimalJsonl } from "./helpers/fixtures.js";
import { withDb } from "../src/db/index.js";
import { saveConfig, defaultConfig } from "../src/config/schema.js";
import { getRawDir } from "../src/config/index.js";
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
    tags: [],
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

describe("Full add -> edit -> tag -> publish workflow", () => {
  it("progresses through the complete lifecycle", async () => {
    // Setup: create a source file and insert a discovered conversation
    const sourceDir = path.join(env.clogHome, "sources");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "test-session.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: "test-session", userMessage: "Hello world" })
    );

    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);

    const convId = "aaaaaaaa-1111-2222-3333-444444444444";

    // Insert a discovered conversation
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourcePath: sourceFile,
        })
      );
    });

    // Step 1: Add (stage) the conversation
    const rawDir = path.join(getRawDir(), "claude-code");
    await mkdir(rawDir, { recursive: true });

    // Copy file outside withDb since copyFile is async
    const destPath = path.join(rawDir, `${convId}.jsonl`);
    await copyFile(sourceFile, destPath);

    await withDb((ctx) => {
      ctx.updateConversation(convId, {
        state: "staged",
        filePath: destPath,
        modifiedAt: new Date().toISOString(),
      });
    });

    // Verify staged
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.state).toBe("staged");
      expect(conv.filePath).toBeTruthy();
    });

    // Step 2: Edit title and summary
    await withDb((ctx) => {
      ctx.updateConversation(convId, {
        title: "Updated title",
        summary: "Updated summary",
        modifiedAt: new Date().toISOString(),
      });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.title).toBe("Updated title");
      expect(conv.summary).toBe("Updated summary");
    });

    // Step 3: Tag
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const normalized = ["debug", "frontend"];
      const existing = new Set(conv.tags);
      for (const tag of normalized) {
        existing.add(tag);
      }
      ctx.updateConversation(convId, {
        tags: [...existing],
        modifiedAt: new Date().toISOString(),
      });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.tags).toContain("debug");
      expect(conv.tags).toContain("frontend");
    });

    // Step 4: Publish
    const publishedAt = new Date().toISOString();
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const newVersion = conv.publishVersion + 1;

      ctx.updateConversation(convId, {
        state: "published",
        publishVersion: newVersion,
        publishedAt,
        modifiedAt: publishedAt,
      });

      ctx.insertPublishLogEntry({
        conversationId: convId,
        version: newVersion,
        publishedAt,
        author: "testuser",
        message: "Initial publish",
      });
    });

    // Verify final state
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.state).toBe("published");
      expect(conv.publishVersion).toBe(1);
      expect(conv.publishedAt).toBe(publishedAt);
      expect(conv.title).toBe("Updated title");
      expect(conv.tags).toEqual(["debug", "frontend"]);

      const log = ctx.getPublishLog();
      expect(log).toHaveLength(1);
      expect(log[0].message).toBe("Initial publish");
    });
  });
});

describe("Add copies file to raw dir", () => {
  it("copies the source file to the raw directory", async () => {
    const sourceDir = path.join(env.clogHome, "sources");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "session-copy.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: "session-copy" })
    );

    const rawDir = path.join(getRawDir(), "claude-code");
    await mkdir(rawDir, { recursive: true });

    const convId = "bbbbbbbb-1111-2222-3333-444444444444";

    await withDb(async (ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-copy",
          sourcePath: sourceFile,
        })
      );

      const destPath = path.join(rawDir, `${convId}.jsonl`);
      await copyFile(sourceFile, destPath);
      ctx.updateConversation(convId, {
        state: "staged",
        filePath: destPath,
      });
    });

    // Verify the file exists in raw dir
    const expectedPath = path.join(rawDir, `${convId}.jsonl`);
    await expect(access(expectedPath)).resolves.toBeUndefined();
  });
});

describe("Reset", () => {
  it("sets state back to discovered and clears filePath", async () => {
    const sourceDir = path.join(env.clogHome, "sources");
    await mkdir(sourceDir, { recursive: true });
    const sourceFile = path.join(sourceDir, "session-reset.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: "session-reset" })
    );

    const rawDir = path.join(getRawDir(), "claude-code");
    await mkdir(rawDir, { recursive: true });

    const convId = "cccccccc-1111-2222-3333-444444444444";

    // Insert and stage
    await withDb(async (ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-reset",
          sourcePath: sourceFile,
          state: "staged",
        })
      );

      const destPath = path.join(rawDir, `${convId}.jsonl`);
      await copyFile(sourceFile, destPath);
      ctx.updateConversation(convId, { filePath: destPath });
    });

    // Reset
    await withDb((ctx) => {
      ctx.updateConversation(convId, {
        state: "discovered",
        filePath: null,
      });
    });

    // Verify
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.state).toBe("discovered");
      expect(conv.filePath).toBeNull();
    });
  });
});

describe("Publish increments version", () => {
  it("increments version on each publish", async () => {
    const convId = "dddddddd-1111-2222-3333-444444444444";

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-pub",
          state: "staged",
        })
      );
    });

    // First publish
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const v1 = conv.publishVersion + 1;
      ctx.updateConversation(convId, {
        state: "published",
        publishVersion: v1,
        publishedAt: new Date().toISOString(),
      });
      ctx.insertPublishLogEntry({
        conversationId: convId,
        version: v1,
        publishedAt: new Date().toISOString(),
        author: "testuser",
        message: "v1",
      });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.publishVersion).toBe(1);
    });

    // Second publish (re-publish)
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const v2 = conv.publishVersion + 1;
      ctx.updateConversation(convId, {
        publishVersion: v2,
        publishedAt: new Date().toISOString(),
      });
      ctx.insertPublishLogEntry({
        conversationId: convId,
        version: v2,
        publishedAt: new Date().toISOString(),
        author: "testuser",
        message: "v2",
      });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.publishVersion).toBe(2);

      const log = ctx.getPublishLog();
      expect(log).toHaveLength(2);
    });
  });
});

describe("Tag dedup and normalization", () => {
  it("normalizes tags to lowercase and deduplicates", async () => {
    const convId = "eeeeeeee-1111-2222-3333-444444444444";

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-tag",
          tags: ["existing"],
        })
      );
    });

    // Add tags with duplicates, mixed case, whitespace
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const newTags = ["Debug", "  FRONTEND ", "existing", "debug"];
      const normalized = [
        ...new Set(newTags.map((t) => t.trim().toLowerCase()).filter(Boolean)),
      ];

      const existing = new Set(conv.tags);
      for (const tag of normalized) {
        existing.add(tag);
      }

      ctx.updateConversation(convId, { tags: [...existing] });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      // Should have "existing", "debug", "frontend" - no duplicates
      expect(conv.tags).toContain("existing");
      expect(conv.tags).toContain("debug");
      expect(conv.tags).toContain("frontend");
      expect(conv.tags).toHaveLength(3);
    });
  });
});

describe("Untag", () => {
  it("missing tag produces no error", async () => {
    const convId = "ffffffff-1111-2222-3333-444444444444";

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-untag",
          tags: ["keep-me"],
        })
      );
    });

    // Try to remove a tag that doesn't exist
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const toRemove = new Set(["nonexistent"]);
      const remaining = conv.tags.filter((t) => !toRemove.has(t));
      ctx.updateConversation(convId, { tags: remaining });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      // Original tag should still be there
      expect(conv.tags).toEqual(["keep-me"]);
    });
  });

  it("removes existing tags correctly", async () => {
    const convId = "gggggggg-1111-2222-3333-444444444444";

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          id: convId,
          sourceId: "session-untag2",
          tags: ["bug", "frontend", "urgent"],
        })
      );
    });

    // Remove "bug" and "urgent"
    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      const toRemove = new Set(["bug", "urgent"]);
      const remaining = conv.tags.filter((t) => !toRemove.has(t));
      ctx.updateConversation(convId, { tags: remaining });
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(convId)!;
      expect(conv.tags).toEqual(["frontend"]);
    });
  });
});
