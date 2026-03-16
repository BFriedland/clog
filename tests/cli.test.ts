import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { vi, describe, it, expect, beforeEach, afterEach } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createMinimalJsonl } from "./helpers/fixtures.js";
import { withDb } from "../src/db/index.js";
import { saveConfig, defaultConfig } from "../src/config/schema.js";
import type { ConversationMeta } from "../src/models/conversation.js";

import { editCommand } from "../src/cli/edit.js";
import { tagCommand } from "../src/cli/tag.js";
import { untagCommand } from "../src/cli/untag.js";
import { pathCommand } from "../src/cli/path.js";
import { logCommand } from "../src/cli/log.js";
import { resetCommand } from "../src/cli/reset.js";
import { excludeCommand } from "../src/cli/exclude.js";
import { unexcludeCommand } from "../src/cli/unexclude.js";
import { configCommand } from "../src/cli/config.js";
import { showCommand } from "../src/cli/show.js";
import { publishCommand } from "../src/cli/publish.js";
import { listCommand } from "../src/cli/list.js";
import { statusCommand } from "../src/cli/status.js";
import { addCommand } from "../src/cli/add.js";
import { diffCommand, resolveLimit, applyLimit } from "../src/cli/diff.js";
import { unpublishCommand } from "../src/cli/unpublish.js";
import { scanCommand } from "../src/cli/scan-command.js";
import { remoteShowCommand } from "../src/cli/remote.js";
import { refreshCommand } from "../src/cli/refresh.js";
import { syncPullCommand, syncPushCommand } from "../src/cli/sync.js";
import { remoteAddCommand } from "../src/cli/remote.js";

vi.mock("../src/sync/pull.js", () => ({
  syncPull: vi.fn().mockResolvedValue({
    inserted: 0, updated: 0, deleted: 0,
    skippedExcluded: 0, skippedDuplicate: 0, warnings: [],
  }),
  reconcile: vi.fn().mockResolvedValue({
    inserted: 0, updated: 0, deleted: 0, warnings: [],
  }),
}));

vi.mock("../src/sync/push.js", () => ({
  syncPush: vi.fn().mockResolvedValue({
    committed: false, pushed: false, changes: [],
  }),
}));

vi.mock("../src/sync/git.js", () => ({
  isGitRepo: vi.fn().mockResolvedValue(false),
  gitRevParseHead: vi.fn().mockResolvedValue("abc123"),
  ensureGit: vi.fn().mockResolvedValue(undefined),
  isGitHubHttpsUrl: vi.fn().mockReturnValue(false),
  suggestSshUrl: vi.fn().mockReturnValue(""),
}));

vi.mock("../src/search/deps.js", () => ({
  searchAvailable: vi.fn().mockResolvedValue(false),
  getSearchProviders: vi.fn(),
}));

vi.mock("../src/cli/scan.js", () => ({
  scanSources: vi.fn().mockResolvedValue({
    discovered: 0, excluded: 0, filtered: 0, ignored: 0, updated: 0,
  }),
}));

vi.mock("../src/sync/staleness.js", () => ({
  checkStaleness: vi.fn().mockResolvedValue({ isStale: false }),
}));

let env: TestEnv;
let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

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
    origin: null,
    ...overrides,
  };
}

beforeEach(async () => {
  env = await createTestEnv();
  logSpy = vi.spyOn(console, "log").mockImplementation(() => {});
  errorSpy = vi.spyOn(console, "error").mockImplementation(() => {});
});

afterEach(async () => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  await env.cleanup();
});

// ── editCommand ──────────────────────────────────────────────────

describe("editCommand", () => {
  it("updates title on a staged conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await editCommand(CONV_ID.slice(0, 8), { title: "New title" });

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.title).toBe("New title");
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Updated"));
  });

  it("updates summary and author", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await editCommand(CONV_ID.slice(0, 8), {
      summary: "New summary",
      author: "newauthor",
    });

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.summary).toBe("New summary");
      expect(conv.author).toBe("newauthor");
    });
  });

  it("throws when no fields provided", async () => {
    await expect(editCommand(CONV_ID, {})).rejects.toThrow(/Provide at least one/);
  });

  it("throws on not-found conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });
    await expect(
      editCommand("bbbb1111", { title: "x" })
    ).rejects.toThrow();
  });

  it("rejects editing a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "team-remote" })
      );
    });

    await expect(
      editCommand(CONV_ID.slice(0, 8), { title: "Nope" })
    ).rejects.toThrow(/remote/i);
  });

  it("clears indexedAt when editing a published+indexed conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "published",
          indexedAt: new Date().toISOString(),
        })
      );
    });

    await editCommand(CONV_ID.slice(0, 8), { title: "Edited" });

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.indexedAt).toBeNull();
    });
  });
});

