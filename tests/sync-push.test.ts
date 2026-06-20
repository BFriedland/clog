import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  buildCommitMessage,
  collectRemoteOriginIds,
  exportAuthorToCheckout,
  type ChangeRecord,
} from "../src/sync/push.js";
import { getRemoteRoot, getRemoteSourceDir } from "../src/sync/paths.js";
import {
  getRawConversationPath,
  getRawSourceDir,
} from "../src/utils/paths.js";
import * as atomicWrite from "../src/utils/atomic-write.js";
import { writeJsonl } from "./helpers/fixtures.js";

const TEST_REMOTE_URL = "git@github.com:myorg/clog-team.git";

describe("buildCommitMessage", () => {
  it("renders a single-author commit with ≤10 changes including per-conversation lines", () => {
    const changes: ChangeRecord[] = [
      { kind: "added", id: "abc12345", title: "Fix auth", source: "claude-code", author: "alice" },
      { kind: "added", id: "def56789", title: "Refactor DB", source: "claude-code", author: "alice" },
      { kind: "updated", id: "aaa11112", title: "Update session", source: "claude-code", author: "alice" },
      { kind: "retracted", id: "789fedcb", title: "Debug leak", source: "claude-code", author: "alice" },
    ];

    const message = buildCommitMessage({ changes });

    expect(message).toContain("clog: alice — 2 added, 1 updated, 1 retracted");
    expect(message).toContain("  + abc12345 Fix auth");
    expect(message).toContain("  + def56789 Refactor DB");
    expect(message).toContain("  ~ aaa11112 Update session");
    expect(message).toContain("  - 789fedcb Debug leak");
  });

  it("renders a single-author commit with >10 changes as a summary only", () => {
    const changes: ChangeRecord[] = Array.from({ length: 47 }, (_, i) => ({
      kind: "added" as const,
      id: `id${String(i).padStart(5, "0")}`,
      title: `Conversation ${i}`,
      source: "claude-code",
      author: "alice",
    }));

    const message = buildCommitMessage({ changes });

    expect(message).toBe("clog: alice — 47 added");
    expect(message).not.toContain("+ ");
  });

  it("renders a multi-author commit with per-author lines only", () => {
    const changes: ChangeRecord[] = [
      ...Array.from({ length: 47 }, (_, i) => ({
        kind: "added" as const,
        id: `a${i}`,
        title: `A ${i}`,
        source: "claude-code",
        author: "alice",
      })),
      { kind: "added", id: "b1", title: "B1", source: "claude-code", author: "bob" },
      { kind: "added", id: "b2", title: "B2", source: "claude-code", author: "bob" },
      { kind: "retracted", id: "b3", title: "B3", source: "claude-code", author: "bob" },
    ];

    const message = buildCommitMessage({ changes });

    expect(message).toContain("clog: 2 authors — 49 added, 1 retracted");
    expect(message).toContain("  alice: 47 added");
    expect(message).toContain("  bob: 2 added, 1 retracted");
    expect(message).not.toContain("+ ");
  });
});

