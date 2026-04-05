import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { vi } from "vitest";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { withDb } from "../src/db/index.js";
import { reconcile } from "../src/sync/pull.js";
import { writeMetaJson } from "../src/sync/meta.js";
import { addExcluded } from "../src/cli/excluded.js";
import type { Config } from "../src/config/schema.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { getSearchProviders } from "../src/search/deps.js";

vi.mock("../src/search/deps.js", () => ({
  getSearchProviders: vi.fn(),
}));

let env: TestEnv;
let deleteSpy: ReturnType<typeof vi.fn>;

beforeEach(async () => {
  env = await createTestEnv();
  deleteSpy = vi.fn().mockResolvedValue(undefined);
  vi.mocked(getSearchProviders).mockResolvedValue({
    embedding: {} as never,
    vectorStore: {
      delete: deleteSpy,
    } as never,
  });
});

afterEach(async () => {
  vi.mocked(getSearchProviders).mockReset();
  await env.cleanup();
});

function makeConfig(overrides: Partial<Config["remote"]> = {}): Config {
  return {
    author: "testuser",
    sources: {
      "claude-code": { enabled: true, paths: [], includePaths: [], excludePaths: [] },
      "codex-cli": { enabled: false, paths: [], includePaths: [], excludePaths: [] },
    },
    defaultTags: [],
    autoScan: false,
    remote: {
      url: "git@github.com:org/clog-team.git",
      allowPublicRemote: false,
      visibilityConfirmed: false,
      lastSyncHead: null,
      ...overrides,
    },
    search: { embedding: { type: null }, vectorStore: { type: null } },
  };
}

async function createRemoteConversation(
  remoteDir: string,
  author: string,
  id: string,
  meta: Record<string, unknown> = {}
): Promise<void> {
  const authorDir = path.join(remoteDir, author);
  await mkdir(authorDir, { recursive: true });

  const conv = {
    id,
    sourceId: id,
    source: "claude-code",
    title: `Conversation ${id.slice(0, 6)}`,
    summary: "Test summary",
    author,
    project: "testproject",
    tags: ["test"],
    slug: null,
    createdAt: "2026-02-19T09:15:00Z",
    discoveredAt: new Date().toISOString(),
    modifiedAt: "2026-02-21T15:00:00Z",
    state: "published" as const,
    publishedAt: "2026-02-20T10:00:00Z",
    publishVersion: 1,
    sourcePath: "",
    filePath: null,
    sourceMtime: null,
    indexedAt: null,
    origin: null,
    ...meta,
  } satisfies ConversationMeta;

  await writeMetaJson(path.join(authorDir, `${id}.meta.json`), conv);
  await writeFile(
    path.join(authorDir, `${id}.jsonl`),
    '{"type":"user","message":{"role":"user","content":"test"},"uuid":"u1","timestamp":"2026-02-19T09:15:00Z","sessionId":"' + id + '"}\n',
    "utf-8"
  );
}