// ── tagCommand ──────────────────────────────────────────────────

describe("tagCommand", () => {
  it("adds tags to a conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await tagCommand(CONV_ID.slice(0, 8), ["debug", "frontend"]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.tags).toContain("debug");
      expect(conv.tags).toContain("frontend");
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Tagged"));
  });

  it("deduplicates and normalizes tags", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", tags: ["existing"] })
      );
    });

    await tagCommand(CONV_ID.slice(0, 8), ["Existing", "  NEW ", "new"]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.tags).toHaveLength(2);
      expect(conv.tags).toContain("existing");
      expect(conv.tags).toContain("new");
    });
  });

  it("reports when no new tags added", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", tags: ["debug"] })
      );
    });

    await tagCommand(CONV_ID.slice(0, 8), ["debug"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No new tags"));
  });

  it("rejects tagging a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "team-remote" })
      );
    });
    await expect(
      tagCommand(CONV_ID.slice(0, 8), ["test"])
    ).rejects.toThrow(/remote/i);
  });
});

// ── untagCommand ────────────────────────────────────────────────

describe("untagCommand", () => {
  it("removes existing tags", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", tags: ["bug", "frontend", "urgent"] })
      );
    });

    await untagCommand(CONV_ID.slice(0, 8), ["bug", "urgent"]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.tags).toEqual(["frontend"]);
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Removed"));
  });

  it("handles non-existent tags gracefully", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", tags: ["keep"] })
      );
    });

    await untagCommand(CONV_ID.slice(0, 8), ["nonexistent"]);
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No matching"));
  });

  it("rejects untagging a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "team-remote" })
      );
    });
    await expect(
      untagCommand(CONV_ID.slice(0, 8), ["test"])
    ).rejects.toThrow(/remote/i);
  });
});

// ── pathCommand ─────────────────────────────────────────────────

describe("pathCommand", () => {
  it("prints the source path for a discovered conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    await pathCommand(CONV_ID.slice(0, 8));
    expect(logSpy).toHaveBeenCalledWith("/tmp/source.jsonl");
  });

  it("prints the file path for a staged conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", filePath: "/tmp/raw/test.jsonl" })
      );
    });

    await pathCommand(CONV_ID.slice(0, 8));
    expect(logSpy).toHaveBeenCalledWith("/tmp/raw/test.jsonl");
  });

  it("throws on not-found conversation", async () => {
    await expect(pathCommand("zzzz1111")).rejects.toThrow();
  });
});

// ── logCommand ──────────────────────────────────────────────────

describe("logCommand", () => {
  it("prints empty message when no publish history", async () => {
    await logCommand();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No publish"));
  });

  it("prints publish log entries", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", publishVersion: 1 })
      );
      ctx.insertPublishLogEntry({
        conversationId: CONV_ID,
        version: 1,
        publishedAt: "2026-01-15T10:00:00.000Z",
        author: "testuser",
        message: "First publish",
      });
    });

    await logCommand();
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("v1"));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("aaaaaaa"));
  });

  it("shows multiple entries with versions", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", publishVersion: 2 })
      );
      ctx.insertPublishLogEntry({
        conversationId: CONV_ID,
        version: 1,
        publishedAt: "2026-01-15T10:00:00.000Z",
        author: "testuser",
        message: "v1",
      });
      ctx.insertPublishLogEntry({
        conversationId: CONV_ID,
        version: 2,
        publishedAt: "2026-01-16T10:00:00.000Z",
        author: "testuser",
        message: "v2",
      });
    });

    await logCommand();
    // Should print both entries
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("v1"))).toBe(true);
    expect(calls.some((c) => c.includes("v2"))).toBe(true);
  });
});

// ── resetCommand ────────────────────────────────────────────────

