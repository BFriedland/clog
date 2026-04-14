import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultConfig } from "../src/config/index.js";
import {
  getConversationById,
  insertConversation,
  listConversations,
} from "../src/db/index.js";
import { reconcileRemote } from "../src/sync/pull.js";
import { getRemoteRoot } from "../src/sync/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";

const REMOTE_URL = "git@github.com:myorg/clog-team.git";
const OTHER_REMOTE = "git@github.com:myorg/other.git";

describe("sync pull reconciliation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-sync-pull-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("inserts new valid pairs", async () => {
    await writeRemotePair("alice", "claude-code", "a1111111-1111-1111-1111-111111111111", {
      title: "Fix auth",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(1);
    expect(stats.updated).toBe(0);
    expect(stats.deleted).toBe(0);

    const rows = await listConversations({ origin: "remote" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Fix auth");
    expect(rows[0]?.publishedMessageCount).toBe(2);
    expect(rows[0]?.origin).toBe(REMOTE_URL);
    expect(rows[0]?.author).toBe("alice");
    expect(rows[0]?.state).toBe("published");
  });

  it("updates existing rows when metadata changes and clears indexed_at on search-visible changes", async () => {
    await writeRemotePair("alice", "claude-code", "a2222222-2222-2222-2222-222222222222", {
      title: "Original title",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    // Mark as indexed so we can assert indexed_at is cleared on title change.
    const existing = (await listConversations({ origin: "remote" }))[0]!;
    const { setConversationIndexedAt } = await import("../src/db/index.js");
    await setConversationIndexedAt(existing.id, "2026-03-01T00:00:00.000Z");

    await writeRemotePair("alice", "claude-code", "a2222222-2222-2222-2222-222222222222", {
      title: "Updated title",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(1);
    expect(stats.deleted).toBe(0);

    const refreshed = await getConversationById(existing.id);
    expect(refreshed?.title).toBe("Updated title");
    expect(refreshed?.indexedAt).toBeNull();
  });

  it("is idempotent: running twice with no changes produces zero deltas", async () => {
    await writeRemotePair("alice", "claude-code", "a3333333-3333-3333-3333-333333333333", {
      title: "Stable",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);
    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.deleted).toBe(0);
  });

  it("deletes rows whose pair disappeared from the checkout", async () => {
    await writeRemotePair("alice", "claude-code", "a4444444-4444-4444-4444-444444444444", {
      title: "Will be removed",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    // Remove both files.
    const remoteRoot = getRemoteRoot();
    await fs.rm(path.join(remoteRoot, "alice", "claude-code", "a4444444-4444-4444-4444-444444444444.meta.json"));
    await fs.rm(path.join(remoteRoot, "alice", "claude-code", "a4444444-4444-4444-4444-444444444444.jsonl"));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(1);
    const remaining = await listConversations({ origin: "remote" });
    expect(remaining).toHaveLength(0);
  });

  it("warns and skips incomplete pairs without deleting an existing row", async () => {
    const id = "a5555555-5555-5555-5555-555555555555";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Valid first pass",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    // Remove only the meta.json — incomplete pair on next pass.
    const remoteRoot = getRemoteRoot();
    await fs.rm(path.join(remoteRoot, "alice", "claude-code", `${id}.meta.json`));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(stats.warnings.some((w) => w.code === "remote_incomplete_pair")).toBe(true);

    const row = await listConversations({ origin: "remote" });
    expect(row).toHaveLength(1);
    expect(row[0]?.title).toBe("Valid first pass");
  });

  it("warns and skips invalid meta.json without deleting an existing row", async () => {
    const id = "a6666666-6666-6666-6666-666666666666";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Valid first pass",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const remoteRoot = getRemoteRoot();
    await fs.writeFile(
      path.join(remoteRoot, "alice", "claude-code", `${id}.meta.json`),
      "{ not valid json",
      "utf8",
    );

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "remote_invalid_metadata")).toBe(true);

    const row = await listConversations({ origin: "remote" });
    expect(row).toHaveLength(1);
  });

  it("skips pairs whose id@source is in the excluded file", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Should be excluded",
      messageCount: 2,
    });

    await fs.writeFile(
      path.join(tempDir, "excluded"),
      `${id}@claude-code\n`,
      "utf8",
    );

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);

    const rows = await listConversations({ origin: "remote" });
    expect(rows).toHaveLength(0);
  });

  it("lets local takes precedence: existing origin IS NULL blocks remote import", async () => {
    const id = "a8888888-8888-8888-8888-888888888888";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation({
      id,
      sourceId: id,
      source: "claude-code",
      title: "My local copy",
      summary: "",
      author: "alice",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: timestamp,
      discoveredAt: timestamp,
      modifiedAt: timestamp,
      state: "published",
      publishedAt: timestamp,
      publishedMessageCount: 2,
      publishVersion: 1,
      sourcePath: "/tmp/local.jsonl",
      filePath: "/tmp/local.jsonl",
      sourceMtime: null,
      indexedAt: null,
      origin: null,
    });

    await writeRemotePair("bob", "claude-code", id, {
      title: "Bob's published copy",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);

    const row = await getConversationById(id);
    expect(row?.title).toBe("My local copy");
    expect(row?.origin).toBeNull();
  });

  it("resolves remote-vs-remote duplicates by scan order (alice before bob)", async () => {
    const id = "a9999999-9999-9999-9999-999999999999";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Alice's copy",
      messageCount: 2,
    });
    await writeRemotePair("bob", "claude-code", id, {
      title: "Bob's copy",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(1);
    const rows = await listConversations({ origin: "remote" });
    expect(rows).toHaveLength(1);
    expect(rows[0]?.title).toBe("Alice's copy");
  });

  it("warns and skips unsupported source directories without deletion", async () => {
    const remoteRoot = getRemoteRoot();
    const unknownDir = path.join(remoteRoot, "alice", "not-a-source");
    await fs.mkdir(unknownDir, { recursive: true });
    await fs.writeFile(path.join(unknownDir, "stub.meta.json"), "{}", "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.warnings.some((w) => w.code === "unsupported_source")).toBe(true);
    // The stub files in the unknown source dir should not be touched, just warned about.
    await expect(
      fs.stat(path.join(unknownDir, "stub.meta.json")),
    ).resolves.toBeTruthy();
  });

  it("scopes reconciliation to the configured remote URL only", async () => {
    const id = "b1111111-1111-1111-1111-111111111111";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation({
      id,
      sourceId: id,
      source: "claude-code",
      title: "From other remote",
      summary: "",
      author: "carol",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: timestamp,
      discoveredAt: timestamp,
      modifiedAt: timestamp,
      state: "published",
      publishedAt: timestamp,
      publishedMessageCount: 2,
      publishVersion: 1,
      sourcePath: "/tmp/unreachable.jsonl",
      filePath: "/tmp/unreachable.jsonl",
      sourceMtime: null,
      indexedAt: null,
      origin: OTHER_REMOTE,
    });

    // No pairs for REMOTE_URL on disk. The row from OTHER_REMOTE should be left alone.
    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    const row = await getConversationById(id);
    expect(row?.origin).toBe(OTHER_REMOTE);
  });

  it("warns and skips when the .jsonl fails to parse", async () => {
    const id = "b2222222-2222-2222-2222-222222222222";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Bad content",
      messageCount: 2,
    });

    // Corrupt the jsonl with a non-parseable line.
    const remoteRoot = getRemoteRoot();
    await fs.writeFile(
      path.join(remoteRoot, "alice", "claude-code", `${id}.jsonl`),
      "not-jsonl\n",
      "utf8",
    );

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "remote_invalid_content")).toBe(true);
  });
});

async function writeRemotePair(
  author: string,
  source: string,
  id: string,
  options: { title: string; messageCount: number },
): Promise<void> {
  const remoteRoot = getRemoteRoot();
  const sourceDir = path.join(remoteRoot, author, source);
  await fs.mkdir(sourceDir, { recursive: true });

  const createdAt = "2026-02-01T10:00:00.000Z";
  const modifiedAt = "2026-02-01T10:00:05.000Z";
  const publishedAt = "2026-02-01T10:00:03.000Z";

  const meta = {
    id,
    title: options.title,
    summary: "",
    tags: [],
    author,
    projectName: null,
    publishedAt,
    modifiedAt,
    source,
    createdAt,
    slug: null,
  };

  await fs.writeFile(
    path.join(sourceDir, `${id}.meta.json`),
    `${JSON.stringify(meta, null, 2)}\n`,
    "utf8",
  );

  const lines: unknown[] = [];
  for (let i = 0; i < options.messageCount; i += 1) {
    lines.push({
      type: "user",
      timestamp: createdAt,
      cwd: "/tmp/repo",
      message: {
        role: "user",
        content: `Message ${i}`,
      },
    });
  }

  await writeJsonl(path.join(sourceDir, `${id}.jsonl`), lines);
}
