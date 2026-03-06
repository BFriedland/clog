import path from "node:path";
import { mkdtemp, mkdir, writeFile, stat, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { withDb } from "../src/db/index.js";
import { saveConfig, type Config } from "../src/config/schema.js";
import { syncPull } from "../src/sync/pull.js";
import { syncPush } from "../src/sync/push.js";
import { createMinimalJsonl } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

let env: TestEnv;
let bareRepoDir: string;
let bareRepoUrl: string;
let initDir: string;

// Check if git is available
let gitAvailable = false;
try {
  await execFileAsync("git", ["--version"]);
  gitAvailable = true;
} catch {
  // git not available
}

async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

beforeEach(async () => {
  if (!gitAvailable) return;
  env = await createTestEnv();

  // Create a bare git repo to serve as the "remote"
  bareRepoDir = await mkdtemp(path.join(tmpdir(), "clog-bare-"));
  await git(["init", "--bare"], bareRepoDir);
  bareRepoUrl = bareRepoDir;

  // Initialize with an empty commit so there's a HEAD
  initDir = await mkdtemp(path.join(tmpdir(), "clog-init-"));
  await git(["clone", bareRepoDir, initDir], initDir);
  // Need to set user for commits
  await git(["config", "user.email", "test@test.com"], initDir);
  await git(["config", "user.name", "Test"], initDir);
  await writeFile(path.join(initDir, ".gitkeep"), "", "utf-8");
  await git(["add", "-A"], initDir);
  await git(["commit", "-m", "init"], initDir);
  await git(["push"], initDir);
});

afterEach(async () => {
  if (!gitAvailable) return;
  await env.cleanup();
  const { rm } = await import("node:fs/promises");
  await rm(bareRepoDir, { recursive: true, force: true });
  await rm(initDir, { recursive: true, force: true });
});

function makeConfig(): Config {
  return {
    author: "alice",
    sources: {
      "claude-code": { enabled: true, paths: [], includePaths: [], excludePaths: [] },
      "codex-cli": { enabled: false, paths: [], includePaths: [], excludePaths: [] },
    },
    defaultTags: [],
    autoScan: false,
    remote: {
      url: bareRepoUrl,
      allowPublicRemote: false,
      visibilityConfirmed: true,
      lastSyncHead: null,
    },
    search: { embedding: { type: null }, vectorStore: { type: null } },
  };
}

describe.skipIf(!gitAvailable)("sync integration", () => {
  it("pull clones and imports conversations", async () => {
    const config = makeConfig();
    await mkdir(env.clogHome, { recursive: true });
    await saveConfig(config);

    // Simulate a teammate pushing a conversation
    const cloneDir = await mkdtemp(path.join(tmpdir(), "clog-teammate-"));
    await git(["clone", bareRepoDir, cloneDir], cloneDir);
    await git(["config", "user.email", "test@test.com"], cloneDir);
    await git(["config", "user.name", "Test"], cloneDir);

    const bobDir = path.join(cloneDir, "bob");
    await mkdir(bobDir, { recursive: true });
    const convId = "abcd1234-1111-2222-3333-444444444444";
    await writeFile(
      path.join(bobDir, `${convId}.meta.json`),
      JSON.stringify({
        id: convId,
        title: "Bob's conversation",
        summary: "Test",
        tags: ["test"],
        author: "bob",
        project: "testproject",
        publishedAt: "2026-02-20T10:00:00Z",
        modifiedAt: "2026-02-20T10:00:00Z",
        source: "claude-code",
        createdAt: "2026-02-19T09:15:00Z",
        slug: null,
      }),
      "utf-8"
    );
    await writeFile(
      path.join(bobDir, `${convId}.jsonl`),
      createMinimalJsonl({ sessionId: convId, userMessage: "Hello from bob" }),
      "utf-8"
    );
    await git(["add", "-A"], cloneDir);
    await git(["commit", "-m", "bob: add conversation"], cloneDir);
    await git(["push"], cloneDir);

    // Now pull
    const result = await syncPull(config);
    expect(result.inserted).toBe(1);

    const conv = await withDb((ctx) => ctx.getConversation(convId));
    expect(conv).not.toBeNull();
    expect(conv!.title).toBe("Bob's conversation");
    expect(conv!.author).toBe("bob");
    expect(conv!.origin).toBe(bareRepoUrl);
    expect(conv!.state).toBe("published");

    // Cleanup
    const { rm } = await import("node:fs/promises");
    await rm(cloneDir, { recursive: true, force: true });
  });

  it("push exports local conversations and round-trips", async () => {
    const config = makeConfig();
    await mkdir(env.clogHome, { recursive: true });
    await saveConfig(config);

    // First pull to establish checkout
    await syncPull(config);

    // Create a local published conversation
    const convId = "efgh5678-1111-2222-3333-444444444444";
    const rawDir = path.join(env.clogHome, "raw", "claude-code");
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      path.join(rawDir, `${convId}.jsonl`),
      createMinimalJsonl({ sessionId: convId, userMessage: "Hello from alice" }),
      "utf-8"
    );

    await withDb((ctx) => {
      ctx.insertConversation({
        id: convId,
        sourceId: convId,
        source: "claude-code",
        title: "Alice's conversation",
        summary: "Test push",
        author: "alice",
        project: "testproject",
        tags: ["test"],
        slug: null,
        createdAt: "2026-02-19T09:15:00Z",
        discoveredAt: new Date().toISOString(),
        modifiedAt: "2026-02-20T10:00:00Z",
        state: "published",
        publishedAt: "2026-02-20T10:00:00Z",
        publishVersion: 1,
        sourcePath: path.join(rawDir, `${convId}.jsonl`),
        filePath: path.join(rawDir, `${convId}.jsonl`),
        sourceMtime: null,
        indexedAt: null,
        origin: null,
      });
    });

    // Push
    const result = await syncPush(config);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.changes.some((c) => c.type === "added")).toBe(true);

    // Verify the file is in the remote
    const remoteDir = path.join(env.clogHome, "remote");
    await stat(path.join(remoteDir, "alice", `${convId}.meta.json`));
    await stat(path.join(remoteDir, "alice", `${convId}.jsonl`));
  });

  // Helper: sets up a pushed conversation and returns its ID + remote dir
  async function pushOneConversation(config: Config) {
    await syncPull(config);

    const convId = "efgh5678-1111-2222-3333-444444444444";
    const rawDir = path.join(env.clogHome, "raw", "claude-code");
    await mkdir(rawDir, { recursive: true });
    await writeFile(
      path.join(rawDir, `${convId}.jsonl`),
      createMinimalJsonl({ sessionId: convId, userMessage: "Hello from alice" }),
      "utf-8"
    );

    await withDb((ctx) => {
      ctx.insertConversation({
        id: convId,
        sourceId: convId,
        source: "claude-code",
        title: "Alice's conversation",
        summary: "Test push",
        author: "alice",
        project: "testproject",
        tags: ["test"],
        slug: null,
        createdAt: "2026-02-19T09:15:00Z",
        discoveredAt: new Date().toISOString(),
        modifiedAt: "2026-02-20T10:00:00Z",
        state: "published",
        publishedAt: "2026-02-20T10:00:00Z",
        publishVersion: 1,
        sourcePath: path.join(rawDir, `${convId}.jsonl`),
        filePath: path.join(rawDir, `${convId}.jsonl`),
        sourceMtime: null,
        indexedAt: null,
        origin: null,
      });
    });

    await syncPush(config);
    const remoteDir = path.join(env.clogHome, "remote");
    return { convId, remoteDir };
  }

  it("push is a no-op when already synced", async () => {
    const config = makeConfig();
    await mkdir(env.clogHome, { recursive: true });
    await saveConfig(config);

    await pushOneConversation(config);

    // Push again — nothing should change
    const result = await syncPush(config);
    expect(result.committed).toBe(false);
    expect(result.pushed).toBe(false);
  });

  it("retraction removes files from checkout on push", async () => {
    const config = makeConfig();
    await mkdir(env.clogHome, { recursive: true });
    await saveConfig(config);

    const { convId, remoteDir } = await pushOneConversation(config);

    // Unpublish the conversation
    await withDb((ctx) => {
      ctx.updateConversation(convId, { state: "staged" });
    });

    // Push again — should retract
    const result = await syncPush(config);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.changes.some((c) => c.type === "retracted" && c.id === convId)).toBe(true);

    // Files should be gone from checkout
    await expect(stat(path.join(remoteDir, "alice", `${convId}.meta.json`))).rejects.toThrow();
    await expect(stat(path.join(remoteDir, "alice", `${convId}.jsonl`))).rejects.toThrow();
  });

  it("metadata update is detected as updated on push", async () => {
    const config = makeConfig();
    await mkdir(env.clogHome, { recursive: true });
    await saveConfig(config);

    const { convId, remoteDir } = await pushOneConversation(config);

    // Update the title
    await withDb((ctx) => {
      ctx.updateConversation(convId, {
        title: "Updated title",
        modifiedAt: new Date().toISOString(),
      });
    });

    // Push again
    const result = await syncPush(config);
    expect(result.committed).toBe(true);
    expect(result.pushed).toBe(true);
    expect(result.changes.some((c) => c.type === "updated" && c.id === convId)).toBe(true);

    // Verify the new title is on disk
    const metaPath = path.join(remoteDir, "alice", `${convId}.meta.json`);
    const meta = JSON.parse(await readFile(metaPath, "utf-8"));
    expect(meta.title).toBe("Updated title");
  });
});