describe("exportAuthorToCheckout", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-sync-push-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes .meta.json and .jsonl pairs and reports added changes on first export", async () => {
    const conversation = await insertLocalSaved({
      id: "a1111111-1111-1111-1111-111111111111",
      title: "Fix auth",
      author: "alice",
    });

    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes).toHaveLength(1);
    expect(stats.changes[0]?.kind).toBe("added");
    expect(stats.changes[0]?.title).toBe("Fix auth");

    const metaPath = path.join(
      getRemoteSourceDir("alice", "claude-code"),
      `${conversation.id}.meta.json`,
    );
    const jsonlPath = path.join(
      getRemoteSourceDir("alice", "claude-code"),
      `${conversation.id}.jsonl`,
    );

    const meta = JSON.parse(await fs.readFile(metaPath, "utf8"));
    expect(meta.title).toBe("Fix auth");
    expect(meta).not.toHaveProperty("projectPath");

    await expect(fs.stat(jsonlPath)).resolves.toBeTruthy();
  });

  it("writes exported pairs through the atomic writer with JSONL before metadata", async () => {
    const id = "a1212121-1212-1212-1212-121212121212";
    await insertLocalSaved({
      id,
      title: "Atomic export",
      author: "alice",
    });

    const calls: string[] = [];
    const spy = vi
      .spyOn(atomicWrite, "writeFileAtomic")
      .mockImplementation(async (filePath: string) => {
        calls.push(path.basename(filePath));
      });

    await exportAuthorToCheckout("alice", new Set());

    expect(spy).toHaveBeenCalled();
    expect(
      calls.filter(
        (name) => name === `${id}.jsonl` || name === `${id}.meta.json`,
      ),
    ).toEqual([`${id}.jsonl`, `${id}.meta.json`]);
  });

  it("leaves only JSONL when metadata writing fails during export", async () => {
    const id = "a1313131-1313-1313-1313-131313131313";
    await insertLocalSaved({
      id,
      title: "Interrupted export",
      author: "alice",
    });

    const metaPath = path.join(
      getRemoteSourceDir("alice", "claude-code"),
      `${id}.meta.json`,
    );
    const jsonlPath = path.join(
      getRemoteSourceDir("alice", "claude-code"),
      `${id}.jsonl`,
    );

    const originalWriteFileAtomic = atomicWrite.writeFileAtomic;
    const calls: string[] = [];
    const spy = vi
      .spyOn(atomicWrite, "writeFileAtomic")
      .mockImplementation(async (filePath: string, data: Buffer | string) => {
        calls.push(path.basename(filePath));
        if (filePath === jsonlPath) {
          await fs.mkdir(path.dirname(filePath), { recursive: true });
          await fs.writeFile(filePath, data);
          return;
        }
        if (filePath === metaPath) {
          throw new Error("simulated metadata write failure");
        }
        await originalWriteFileAtomic(filePath, data);
      });

    await expect(exportAuthorToCheckout("alice", new Set())).rejects.toThrow(
      "simulated metadata write failure",
    );

    expect(spy).toHaveBeenCalled();
    expect(
      calls.filter(
        (name) => name === `${id}.jsonl` || name === `${id}.meta.json`,
      ),
    ).toEqual([`${id}.jsonl`, `${id}.meta.json`]);
    await expect(fs.stat(jsonlPath)).resolves.toBeTruthy();
    await expect(fs.stat(metaPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports zero changes on a second export when nothing changed", async () => {
    await insertLocalSaved({
      id: "a2222222-2222-2222-2222-222222222222",
      title: "Stable",
      author: "alice",
    });

    await exportAuthorToCheckout("alice", new Set());
    const second = await exportAuthorToCheckout("alice", new Set());

    expect(second.changes).toHaveLength(0);
  });

  it("retracts pairs whose DB row no longer exists under config.author", async () => {
    const authorDir = getRemoteSourceDir("alice", "claude-code");
    await fs.mkdir(authorDir, { recursive: true });
    const id = "a3333333-3333-3333-3333-333333333333";
    await fs.writeFile(
      path.join(authorDir, `${id}.meta.json`),
      `${JSON.stringify({ title: "Retracted conversation" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(authorDir, `${id}.jsonl`), "{}\n", "utf8");

    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes).toHaveLength(1);
    expect(stats.changes[0]?.kind).toBe("retracted");
    expect(stats.changes[0]?.title).toBe("Retracted conversation");

    await expect(
      fs.stat(path.join(authorDir, `${id}.meta.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not retract orphaned single files (lightest-necessary-touch)", async () => {
    const authorDir = getRemoteSourceDir("alice", "claude-code");
    await fs.mkdir(authorDir, { recursive: true });
    const id = "a4444444-4444-4444-4444-444444444444";
    await fs.writeFile(
      path.join(authorDir, `${id}.meta.json`),
      `${JSON.stringify({ title: "Orphan meta only" }, null, 2)}\n`,
      "utf8",
    );
    // No .jsonl — incomplete pair. Must not be deleted.

    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes.find((c) => c.kind === "retracted")).toBeUndefined();
    await expect(
      fs.stat(path.join(authorDir, `${id}.meta.json`)),
    ).resolves.toBeTruthy();
  });

  it("does not touch other authors' directories", async () => {
    const bobDir = getRemoteSourceDir("bob", "claude-code");
    await fs.mkdir(bobDir, { recursive: true });
    const bobId = "b1111111-1111-1111-1111-111111111111";
    await fs.writeFile(
      path.join(bobDir, `${bobId}.meta.json`),
      `${JSON.stringify({ title: "Bob's file" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(bobDir, `${bobId}.jsonl`), "{}\n", "utf8");

    await exportAuthorToCheckout("alice", new Set());

    await expect(
      fs.stat(path.join(bobDir, `${bobId}.meta.json`)),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(bobDir, `${bobId}.jsonl`)),
    ).resolves.toBeTruthy();
  });

  it("does not touch unknown source directories under config.author", async () => {
    const unknownDir = path.join(getRemoteRoot(), "alice", "strange-source");
    await fs.mkdir(unknownDir, { recursive: true });
    const stub = path.join(unknownDir, "some-file.meta.json");
    await fs.writeFile(stub, "{}", "utf8");

    await exportAuthorToCheckout("alice", new Set());

    await expect(fs.stat(stub)).resolves.toBeTruthy();
  });

  it("reports 'added' (not 'updated') when only one file of a pair previously existed", async () => {
    const conversation = await insertLocalSaved({
      id: "a9999999-9999-9999-9999-999999999999",
      title: "Orphan meta pre-existed",
      author: "alice",
    });

    // Pre-seed only the meta.json (orphan from a previous partial operation).
    const sourceDir = getRemoteSourceDir("alice", "claude-code");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, `${conversation.id}.meta.json`),
      `${JSON.stringify({ title: "stale" }, null, 2)}\n`,
      "utf8",
    );

    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes).toHaveLength(1);
    expect(stats.changes[0]?.kind).toBe("added");
  });

  it("excludes git-origin conversations from the export set", async () => {
    // A git-origin row should never be re-pushed.
    const timestamp = "2026-02-01T10:00:00.000Z";
    await insertConversation({
      id: "a5555555-5555-5555-5555-555555555555",
      sourceId: "a5555555-5555-5555-5555-555555555555",
      source: "claude-code",
      title: "From remote",
      summary: "",
      author: "alice",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: timestamp,
      discoveredAt: timestamp,
      modifiedAt: timestamp,
      state: "saved",
      savedAt: timestamp,
      savedMessageCount: 2,
      saveVersion: 1,
      sourcePath: "/tmp/remote-checkout.jsonl",
      filePath: "/tmp/remote-checkout.jsonl",
      sourceMtime: null,
      indexedAt: null,
      originKind: "git",
      originRef: TEST_REMOTE_URL,
    });

    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes).toHaveLength(0);
  });

  it("does not retract checkout files that correspond to git-origin DB rows", async () => {
    // Simulates the multi-machine scenario: alice pushed from machine A,
    // then pulls on machine B (importing with originRef=remoteUrl). Pushing
    // from machine B must NOT retract machine A's conversations.
    const id = "a6666666-6666-6666-6666-666666666666";
    const authorDir = getRemoteSourceDir("alice", "claude-code");
    await fs.mkdir(authorDir, { recursive: true });
    await fs.writeFile(
      path.join(authorDir, `${id}.meta.json`),
      `${JSON.stringify({ title: "From machine A" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(authorDir, `${id}.jsonl`), "{}\n", "utf8");

    // The pulled DB row has originRef=remoteUrl.
    const timestamp = "2026-02-01T10:00:00.000Z";
    await insertConversation({
      id,
      sourceId: id,
      source: "claude-code",
      title: "From machine A",
      summary: "",
      author: "alice",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: timestamp,
      discoveredAt: timestamp,
      modifiedAt: timestamp,
      state: "saved",
      savedAt: timestamp,
      savedMessageCount: 1,
      saveVersion: 1,
      sourcePath: path.join(authorDir, `${id}.jsonl`),
      filePath: path.join(authorDir, `${id}.jsonl`),
      sourceMtime: null,
      indexedAt: null,
      originKind: "git",
      originRef: TEST_REMOTE_URL,
    });

    const remoteIds = await collectRemoteOriginIds("alice", TEST_REMOTE_URL);
    const stats = await exportAuthorToCheckout("alice", remoteIds);

    // No retraction: the pre-reconcile git-origin snapshot protects the checkout files.
    expect(stats.changes.find((c) => c.kind === "retracted")).toBeUndefined();
    await expect(
      fs.stat(path.join(authorDir, `${id}.meta.json`)),
    ).resolves.toBeTruthy();
    await expect(
      fs.stat(path.join(authorDir, `${id}.jsonl`)),
    ).resolves.toBeTruthy();
  });

  it("retracts checkout files for git-origin DB rows that are absent from the pre-reconcile snapshot", async () => {
    // Simulates the intentional-retraction case: user removed the
    // conversation locally before sync push, so it was absent from the
    // pre-reconcile snapshot. Even if reconcile re-imports it (giving it
    // a current DB row with originRef=remoteUrl), the export phase must still
    // retract it. This locks in the design choice of using a snapshot
    // rather than current DB state.
    const id = "a7777777-7777-7777-7777-777777777777";
    const authorDir = getRemoteSourceDir("alice", "claude-code");
    await fs.mkdir(authorDir, { recursive: true });
    await fs.writeFile(
      path.join(authorDir, `${id}.meta.json`),
      `${JSON.stringify({ title: "Re-imported by reconcile" }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(authorDir, `${id}.jsonl`), "{}\n", "utf8");

    const timestamp = "2026-02-01T10:00:00.000Z";
    await insertConversation({
      id,
      sourceId: id,
      source: "claude-code",
      title: "Re-imported by reconcile",
      summary: "",
      author: "alice",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: timestamp,
      discoveredAt: timestamp,
      modifiedAt: timestamp,
      state: "saved",
      savedAt: timestamp,
      savedMessageCount: 1,
      saveVersion: 1,
      sourcePath: path.join(authorDir, `${id}.jsonl`),
      filePath: path.join(authorDir, `${id}.jsonl`),
      sourceMtime: null,
      indexedAt: null,
      originKind: "git",
      originRef: TEST_REMOTE_URL,
    });

    // Empty snapshot = the conversation was not present before reconcile,
    // even though it is in the DB now.
    const stats = await exportAuthorToCheckout("alice", new Set());

    expect(stats.changes).toHaveLength(1);
    expect(stats.changes[0]?.kind).toBe("retracted");
    expect(stats.changes[0]?.title).toBe("Re-imported by reconcile");
    await expect(
      fs.stat(path.join(authorDir, `${id}.meta.json`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
    await expect(
      fs.stat(path.join(authorDir, `${id}.jsonl`)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function insertLocalSaved(options: {
  id: string;
  title: string;
  author: string;
}): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", options.id);
  await fs.mkdir(getRawSourceDir("claude-code"), { recursive: true });
  await writeJsonl(rawPath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/tmp/repo",
      message: { role: "user", content: "Hello" },
    },
  ]);

  const timestamp = "2026-02-01T10:00:00.000Z";
  const conversation: ConversationMeta = {
    id: options.id,
    sourceId: options.id,
    source: "claude-code",
    title: options.title,
    summary: "",
    author: options.author,
    projectName: "repo",
    projectPath: "/tmp/repo",
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved",
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: rawPath,
    filePath: rawPath,
    sourceMtime: null,
    indexedAt: null,
    originKind: "local",
    originRef: null,
  };

  await insertConversation(conversation);
  return conversation;
}