describe("resetCommand", () => {
  it("resets a staged conversation to discovered", async () => {
    const filePath = path.join(env.clogHome, "raw", "test.jsonl");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "test");

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", filePath })
      );
    });

    await resetCommand([CONV_ID.slice(0, 8)]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.state).toBe("discovered");
      expect(conv.filePath).toBeNull();
    });
    expect(logSpy).toHaveBeenCalledWith("Reset 1 conversation(s)");
  });

  it("skips a discovered conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    await resetCommand([CONV_ID.slice(0, 8)]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Skipping"));
    expect(logSpy).toHaveBeenCalledWith("Reset 0 conversation(s)");
  });

  it("handles missing file gracefully during reset", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", filePath: "/tmp/nonexistent.jsonl" })
      );
    });

    // Should not throw even though filePath doesn't exist
    await resetCommand([CONV_ID.slice(0, 8)]);
    expect(logSpy).toHaveBeenCalledWith("Reset 1 conversation(s)");
  });
});

// ── excludeCommand ──────────────────────────────────────────────

describe("excludeCommand", () => {
  it("excludes a conversation and deletes it from DB", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation());
    });

    await excludeCommand([CONV_ID.slice(0, 8)]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID);
      expect(conv).toBeNull();
    });
    expect(logSpy).toHaveBeenCalledWith("Excluded 1 conversation(s)");
  });

  it("cleans up raw file for local conversations", async () => {
    const filePath = path.join(env.clogHome, "raw", "test.jsonl");
    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, "test");

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", filePath })
      );
    });

    await excludeCommand([CONV_ID.slice(0, 8)]);
    expect(logSpy).toHaveBeenCalledWith("Excluded 1 conversation(s)");
  });
});

// ── unexcludeCommand ────────────────────────────────────────────

describe("unexcludeCommand", () => {
  it("reports removal count", async () => {
    await unexcludeCommand(["source-1"]);
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Removed 1 exclusion(s)")
    );
  });
});

// ── configCommand ───────────────────────────────────────────────

describe("configCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("dumps full config when no args", async () => {
    await configCommand();
    const output = logSpy.mock.calls[0][0];
    expect(JSON.parse(output)).toHaveProperty("author", "testuser");
  });

  it("gets a top-level key", async () => {
    await configCommand("get", "author");
    expect(logSpy).toHaveBeenCalledWith("testuser");
  });

  it("gets a nested key", async () => {
    await configCommand("get", "sources.claude-code");
    const output = logSpy.mock.calls[0][0];
    expect(JSON.parse(output)).toHaveProperty("paths");
  });

  it("throws for missing key", async () => {
    await expect(
      configCommand("get", "nonexistent.deep.key")
    ).rejects.toThrow(/not found/);
  });

  it("sets a value", async () => {
    await configCommand("set", "author", "newuser");
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("newuser"));

    // Verify persisted
    logSpy.mockClear();
    await configCommand("get", "author");
    expect(logSpy).toHaveBeenCalledWith("newuser");
  });

  it("sets a JSON value", async () => {
    await configCommand("set", "remote.url", '"https://example.com"');
    logSpy.mockClear();
    await configCommand("get", "remote.url");
    expect(logSpy).toHaveBeenCalledWith("https://example.com");
  });

  it("throws for get without key", async () => {
    await expect(configCommand("get")).rejects.toThrow(/Usage:/);
  });

  it("throws for set without value", async () => {
    await expect(configCommand("set", "author")).rejects.toThrow(/Usage:/);
  });

  it("throws for unknown action", async () => {
    await expect(configCommand("delete")).rejects.toThrow(/Unknown/);
  });
});

// ── publishCommand ──────────────────────────────────────────────