describe("reconcile", () => {
  it("inserts new conversations from remote", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");

    await createRemoteConversation(remoteDir, "alice", "abc11111-1111-1111-1111-111111111111");
    await createRemoteConversation(remoteDir, "bob", "def22222-2222-2222-2222-222222222222");

    const result = await reconcile(config);

    expect(result.inserted).toBe(2);
    expect(result.updated).toBe(0);
    expect(result.deleted).toBe(0);

    const convs = await withDb((ctx) => ctx.listConversations({ origin: "remote" }));
    expect(convs.length).toBe(2);
    expect(convs[0].origin).toBe("git@github.com:org/clog-team.git");
  });

  it("updates conversations when metadata changes", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";

    await createRemoteConversation(remoteDir, "alice", id);
    await reconcile(config);

    // Change the title
    await createRemoteConversation(remoteDir, "alice", id, {
      title: "Updated title",
      modifiedAt: "2026-03-01T00:00:00Z",
    });
    const result = await reconcile(config);

    expect(result.updated).toBe(1);

    const conv = await withDb((ctx) => ctx.getConversation(id));
    expect(conv!.title).toBe("Updated title");
  });

  it("does not clear indexedAt when only non-search metadata changes", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";
    const indexedAt = "2026-03-02T00:00:00.000Z";

    await createRemoteConversation(remoteDir, "alice", id);
    await reconcile(config);
    await withDb((ctx) => {
      ctx.setIndexedAt(id, indexedAt);
    });

    await createRemoteConversation(remoteDir, "alice", id, {
      author: "alice-renamed",
      project: "renamed-project",
      modifiedAt: "2026-03-03T00:00:00Z",
    });

    const result = await reconcile(config);
    expect(result.updated).toBe(1);

    const conv = await withDb((ctx) => ctx.getConversation(id));
    expect(conv!.author).toBe("alice-renamed");
    expect(conv!.project).toBe("renamed-project");
    expect(conv!.indexedAt).toBe(indexedAt);
  });

  it("updates both sourcePath and filePath when a remote conversation moves author directories", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";

    await createRemoteConversation(remoteDir, "alice", id);
    await reconcile(config);

    await createRemoteConversation(remoteDir, "bob", id, {
      author: "bob",
      modifiedAt: "2026-03-04T00:00:00Z",
    });

    const { rm } = await import("node:fs/promises");
    await rm(path.join(remoteDir, "alice", `${id}.meta.json`));
    await rm(path.join(remoteDir, "alice", `${id}.jsonl`));

    const result = await reconcile(config);
    expect(result.updated).toBe(1);

    const conv = await withDb((ctx) => ctx.getConversation(id));
    const expectedPath = path.join(remoteDir, "bob", `${id}.jsonl`);
    expect(conv!.author).toBe("bob");
    expect(conv!.sourcePath).toBe(expectedPath);
    expect(conv!.filePath).toBe(expectedPath);
  });

  it("deletes conversations removed from remote", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";

    await createRemoteConversation(remoteDir, "alice", id);
    await reconcile(config);

    // Remove the files
    const { rm } = await import("node:fs/promises");
    await rm(path.join(remoteDir, "alice", `${id}.meta.json`));
    await rm(path.join(remoteDir, "alice", `${id}.jsonl`));

    const result = await reconcile(config);
    expect(result.deleted).toBe(1);
    expect(deleteSpy).toHaveBeenCalledWith(id);

    const conv = await withDb((ctx) => ctx.getConversation(id));
    expect(conv).toBeNull();
  });

  it("does not delete conversations from a different remote origin", async () => {
    const config = makeConfig({
      url: "git@github.com:user/repo.git",
    });

    await withDb((ctx) => {
      ctx.insertConversation({
        id: "bbb22222-2222-2222-2222-222222222222",
        sourceId: "bbb22222-2222-2222-2222-222222222222",
        source: "claude-code",
        title: "Other remote conversation",
        summary: "",
        author: "bob",
        project: null,
        tags: [],
        slug: null,
        createdAt: "2026-02-19T09:15:00Z",
        discoveredAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        state: "published",
        publishedAt: new Date().toISOString(),
        publishVersion: 1,
        sourcePath: "/tmp/other-remote.jsonl",
        filePath: null,
        sourceMtime: null,
        indexedAt: null,
        origin: "git@github.com:other/repo.git",
      });
    });

    const result = await reconcile(config);

    expect(result.deleted).toBe(0);
    expect(deleteSpy).not.toHaveBeenCalledWith("bbb22222-2222-2222-2222-222222222222");
    const conv = await withDb((ctx) =>
      ctx.getConversation("bbb22222-2222-2222-2222-222222222222"));
    expect(conv?.origin).toBe("git@github.com:other/repo.git");
  });

  it("skips excluded conversations", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";

    await createRemoteConversation(remoteDir, "alice", id);
    await addExcluded("claude-code", id);

    const result = await reconcile(config);

    expect(result.inserted).toBe(0);
    expect(result.skippedExcluded).toBe(1);
  });

  it("skips remote when local copy exists", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const id = "abc11111-1111-1111-1111-111111111111";

    // Insert a local copy first
    await withDb((ctx) => {
      ctx.insertConversation({
        id,
        sourceId: id,
        source: "claude-code",
        title: "Local copy",
        summary: "",
        author: "testuser",
        project: null,
        tags: [],
        slug: null,
        createdAt: "2026-02-19T09:15:00Z",
        discoveredAt: new Date().toISOString(),
        modifiedAt: new Date().toISOString(),
        state: "published",
        publishedAt: new Date().toISOString(),
        publishVersion: 1,
        sourcePath: "/tmp/source.jsonl",
        filePath: null,
        sourceMtime: null,
        indexedAt: null,
        origin: null,
      });
    });

    await createRemoteConversation(remoteDir, "alice", id);
    const result = await reconcile(config);

    expect(result.inserted).toBe(0);
    expect(result.skippedDuplicate).toBe(1);

    // Local copy should be unchanged
    const conv = await withDb((ctx) => ctx.getConversation(id));
    expect(conv!.title).toBe("Local copy");
    expect(conv!.origin).toBeNull();
  });

  it("warns on orphaned .meta.json without .jsonl", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const authorDir = path.join(remoteDir, "alice");
    await mkdir(authorDir, { recursive: true });

    await writeFile(
      path.join(authorDir, "orphan123.meta.json"),
      JSON.stringify({
        id: "orphan123",
        title: "Orphan",
        author: "alice",
        publishedAt: "2026-02-20T10:00:00Z",
        modifiedAt: "2026-02-21T15:00:00Z",
        source: "claude-code",
        createdAt: "2026-02-19T09:15:00Z",
      }),
      "utf-8"
    );

    const result = await reconcile(config);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Orphaned");
  });

  it("warns on corrupt .meta.json", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");
    const authorDir = path.join(remoteDir, "alice");
    await mkdir(authorDir, { recursive: true });

    await writeFile(path.join(authorDir, "bad123.meta.json"), "not json", "utf-8");
    await writeFile(path.join(authorDir, "bad123.jsonl"), '{"type":"user"}\n', "utf-8");

    const result = await reconcile(config);
    expect(result.warnings.length).toBeGreaterThan(0);
    expect(result.warnings[0]).toContain("Corrupt");
  });

  it("is idempotent", async () => {
    const config = makeConfig();
    const remoteDir = path.join(env.clogHome, "remote");

    await createRemoteConversation(remoteDir, "alice", "abc11111-1111-1111-1111-111111111111");

    const result1 = await reconcile(config);
    expect(result1.inserted).toBe(1);

    const result2 = await reconcile(config);
    expect(result2.inserted).toBe(0);
    expect(result2.updated).toBe(0);
    expect(result2.deleted).toBe(0);
  });
});
