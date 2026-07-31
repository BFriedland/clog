import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultConfig } from "../src/config/index.js";
import {
  getConversationById,
  listConversations,
} from "../src/db/index.js";
import * as dbModule from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { reconcileRemote } from "../src/sync/pull.js";
import { getRemoteRoot } from "../src/sync/paths.js";
import { SearchNotConfiguredError } from "../src/search/errors.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";

const REMOTE_URL = "git@github.com:myorg/clog-team.git";
const OTHER_REMOTE = "git@github.com:myorg/other.git";

vi.mock("../src/search/deps.js", async () => {
  return {
    getSearchProviders: vi.fn(),
    searchAvailable: vi.fn(),
    resetSearchProviders: () => undefined,
  };
});

const depsModule = await import("../src/search/deps.js");
const mockedGetSearchProviders = vi.mocked(depsModule.getSearchProviders);

describe("sync pull reconciliation", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-sync-pull-"));
    process.env.CLOG_HOME = tempDir;
    mockedGetSearchProviders.mockReset();
    mockedGetSearchProviders.mockRejectedValue(new SearchNotConfiguredError());
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
    expect(rows[0]?.savedMessageCount).toBe(2);
    expect(rows[0]?.originKind).toBe("git");
    expect(rows[0]?.originRef).toBe(REMOTE_URL);
    expect(rows[0]?.author).toBe("alice");
    expect(rows[0]?.state).toBe("saved");
  });

  it("warns and reconciles when an enabled local source directory is missing", async () => {
    const id = "a1212121-1212-1212-1212-121212121212";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Remote conversation with unavailable local source",
      messageCount: 2,
    });
    const missingSourcePath = path.join(tempDir, "missing-claude-source");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].enabled = true;
    config.sources["claude-code"].paths = [missingSourcePath];

    const stats = await reconcileRemote(config, REMOTE_URL);

    expect(stats.inserted).toBe(1);
    expect(stats.skipped).toBe(0);
    expect(stats.warnings).toContainEqual(expect.objectContaining({
      code: "missing_source_file",
      source: "claude-code",
      path: missingSourcePath,
    }));
    await expect(getConversationById(id)).resolves.toMatchObject({
      id,
      originKind: "git",
      originRef: REMOTE_URL,
    });
  });

  it("runs the reconciliation database phase in a single withDb critical section", async () => {
    await writeRemotePair("alice", "claude-code", "a1111111-1111-1111-1111-111111111111", {
      title: "First",
      messageCount: 1,
    });
    await writeRemotePair("alice", "claude-code", "a2222222-2222-2222-2222-222222222222", {
      title: "Second",
      messageCount: 1,
    });
    await writeRemotePair("alice", "claude-code", "a3333333-3333-3333-3333-333333333333", {
      title: "Third",
      messageCount: 1,
    });

    // Reconciliation scans checkout pairs before opening the DB. Once it enters
    // the database phase, planning and all writes should share one
    // acquire/load/apply/flush/release cycle for the whole reconciliation batch.
    const withDbSpy = vi.spyOn(dbModule, "withDb");
    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);
    const withDbCalls = withDbSpy.mock.calls.length;
    withDbSpy.mockRestore();

    expect(stats.inserted).toBe(3);
    expect(withDbCalls).toBe(1);
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

  it("updates existing rows when parsed message count changes and clears indexed_at", async () => {
    const id = "a2323232-2323-2323-2323-232323232323";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Same metadata",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const existing = (await listConversations({ origin: "remote" }))[0]!;
    const { setConversationIndexedAt } = await import("../src/db/index.js");
    await setConversationIndexedAt(existing.id, "2026-03-01T00:00:00.000Z");

    await writeRemotePair("alice", "claude-code", id, {
      title: "Same metadata",
      messageCount: 3,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.updated).toBe(1);
    const refreshed = await getConversationById(id);
    expect(refreshed?.savedMessageCount).toBe(3);
    expect(refreshed?.indexedAt).toBeNull();
  });

  it("preserves indexed_at for tag-only metadata changes", async () => {
    const id = "a2424242-2424-2424-2424-242424242424";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Stable title",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const { setConversationIndexedAt } = await import("../src/db/index.js");
    await setConversationIndexedAt(id, "2026-03-01T00:00:00.000Z");

    const metaPath = path.join(getRemoteRoot(), "alice", "claude-code", `${id}.meta.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta.tags = ["new-tag"];
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.updated).toBe(1);
    const refreshed = await getConversationById(id);
    expect(refreshed?.tags).toEqual(["new-tag"]);
    expect(refreshed?.indexedAt).toBe("2026-03-01T00:00:00.000Z");
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

  it("best-effort deletes vectors for rows deleted by reconciliation", async () => {
    const id = "a4545454-4545-4545-4545-454545454545";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Will lose vectors",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    await fs.rm(path.join(getRemoteRoot(), "alice", "claude-code", `${id}.meta.json`));
    await fs.rm(path.join(getRemoteRoot(), "alice", "claude-code", `${id}.jsonl`));

    const deleteMock = vi.fn(async () => undefined);
    mockedGetSearchProviders.mockResolvedValue({
      embedding: {
        name: "test",
        dimensions: 1,
        embed: vi.fn(async () => [[0.1]]),
      },
      vectorStore: {
        upsert: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        delete: deleteMock,
      },
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(1);
    expect(deleteMock).toHaveBeenCalledWith(id);
    expect(stats.cleanupFailures).toEqual([]);
  });

  it("reports vector cleanup failures without failing reconciliation", async () => {
    const id = "a4646464-4646-4646-4646-464646464646";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Cleanup will fail",
      messageCount: 2,
    });

    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    await fs.rm(path.join(getRemoteRoot(), "alice", "claude-code", `${id}.meta.json`));
    await fs.rm(path.join(getRemoteRoot(), "alice", "claude-code", `${id}.jsonl`));

    mockedGetSearchProviders.mockResolvedValue({
      embedding: {
        name: "test",
        dimensions: 1,
        embed: vi.fn(async () => [[0.1]]),
      },
      vectorStore: {
        upsert: vi.fn(async () => undefined),
        search: vi.fn(async () => []),
        delete: vi.fn(async () => {
          throw new Error("delete failed");
        }),
      },
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(1);
    expect(stats.cleanupFailures).toEqual([id]);
    expect(await getConversationById(id)).toBeNull();
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
    expect(stats.warnings.some((w) => w.code === "pair_incomplete")).toBe(true);

    const row = await listConversations({ origin: "remote" });
    expect(row).toHaveLength(1);
    expect(row[0]?.title).toBe("Valid first pass");
  });

  it("warns and skips metadata-only incomplete pairs without deleting an existing row", async () => {
    const id = "a5656565-5656-5656-5656-565656565656";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Valid first pass",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    await fs.rm(path.join(getRemoteRoot(), "alice", "claude-code", `${id}.jsonl`));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_incomplete")).toBe(true);

    const row = await getConversationById(id);
    expect(row?.title).toBe("Valid first pass");
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
    expect(stats.warnings.some((w) => w.code === "pair_invalid_metadata")).toBe(true);

    const row = await listConversations({ origin: "remote" });
    expect(row).toHaveLength(1);
  });

  it("uses pair_id_mismatch when a remote filename stem differs from meta.id", async () => {
    const id = "a6666666-1111-1111-1111-666666666666";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Wrong ID",
      messageCount: 2,
    });

    const remoteRoot = getRemoteRoot();
    const metaPath = path.join(remoteRoot, "alice", "claude-code", `${id}.meta.json`);
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<string, unknown>;
    raw.id = "a6666666-2222-2222-2222-666666666666";
    await fs.writeFile(metaPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const warning = stats.warnings.find((w) => w.code === "pair_id_mismatch");
    expect(warning).toBeTruthy();
    expect(warning?.message).toContain(id);
    expect(warning?.message).toContain(String(raw.id));
  });

  it("uses pair_layout_mismatch when remote directory layout disagrees with metadata", async () => {
    const id = "a6666666-3333-3333-3333-666666666666";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Wrong author",
      messageCount: 2,
    });

    const remoteRoot = getRemoteRoot();
    const metaPath = path.join(remoteRoot, "alice", "claude-code", `${id}.meta.json`);
    const raw = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<string, unknown>;
    raw.author = "bob";
    await fs.writeFile(metaPath, `${JSON.stringify(raw, null, 2)}\n`, "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(true);
  });

  it("reports layout mismatch before content parse failures", async () => {
    const id = "a6666666-3434-3434-3434-666666666666";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Wrong author and bad content",
      messageCount: 2,
    });

    const metaPath = path.join(getRemoteRoot(), "alice", "claude-code", `${id}.meta.json`);
    const meta = JSON.parse(await fs.readFile(metaPath, "utf8")) as Record<string, unknown>;
    meta.author = "bob";
    await fs.writeFile(metaPath, `${JSON.stringify(meta, null, 2)}\n`, "utf8");
    await fs.writeFile(
      path.join(getRemoteRoot(), "alice", "claude-code", `${id}.jsonl`),
      "not-jsonl\n",
      "utf8",
    );

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(true);
    expect(stats.warnings.some((w) => w.code === "pair_invalid_content")).toBe(false);
  });

  it("uses pair_layout_mismatch for nested files under a supported source directory", async () => {
    const id = "a6666666-4444-4444-4444-666666666666";
    const sourceDir = path.join(getRemoteRoot(), "alice", "claude-code", "nested");
    const timestamp = "2026-02-01T10:00:00.000Z";
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, `${id}.meta.json`),
      `${JSON.stringify({
        id,
        title: "Nested pair",
        summary: "",
        tags: [],
        author: "alice",
        projectName: null,
        savedAt: timestamp,
        modifiedAt: timestamp,
        source: "claude-code",
        createdAt: timestamp,
        slug: null,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeJsonl(path.join(sourceDir, `${id}.jsonl`), [
      {
        type: "user",
        timestamp,
        cwd: "/tmp/repo",
        message: { role: "user", content: "Nested" },
      },
    ]);

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(true);
    expect(await getConversationById(id)).toBeNull();
  });

  it("collapses invalid source directory warnings to one warning per directory", async () => {
    const source = "Bad Source";
    await writeRemotePair("alice", source, "a6666666-5555-5555-5555-666666666666", {
      title: "First invalid source",
      messageCount: 1,
    });
    await writeRemotePair("alice", source, "a6666666-5656-5656-5656-666666666666", {
      title: "Second invalid source",
      messageCount: 1,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const warnings = stats.warnings.filter((w) => w.code === "pair_layout_mismatch");
    expect(stats.inserted).toBe(0);
    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain(`"alice/${source}"`);
    expect(warnings[0]?.message).toContain("not a valid source key");
  });

  it("preserves an existing row when a pair is relocated to the wrong author directory", async () => {
    const id = "a6767676-6767-6767-6767-676767676767";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Original location",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const aliceDir = path.join(getRemoteRoot(), "alice", "claude-code");
    const bobDir = path.join(getRemoteRoot(), "bob", "claude-code");
    await fs.mkdir(bobDir, { recursive: true });
    await fs.rename(path.join(aliceDir, `${id}.meta.json`), path.join(bobDir, `${id}.meta.json`));
    await fs.rename(path.join(aliceDir, `${id}.jsonl`), path.join(bobDir, `${id}.jsonl`));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(true);
    const row = await getConversationById(id);
    expect(row?.title).toBe("Original location");
  });

  it("preserves an existing row when a pair is relocated under an unsupported source directory", async () => {
    const id = "a6767676-6868-6868-6868-676767676767";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Original source",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const supportedDir = path.join(getRemoteRoot(), "alice", "claude-code");
    const unsupportedDir = path.join(getRemoteRoot(), "alice", "not-a-source");
    await fs.mkdir(unsupportedDir, { recursive: true });
    await fs.rename(path.join(supportedDir, `${id}.meta.json`), path.join(unsupportedDir, `${id}.meta.json`));
    await fs.rename(path.join(supportedDir, `${id}.jsonl`), path.join(unsupportedDir, `${id}.jsonl`));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.filter((w) => w.code === "unsupported_source")).toHaveLength(1);
    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(false);
    const row = await getConversationById(id);
    expect(row?.title).toBe("Original source");
  });

  it("protects an existing unknown-source row when a complete unknown-source pair is present", async () => {
    const id = "a6767676-6969-6969-6969-676767676767";
    const timestamp = "2026-02-01T10:00:00.000Z";
    await insertConversation(remoteConversation({
      id,
      source: "future.agent",
      title: "Future source row",
      timestamp,
    }));
    await writeRemotePair("alice", "future.agent", id, {
      title: "Future source pair",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.updated).toBe(0);
    expect(stats.deleted).toBe(0);
    expect(stats.warnings.filter((w) => w.code === "unsupported_source")).toHaveLength(1);
    const row = await getConversationById(id);
    expect(row?.title).toBe("Future source row");
  });

  it("protects a JSONL-only unknown-source path identity", async () => {
    const id = "a6767676-7070-7070-7070-676767676767";
    const timestamp = "2026-02-01T10:00:00.000Z";
    await insertConversation(remoteConversation({
      id,
      source: "future.agent",
      title: "JSONL-only future row",
      timestamp,
    }));

    const sourceDir = path.join(getRemoteRoot(), "alice", "future.agent");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(path.join(sourceDir, `${id}.jsonl`), "not parsed for unknown sources\n", "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.filter((w) => w.code === "unsupported_source")).toHaveLength(1);
    expect(await getConversationById(id)).not.toBeNull();
  });

  it("protects readable metadata identities from schema-invalid unknown-source metadata", async () => {
    const pathId = "a6767676-7171-7171-7171-676767676767";
    const metaId = "a6767676-7272-7272-7272-676767676767";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation(remoteConversation({
      id: pathId,
      source: "future.agent",
      title: "Unknown path identity",
      timestamp,
    }));
    await insertConversation(remoteConversation({
      id: metaId,
      source: "other.future",
      title: "Unknown metadata identity",
      timestamp,
    }));

    const sourceDir = path.join(getRemoteRoot(), "alice", "future.agent");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, `${pathId}.meta.json`),
      `${JSON.stringify({
        id: metaId,
        source: "other.future",
        title: "Missing required metadata fields",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(sourceDir, `${pathId}.jsonl`), "not parsed for unknown sources\n", "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.filter((w) => w.code === "unsupported_source")).toHaveLength(1);
    expect(await getConversationById(pathId)).not.toBeNull();
    expect(await getConversationById(metaId)).not.toBeNull();
  });

  it("protects an existing row when a pair is present directly under an author directory", async () => {
    const id = "a6767676-7777-7777-7777-676767676767";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Original source directory",
      messageCount: 2,
    });
    await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    const aliceDir = path.join(getRemoteRoot(), "alice");
    const sourceDir = path.join(aliceDir, "claude-code");
    await fs.rename(path.join(sourceDir, `${id}.meta.json`), path.join(aliceDir, `${id}.meta.json`));
    await fs.rename(path.join(sourceDir, `${id}.jsonl`), path.join(aliceDir, `${id}.jsonl`));

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_layout_mismatch")).toBe(true);
    const row = await getConversationById(id);
    expect(row?.title).toBe("Original source directory");
  });

  it("protects both path and metadata identities when source and id disagree", async () => {
    const pathId = "a6868686-6868-6868-6868-686868686868";
    const metaId = "a6969696-6969-6969-6969-696969696969";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation(remoteConversation({
      id: pathId,
      source: "claude-code",
      title: "Path identity",
      timestamp,
    }));
    await insertConversation(remoteConversation({
      id: metaId,
      source: "codex-cli",
      title: "Metadata identity",
      timestamp,
    }));

    const sourceDir = path.join(getRemoteRoot(), "alice", "claude-code");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, `${pathId}.meta.json`),
      `${JSON.stringify({
        id: metaId,
        title: "Mismatched pair",
        summary: "",
        tags: [],
        author: "alice",
        projectName: null,
        savedAt: timestamp,
        modifiedAt: timestamp,
        source: "codex-cli",
        createdAt: timestamp,
        slug: null,
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(sourceDir, `${pathId}.jsonl`), "not parsed because id mismatches first\n", "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_id_mismatch")).toBe(true);
    expect(await getConversationById(pathId)).not.toBeNull();
    expect(await getConversationById(metaId)).not.toBeNull();
  });

  it("protects metadata identities from readable but schema-invalid metadata", async () => {
    const pathId = "a7070707-7070-7070-7070-707070707070";
    const metaId = "a7171717-7171-7171-7171-717171717171";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation(remoteConversation({
      id: pathId,
      source: "claude-code",
      title: "Path identity",
      timestamp,
    }));
    await insertConversation(remoteConversation({
      id: metaId,
      source: "codex-cli",
      title: "Metadata identity",
      timestamp,
    }));

    const sourceDir = path.join(getRemoteRoot(), "alice", "claude-code");
    await fs.mkdir(sourceDir, { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, `${pathId}.meta.json`),
      `${JSON.stringify({
        id: metaId,
        source: "codex-cli",
        title: "Missing required metadata fields",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(sourceDir, `${pathId}.jsonl`), "not parsed because metadata is invalid\n", "utf8");

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    expect(stats.warnings.some((w) => w.code === "pair_invalid_metadata")).toBe(true);
    expect(await getConversationById(pathId)).not.toBeNull();
    expect(await getConversationById(metaId)).not.toBeNull();
  });

  it("skips pairs whose id is ignored by clogignore", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    await writeRemotePair("alice", "claude-code", id, {
      title: "Should be excluded",
      messageCount: 2,
    });

    await fs.writeFile(
      path.join(tempDir, "clogignore"),
      `${id}\n`,
      "utf8",
    );

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);
    expect(stats.ignored).toBe(1);

    const rows = await listConversations({ origin: "remote" });
    expect(rows).toHaveLength(0);
  });

  it("lets local take precedence: existing local row blocks remote import", async () => {
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
      state: "saved",
      savedAt: timestamp,
      savedMessageCount: 2,
      saveVersion: 1,
      sourcePath: "/tmp/local.jsonl",
      filePath: "/tmp/local.jsonl",
      sourceMtime: null,
      indexedAt: null,
      originKind: "local",
      originRef: null,
    });

    await writeRemotePair("bob", "claude-code", id, {
      title: "Bob's saved copy",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);

    const row = await getConversationById(id);
    expect(row?.title).toBe("My local copy");
    expect(row?.originKind).toBe("local");
    expect(row?.originRef).toBeNull();
  });

  it("lets file imports take precedence without a unique constraint failure", async () => {
    const id = "a8899999-8888-8888-8888-888888888888";
    const timestamp = "2026-02-01T10:00:00.000Z";

    await insertConversation({
      id,
      sourceId: id,
      source: "claude-code",
      title: "Filled copy",
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
      sourcePath: "/tmp/imports/claude-code/file.jsonl",
      filePath: "/tmp/imports/claude-code/file.jsonl",
      sourceMtime: null,
      indexedAt: null,
      originKind: "file",
      originRef: null,
    });

    await writeRemotePair("bob", "claude-code", id, {
      title: "Bob's saved copy",
      messageCount: 2,
    });

    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.skipped).toBeGreaterThanOrEqual(1);

    const row = await getConversationById(id);
    expect(row?.title).toBe("Filled copy");
    expect(row?.originKind).toBe("file");
    expect(row?.originRef).toBeNull();
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

  it("does not traverse .git internals as conversation pairs", async () => {
    const id = "b0101010-0101-0101-0101-010101010101";
    const gitInternalDir = path.join(getRemoteRoot(), ".git", "alice", "claude-code");
    const timestamp = "2026-02-01T10:00:00.000Z";
    await fs.mkdir(gitInternalDir, { recursive: true });
    await fs.writeFile(
      path.join(gitInternalDir, `${id}.meta.json`),
      `${JSON.stringify({
        id,
        title: "Internal git file",
        summary: "",
        tags: [],
        author: "alice",
        projectName: null,
        savedAt: timestamp,
        modifiedAt: timestamp,
        source: "claude-code",
        createdAt: timestamp,
        slug: null,
      }, null, 2)}\n`,
      "utf8",
    );
    await writeJsonl(path.join(gitInternalDir, `${id}.jsonl`), [
      {
        type: "user",
        timestamp,
        cwd: "/tmp/repo",
        message: { role: "user", content: "Ignore me" },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].enabled = false;
    const stats = await reconcileRemote(config, REMOTE_URL);

    expect(stats.inserted).toBe(0);
    expect(stats.warnings).toHaveLength(0);
    expect(await getConversationById(id)).toBeNull();
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
      state: "saved",
      savedAt: timestamp,
      savedMessageCount: 2,
      saveVersion: 1,
      sourcePath: "/tmp/unreachable.jsonl",
      filePath: "/tmp/unreachable.jsonl",
      sourceMtime: null,
      indexedAt: null,
      originKind: "git",
      originRef: OTHER_REMOTE,
    });

    // No pairs for REMOTE_URL on disk. The row from OTHER_REMOTE should be left alone.
    const stats = await reconcileRemote(getDefaultConfig("alice"), REMOTE_URL);

    expect(stats.deleted).toBe(0);
    const row = await getConversationById(id);
    expect(row?.originKind).toBe("git");
    expect(row?.originRef).toBe(OTHER_REMOTE);
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
    expect(stats.warnings.some((w) => w.code === "pair_invalid_content")).toBe(true);
  });
});

function remoteConversation(options: {
  id: string;
  source: string;
  title: string;
  timestamp: string;
}): ConversationMeta {
  return {
    id: options.id,
    sourceId: options.id,
    source: options.source,
    title: options.title,
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: null,
    projectPath: null,
    tags: [],
    slug: null,
    createdAt: options.timestamp,
    discoveredAt: options.timestamp,
    modifiedAt: options.timestamp,
    state: "saved",
    savedAt: options.timestamp,
    savedMessageCount: 2,
    saveVersion: 1,
    sourcePath: `/tmp/${options.source}/${options.id}.jsonl`,
    filePath: `/tmp/${options.source}/${options.id}.jsonl`,
    sourceMtime: null,
    indexedAt: null,
    originKind: "git",
    originRef: REMOTE_URL,
  };
}

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
  const savedAt = "2026-02-01T10:00:03.000Z";

  const meta = {
    id,
    title: options.title,
    summary: "",
    tags: [],
    author,
    projectName: null,
    savedAt,
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