describe("publishCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("publishes a staged conversation", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: "test-pub" })
    );
    const rawDir = path.join(env.clogHome, "raw", "claude-code");
    await mkdir(rawDir, { recursive: true });
    const filePath = path.join(rawDir, `${CONV_ID}.jsonl`);
    await writeFile(filePath, createMinimalJsonl({ sessionId: "test-pub" }));

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", sourcePath: sourceFile, filePath })
      );
    });

    await publishCommand([CONV_ID.slice(0, 8)], {});

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.state).toBe("published");
      expect(conv.publishVersion).toBe(1);
      expect(conv.publishedAt).toBeTruthy();
    });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("Published"));
  });

  it("publishes all staged conversations when no ids given", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(sourceFile, createMinimalJsonl({ sessionId: "test" }));
    const rawDir = path.join(env.clogHome, "raw", "claude-code");
    await mkdir(rawDir, { recursive: true });

    await withDb((ctx) => {
      for (const id of [CONV_ID, CONV_ID2]) {
        const fp = path.join(rawDir, `${id}.jsonl`);
        ctx.insertConversation(
          makeConversation({
            id,
            sourceId: `source-${id.slice(0, 4)}`,
            state: "staged",
            sourcePath: sourceFile,
            filePath: fp,
          })
        );
      }
    });
    // Create the raw files
    for (const id of [CONV_ID, CONV_ID2]) {
      await writeFile(
        path.join(rawDir, `${id}.jsonl`),
        createMinimalJsonl({ sessionId: id })
      );
    }

    await publishCommand([], {});

    await withDb((ctx) => {
      for (const id of [CONV_ID, CONV_ID2]) {
        expect(ctx.getConversation(id)!.state).toBe("published");
      }
    });
  });

  it("reports no staged conversations when empty", async () => {
    await publishCommand([], {});
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining("No staged"));
  });

  it("publishes a discovered conversation (implicit copy)", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(sourceFile, createMinimalJsonl({ sessionId: "test-disc" }));

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "discovered", sourcePath: sourceFile })
      );
    });

    await publishCommand([CONV_ID.slice(0, 8)], { message: "Direct publish" });

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.state).toBe("published");
      expect(conv.filePath).toBeTruthy();

      const log = ctx.getPublishLog();
      expect(log[0].message).toBe("Direct publish");
    });
  });
});

// ── showCommand ─────────────────────────────────────────────────

describe("showCommand", () => {
  it("shows conversation metadata and messages", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID, userMessage: "Hello world" })
    );

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", sourcePath: sourceFile, filePath: sourceFile })
      );
    });

    await showCommand(CONV_ID.slice(0, 8), {});

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Test conversation"))).toBe(true);
    expect(calls.some((c) => c.includes(CONV_ID))).toBe(true);
  });

  it("prints file path with --path flag", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", filePath: "/tmp/raw/test.jsonl" })
      );
    });

    await showCommand(CONV_ID.slice(0, 8), { path: true });
    expect(logSpy).toHaveBeenCalledWith("/tmp/raw/test.jsonl");
  });

  it("throws on not-found conversation", async () => {
    await expect(showCommand("zzzz1111", {})).rejects.toThrow();
  });

  it("limits output with --head", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({
        sessionId: CONV_ID,
        userMessage: "Hello",
        hasToolUse: true,
      })
    );

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", sourcePath: sourceFile, filePath: sourceFile })
      );
    });

    await showCommand(CONV_ID.slice(0, 8), { head: 1 });
    // Should show "showing X of Y messages" indicator
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("showing"))).toBe(true);
  });
});

// ── Data integrity: state machine violations ────────────────────

describe("state machine violations", () => {
  it("rejects editing a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "upstream" })
      );
    });
    await expect(
      editCommand(CONV_ID.slice(0, 8), { title: "Nope" })
    ).rejects.toThrow(/remote/i);
  });

  it("rejects tagging a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "upstream" })
      );
    });
    await expect(
      tagCommand(CONV_ID.slice(0, 8), ["test"])
    ).rejects.toThrow(/remote/i);
  });

  it("rejects untagging a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "upstream" })
      );
    });
    await expect(
      untagCommand(CONV_ID.slice(0, 8), ["test"])
    ).rejects.toThrow(/remote/i);
  });

  it("reset skips a discovered conversation (no-op)", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "discovered" }));
    });
    await resetCommand([CONV_ID.slice(0, 8)]);
    expect(logSpy).toHaveBeenCalledWith("Reset 0 conversation(s)");
  });
});

// ── listCommand ─────────────────────────────────────────────────

describe("listCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("shows 'No conversations found' when DB is empty", async () => {
    await listCommand({});
    expect(logSpy).toHaveBeenCalledWith("No conversations found.");
  });

  it("lists staged conversations in default mode", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
    });

    await listCommand({});
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    // Should have header + data row
    expect(calls.some((c) => c.includes("ID"))).toBe(true);
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("lists with --state filter", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          state: "discovered",
          author: "testuser",
        })
      );
    });

    await listCommand({ state: "discovered" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("bbbbbbb"))).toBe(true);
    expect(calls.every((c) => !c.includes("aaaaaaa"))).toBe(true);
  });

  it("lists with --all flag", async () => {
    // --all discovers via adapter. Since scanSources is mocked and adapter
    // won't find real files, we seed DB and test that DB conversations appear.
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "published",
          origin: "team",
          author: "other",
        })
      );
    });

    await listCommand({ all: true });
    // With mocked adapter, the remote conversation from DB should appear
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("rejects invalid column names", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    const origExitCode = process.exitCode;
    await listCommand({ columns: "id,bogus" });
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("Unknown column"));
    expect(process.exitCode).toBe(1);
    process.exitCode = origExitCode;
  });

  it("supports custom columns", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
    });

    await listCommand({ columns: "id,author,title" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls[0]).toContain("AUTHOR");
  });

  it("filters by --project", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
    });

    await listCommand({ state: "staged", project: "webapp" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("filters by --tag", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser", tags: ["debug"] })
      );
    });

    await listCommand({ state: "staged", tag: "debug" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("filters by --grep", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser", title: "Fix login CSS" })
      );
    });

    await listCommand({ state: "staged", grep: "login" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("filters by --origin local", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          state: "published",
          origin: "team",
          author: "other",
        })
      );
    });

    await listCommand({ origin: "local" });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
    expect(calls.every((c) => !c.includes("bbbbbbb"))).toBe(true);
  });

  it("shows team conversation count in default mode", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "staged", author: "testuser" })
      );
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          state: "published",
          origin: "team",
          author: "other",
        })
      );
    });

    await listCommand({});
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("team conversation"))).toBe(true);
  });
});

// ── statusCommand ───────────────────────────────────────────────

describe("statusCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("shows 'nothing to publish' when DB is empty", async () => {
    await statusCommand();
    expect(logSpy).toHaveBeenCalledWith("nothing to publish, working tree clean");
  });

  it("shows staged conversations", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await statusCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("to be published"))).toBe(true);
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("shows discovered conversations", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "discovered" }));
    });

    await statusCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("not staged"))).toBe(true);
  });

  it("shows modified conversations", async () => {
    const publishedAt = "2026-01-01T00:00:00.000Z";
    const modifiedAt = "2026-01-02T00:00:00.000Z";
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "published",
          publishedAt,
          modifiedAt,
        })
      );
    });

    await statusCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("not staged for publishing"))).toBe(true);
  });
});

// ── addCommand ──────────────────────────────────────────────────

describe("addCommand", () => {
  it("stages a discovered conversation by ID", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(sourceFile, createMinimalJsonl({ sessionId: "test-add" }));

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "discovered", sourcePath: sourceFile })
      );
    });

    await addCommand([CONV_ID.slice(0, 8)], {});

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.state).toBe("staged");
      expect(conv.filePath).toBeTruthy();
    });
    expect(logSpy).toHaveBeenCalledWith("Added 1 conversation(s)");
  });

  it("stages all discovered conversations with --all", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(sourceFile, createMinimalJsonl({ sessionId: "test" }));

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "discovered", sourcePath: sourceFile })
      );
      ctx.insertConversation(
        makeConversation({
          id: CONV_ID2,
          sourceId: "source-2",
          state: "discovered",
          sourcePath: sourceFile,
        })
      );
    });

    await addCommand([], { all: true });
    expect(logSpy).toHaveBeenCalledWith("Added 2 conversation(s)");
  });

  it("stages by project filter", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(sourceFile, createMinimalJsonl({ sessionId: "test" }));

    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "discovered",
          sourcePath: sourceFile,
          project: "/Users/testuser/projects/webapp",
        })
      );
    });

    await addCommand([], { project: "webapp" });
    expect(logSpy).toHaveBeenCalledWith("Added 1 conversation(s)");
  });

  it("throws when conversation not found", async () => {
    await expect(
      addCommand(["zzzz1111"], {})
    ).rejects.toThrow(/No conversation found/i);
  });
});

// ── diffCommand + resolveLimit + applyLimit ─────────────────────

describe("diffCommand", () => {
  it("shows diff for modified published conversation", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID, hasToolUse: true })
    );

    const publishedAt = "2026-01-01T00:00:00.000Z";
    const modifiedAt = "2026-01-02T00:00:00.000Z";
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({
          state: "published",
          publishedAt,
          modifiedAt,
          sourcePath: sourceFile,
          filePath: sourceFile,
        })
      );
    });

    await diffCommand([], {});
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("shows diff for staged conversations with --staged", async () => {
    const sourceFile = path.join(env.clogHome, "source.jsonl");
    await writeFile(
      sourceFile,
      createMinimalJsonl({ sessionId: CONV_ID })
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

    await diffCommand([], { staged: true });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("aaaaaaa"))).toBe(true);
  });

  it("rejects not-published conversation without --staged", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await expect(
      diffCommand([CONV_ID.slice(0, 8)], {})
    ).rejects.toThrow(/not published/i);
  });
});

describe("resolveLimit", () => {
  it("returns head when specified", () => {
    expect(resolveLimit({ head: 5 })).toEqual({ head: 5, tail: undefined });
  });

  it("returns tail when specified", () => {
    expect(resolveLimit({ tail: 3 })).toEqual({ head: undefined, tail: 3 });
  });

  it("aliases first to head", () => {
    expect(resolveLimit({ first: 5 })).toEqual({ head: 5, tail: undefined });
  });

  it("aliases last to tail", () => {
    expect(resolveLimit({ last: 3 })).toEqual({ head: undefined, tail: 3 });
  });

  it("throws when both head and tail specified", () => {
    expect(() => resolveLimit({ head: 5, tail: 3 })).toThrow(/Cannot use/);
  });

  it("throws for negative head", () => {
    expect(() => resolveLimit({ head: -1 })).toThrow(/non-negative/);
  });

  it("throws for negative tail", () => {
    expect(() => resolveLimit({ tail: -1 })).toThrow(/non-negative/);
  });

  it("returns empty for no options", () => {
    expect(resolveLimit({})).toEqual({ head: undefined, tail: undefined });
  });
});

describe("applyLimit", () => {
  const msgs = [
    { role: "user", content: "a", timestamp: "1" },
    { role: "assistant", content: "b", timestamp: "2" },
    { role: "user", content: "c", timestamp: "3" },
  ] as any;

  it("returns head slice", () => {
    expect(applyLimit(msgs, { head: 2 })).toHaveLength(2);
  });

  it("returns tail slice", () => {
    const result = applyLimit(msgs, { tail: 1 });
    expect(result).toHaveLength(1);
    expect(result[0].content).toBe("c");
  });

  it("returns empty for tail 0", () => {
    expect(applyLimit(msgs, { tail: 0 })).toHaveLength(0);
  });

  it("returns all when no limit", () => {
    expect(applyLimit(msgs, {})).toHaveLength(3);
  });
});

// ── unpublishCommand ────────────────────────────────────────────

describe("unpublishCommand", () => {
  it("unpublishes a published conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", publishVersion: 1 })
      );
    });

    await unpublishCommand([CONV_ID.slice(0, 8)]);

    await withDb((ctx) => {
      const conv = ctx.getConversation(CONV_ID)!;
      expect(conv.state).toBe("staged");
    });
    expect(logSpy).toHaveBeenCalledWith("Unpublished 1 conversation(s)");
  });

  it("skips a staged conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(makeConversation({ state: "staged" }));
    });

    await unpublishCommand([CONV_ID.slice(0, 8)]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("not published"));
    expect(logSpy).toHaveBeenCalledWith("Unpublished 0 conversation(s)");
  });

  it("skips a remote conversation", async () => {
    await withDb((ctx) => {
      ctx.insertConversation(
        makeConversation({ state: "published", origin: "team" })
      );
    });

    await unpublishCommand([CONV_ID.slice(0, 8)]);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining("remote"));
    expect(logSpy).toHaveBeenCalledWith("Unpublished 0 conversation(s)");
  });
});

// ── scanCommand ─────────────────────────────────────────────────

describe("scanCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("reports no conversations when source is empty", async () => {
    // Set CLOG_SOURCES to an empty temp dir
    const emptyDir = path.join(env.clogHome, "empty-source");
    await mkdir(emptyDir, { recursive: true });
    const oldSources = process.env.CLOG_SOURCES;
    process.env.CLOG_SOURCES = emptyDir;

    try {
      await expect(scanCommand()).rejects.toThrow(
        /No conversations found/
      );
    } finally {
      if (oldSources !== undefined) {
        process.env.CLOG_SOURCES = oldSources;
      } else {
        delete process.env.CLOG_SOURCES;
      }
    }
  });
});

// ── remoteShowCommand ───────────────────────────────────────────

describe("remoteShowCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("throws when no remote configured", async () => {
    await expect(remoteShowCommand()).rejects.toThrow(/No remote configured/);
  });

  it("shows remote info when configured", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    await remoteShowCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("git@github.com"))).toBe(true);
  });
});

// ── refreshCommand ──────────────────────────────────────────────

describe("refreshCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("throws 'No remote configured' when no remote", async () => {
    await expect(refreshCommand()).rejects.toThrow(/No remote configured/);
  });

  it("throws 'No checkout found' when no git repo", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    await expect(refreshCommand()).rejects.toThrow(/No checkout found/);
  });
});

// ── syncPullCommand ─────────────────────────────────────────────

describe("syncPullCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("throws when no remote configured", async () => {
    await expect(syncPullCommand()).rejects.toThrow(/No remote configured/);
  });

  it("reports 'Already up to date' when nothing changed", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    await syncPullCommand();
    expect(logSpy).toHaveBeenCalledWith("Already up to date.");
  });
});

// ── syncPushCommand ─────────────────────────────────────────────

describe("syncPushCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("throws when no remote configured", async () => {
    await expect(syncPushCommand()).rejects.toThrow(/No remote configured/);
  });

  it("throws when no author configured", async () => {
    const cfg = defaultConfig();
    cfg.remote.url = "git@github.com:user/repo.git";
    cfg.author = "";
    await saveConfig(cfg);

    await expect(syncPushCommand()).rejects.toThrow(/author/);
  });

  it("reports nothing to push when not committed", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    await syncPushCommand();
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Nothing to push")
    );
  });

  it("reports push rejected when pushed=false", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    const { syncPush } = await import("../src/sync/push.js");
    vi.mocked(syncPush).mockResolvedValueOnce({
      committed: true,
      pushed: false,
      changes: [],
      error: "rejected",
    } as any);

    await syncPushCommand();
    expect(errorSpy).toHaveBeenCalledWith(
      expect.stringContaining("Push was rejected")
    );
  });

  it("reports successful push", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);

    const { syncPush } = await import("../src/sync/push.js");
    vi.mocked(syncPush).mockResolvedValueOnce({
      committed: true,
      pushed: true,
      changes: [
        { type: "added", id: CONV_ID, title: "Test" },
      ],
    } as any);

    await syncPushCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Pushed"))).toBe(true);
  });
});

// ── syncPull success path ───────────────────────────────────────

describe("syncPullCommand success", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/repo.git";
    await saveConfig(cfg);
  });

  it("reports pulled results", async () => {
    const { syncPull } = await import("../src/sync/pull.js");
    vi.mocked(syncPull).mockResolvedValueOnce({
      inserted: 3, updated: 1, deleted: 0,
      skippedExcluded: 0, skippedDuplicate: 0, warnings: [],
    } as any);

    await syncPullCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("Pulled"))).toBe(true);
  });

  it("reports warnings from pull", async () => {
    const { syncPull } = await import("../src/sync/pull.js");
    vi.mocked(syncPull).mockResolvedValueOnce({
      inserted: 0, updated: 0, deleted: 0,
      skippedExcluded: 2, skippedDuplicate: 1,
      warnings: ["something weird"],
    } as any);

    await syncPullCommand();
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((c) => c.includes("excluded"))).toBe(true);
    expect(calls.some((c) => c.includes("something weird"))).toBe(true);
  });
});

// ── remoteAddCommand ────────────────────────────────────────────

describe("remoteAddCommand", () => {
  beforeEach(async () => {
    await mkdir(env.clogHome, { recursive: true });
    const cfg = defaultConfig();
    cfg.author = "testuser";
    await saveConfig(cfg);
  });

  it("throws when remote already configured", async () => {
    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.remote.url = "git@github.com:user/existing.git";
    await saveConfig(cfg);

    await expect(
      remoteAddCommand("git@github.com:user/new.git")
    ).rejects.toThrow(/already configured/);
  });

  it("configures a new SSH remote", async () => {
    await remoteAddCommand("git@github.com:user/repo.git");
    expect(logSpy).toHaveBeenCalledWith(
      expect.stringContaining("Remote configured")
    );
  });
});
