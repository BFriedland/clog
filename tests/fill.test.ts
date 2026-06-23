import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildFillCommand } from "../src/cli/fill.js";
import { buildRemoveCommand } from "../src/cli/remove.js";
import { buildTagCommand } from "../src/cli/tag.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import {
  getConversationById,
  insertConversation,
  setConversationIndexedAt,
} from "../src/db/index.js";
import { planFill, type FillMode } from "../src/interchange/fill.js";
import { writePair, type PairMetadata, type ValidatedPair } from "../src/interchange/pairs.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  getImportConversationPath,
  getRawConversationPath,
} from "../src/utils/paths.js";
import { captureOutputWithError } from "./helpers/output.js";

describe("clog fill", () => {
  let tempDir: string;
  let pairDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-fill-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    pairDir = path.join(tempDir, "pairs");

    await ensureClogHome({ interactive: false });

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("imports foreign pairs as read-only file rows with managed content", async () => {
    const id = "a1111111-1111-1111-1111-111111111111";
    await writePairFixture(pairDir, id, { author: "bob", title: "Bob debug" }, 2);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("Processed 1 conversation pair");
    expect(result.stderr).toContain("clog list --all");

    const row = await getConversationById(id);
    expect(row).toMatchObject({
      originKind: "file",
      originRef: null,
      state: "saved",
      author: "bob",
      projectPath: null,
      savedMessageCount: 2,
    });
    expect(row?.filePath).toBe(getImportConversationPath("claude-code", id));
    expect(row?.sourcePath).toBe(row?.filePath);

    await fs.rm(pairDir, { recursive: true, force: true });
    await expect(fs.readFile(row!.filePath!, "utf8")).resolves.toContain("Message 1");
  });

  it("hints to use --own when every importable pair is the configured author's", async () => {
    const id = "ad111111-1111-1111-1111-111111111111";
    await writePairFixture(pairDir, id, { author: "alice", title: "My own debug" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("clog fill <dir> --own");
    expect(result.stderr).not.toContain("clog list --all");

    const row = await getConversationById(id);
    expect(row).toMatchObject({
      originKind: "file",
      author: "alice",
    });
  });

  it("restores own pairs as editable local rows with --own", async () => {
    const id = "a2222222-2222-2222-2222-222222222222";
    await writePairFixture(pairDir, id, { author: "alice", title: "My debug" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir, "--own"]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    const row = await getConversationById(id);
    expect(row).toMatchObject({
      originKind: "local",
      originRef: null,
      state: "saved",
      author: "alice",
      projectPath: null,
    });
    expect(row?.filePath).toBe(getRawConversationPath("claude-code", id));
    expect(row?.sourcePath).toBe(row?.filePath);

    await runBuiltCommandCapturingError(buildTagCommand, [id, "restored"]);
    const tagged = await getConversationById(id);
    expect(tagged?.tags).toContain("restored");
  });

  it("fails before writes when a failure-class candidate is present", async () => {
    const goodId = "a3333333-3333-3333-3333-333333333333";
    const badId = "a4444444-4444-4444-4444-444444444444";
    await writePairFixture(pairDir, goodId, { author: "bob" }, 1);
    await fs.mkdir(path.join(pairDir, "broken"), { recursive: true });
    await fs.writeFile(
      path.join(pairDir, "broken", `${badId}.jsonl`),
      makeClaudeJsonl(1),
      "utf8",
    );

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("incomplete pair");
    expect(result.stderr).toContain("fill found errors in the input directory");
    expect(result.stderr).toContain("no conversations were imported");
    expect(result.stderr).not.toContain("Filled ");
    expect(result.stderr).not.toContain("clog list --all");
    expect(await getConversationById(goodId)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", goodId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("allows partial imports while still exiting 1", async () => {
    const goodId = "a5555555-5555-5555-5555-555555555555";
    const badId = "a6666666-6666-6666-6666-666666666666";
    await writePairFixture(pairDir, goodId, { author: "bob" }, 1);
    await fs.writeFile(path.join(pairDir, `${badId}.jsonl`), makeClaudeJsonl(1), "utf8");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--allow-partial",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(await getConversationById(goodId)).not.toBeNull();
    expect(await getConversationById(badId)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", goodId))).resolves.toBeTruthy();
  });

  it("rejects duplicate input identities without choosing a winner", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    await writePairFixture(path.join(pairDir, "alice"), id, { author: "alice", title: "Alice" }, 1);
    await writePairFixture(path.join(pairDir, "bob"), id, { author: "bob", title: "Bob" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--allow-partial",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("duplicate input identity");
    expect(await getConversationById(id)).toBeNull();
  });

  it("supports dry-run without writing rows or managed files", async () => {
    const id = "a8888888-8888-8888-8888-888888888888";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--dry-run",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("Dry run: would process 1 conversation pair");
    expect(await getConversationById(id)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", id))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("previews the fail-before-writes abort under --dry-run", async () => {
    const goodId = "ac111111-1111-1111-1111-111111111111";
    const badId = "ac222222-2222-2222-2222-222222222222";
    await writePairFixture(pairDir, goodId, { author: "bob" }, 1);
    await fs.mkdir(path.join(pairDir, "broken"), { recursive: true });
    await fs.writeFile(
      path.join(pairDir, "broken", `${badId}.jsonl`),
      makeClaudeJsonl(1),
      "utf8",
    );

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--dry-run",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("incomplete pair");
    expect(result.stderr).toContain("no conversations would be imported");
    expect(result.stderr).not.toContain("would process");
    expect(result.stderr).not.toContain("1 new");
    expect(result.stderr).not.toContain("clog list --all");
    expect(await getConversationById(goodId)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", goodId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("previews the --own author-guard abort without counting matching pairs", async () => {
    const ownId = "ac333333-3333-3333-3333-333333333333";
    const foreignId = "ac444444-4444-4444-4444-444444444444";
    await writePairFixture(pairDir, ownId, { author: "alice" }, 1);
    await writePairFixture(pairDir, foreignId, { author: "bob" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--own",
      "--dry-run",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("fill --own found pairs by another author");
    expect(result.stderr).toContain("no conversations would be imported");
    expect(result.stderr).not.toContain("would process");
    expect(await getConversationById(ownId)).toBeNull();
    expect(await getConversationById(foreignId)).toBeNull();
  });

  it("updates file rows without recopying content for metadata-only changes", async () => {
    const id = "a9999999-9999-9999-9999-999999999999";
    await writePairFixture(pairDir, id, { author: "bob", title: "Initial", tags: ["one"] }, 1);
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);
    await setConversationIndexedAt(id, "2026-03-01T10:00:00.000Z");

    const managedPath = getImportConversationPath("claude-code", id);
    const firstContent = await fs.readFile(managedPath, "utf8");

    await writePairFixture(
      pairDir,
      id,
      { author: "bob", title: "Initial", tags: ["two"] },
      1,
      "Same message count but different bytes",
    );
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    let row = await getConversationById(id);
    expect(row?.tags).toEqual(["two"]);
    expect(row?.indexedAt).toBe("2026-03-01T10:00:00.000Z");
    expect(await fs.readFile(managedPath, "utf8")).toBe(firstContent);

    await writePairFixture(
      pairDir,
      id,
      { author: "bob", title: "Retitled", tags: ["two"] },
      1,
      "Still not recopied",
    );
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    row = await getConversationById(id);
    expect(row?.title).toBe("Retitled");
    expect(row?.indexedAt).toBeNull();
    expect(await fs.readFile(managedPath, "utf8")).toBe(firstContent);

    await writePairFixture(pairDir, id, { author: "bob", title: "Retitled" }, 2);
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    row = await getConversationById(id);
    expect(row?.savedMessageCount).toBe(2);
    expect(await fs.readFile(managedPath, "utf8")).toContain("Message 1");
  });

  it("applies clogignore import rules and reports one skip summary", async () => {
    const ignoredId = "b1111111-1111-1111-1111-111111111111";
    const importedId = "b2222222-2222-2222-2222-222222222222";
    await writePairFixture(pairDir, ignoredId, { author: "bob", projectName: "secret" }, 1);
    await writePairFixture(pairDir, importedId, { author: "bob", projectName: "visible" }, 1);
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), "secret\n*/pairs\n", "utf8");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("Processed 2 conversation pairs");
    expect(result.stderr).toContain("(1 new; 1 skipped)");
    expect(result.stderr).toContain("1 conversation pair skipped by clogignore");
    expect(await getConversationById(ignoredId)).toBeNull();
    expect(await getConversationById(importedId)).not.toBeNull();
  });

  it("fails closed when --own sees a foreign author", async () => {
    const ownId = "b3333333-3333-3333-3333-333333333333";
    const foreignId = "b4444444-4444-4444-4444-444444444444";
    await writePairFixture(pairDir, ownId, { author: "alice" }, 1);
    await writePairFixture(pairDir, foreignId, { author: "bob" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir, "--own", "--allow-partial"]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain('pair author "bob"');
    expect(result.stderr).toContain("fill --own found pairs by another author");
    expect(result.stderr).not.toContain("--allow-partial");
    expect(result.stderr).not.toContain("Filled ");
    expect(await getConversationById(ownId)).toBeNull();
    expect(await getConversationById(foreignId)).toBeNull();
    await expect(fs.stat(getRawConversationPath("claude-code", ownId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("removes managed import content and warns for restored local only-copies", async () => {
    const fileId = "b5555555-5555-5555-5555-555555555555";
    await writePairFixture(pairDir, fileId, { author: "bob" }, 1);
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    const fileRemove = await runBuiltCommandCapturingError(buildRemoveCommand, [
      fileId,
      "--yes",
    ]);
    expect(fileRemove.error).toBeNull();
    expect(fileRemove.stdout).toContain("raw/ or imports/");
    expect(await getConversationById(fileId)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", fileId))).rejects.toMatchObject({
      code: "ENOENT",
    });

    const ownId = "b6666666-6666-6666-6666-666666666666";
    const ownPairDir = path.join(tempDir, "own-pairs");
    await writePairFixture(ownPairDir, ownId, { author: "alice" }, 1);
    await runBuiltCommandCapturingError(buildFillCommand, [ownPairDir, "--own"]);

    const preview = await runBuiltCommandCapturingError(buildRemoveCommand, [
      ownId,
      "--dry-run",
    ]);
    expect(preview.error).toBeNull();
    expect(preview.stdout).toContain("may be the only local transcript copies");
  });

  it("reports unindexed filled rows when search is configured", async () => {
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].enabled = false;
    config.search = {
      embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
      vectorStore: { type: "vectra" },
    };
    await saveConfig(config);

    const id = "b7777777-7777-7777-7777-777777777777";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain("Run 'clog index'");
  });

  it("restores over discovered local rows through the command", async () => {
    const id = "b8a8a8a8-a8a8-a8a8-a8a8-a8a8a8a8a8a8";
    await insertConversation(conversation({
      id,
      sourceId: id,
      state: "discovered",
      filePath: null,
      sourcePath: path.join(tempDir, "source", `${id}.jsonl`),
      sourceMtime: "2026-02-19T09:20:00.000Z",
      savedAt: null,
      savedMessageCount: null,
      saveVersion: 0,
      discoveredAt: "2026-02-19T09:16:00.000Z",
    }));
    await writePairFixture(pairDir, id, { author: "alice", title: "Restored pair" }, 2);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir, "--own"]);

    expect(result.error).toBeNull();
    const row = await getConversationById(id);
    expect(row).toMatchObject({
      id,
      originKind: "local",
      state: "saved",
      title: "Restored pair",
      projectPath: null,
      discoveredAt: "2026-02-19T09:16:00.000Z",
      savedMessageCount: 2,
    });
    expect(row?.filePath).toBe(getRawConversationPath("claude-code", id));
    expect(row?.sourcePath).toBe(row?.filePath);
    await expect(fs.readFile(row!.filePath!, "utf8")).resolves.toContain("Message 1");
  });

  it("self-heals when managed content was overwritten before the DB row updated", async () => {
    const id = "b9a9a9a9-a9a9-a9a9-a9a9-a9a9a9a9a9a9";
    await writePairFixture(pairDir, id, { author: "bob", title: "Crash window" }, 1);
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    const managedPath = getImportConversationPath("claude-code", id);
    await writePairFixture(pairDir, id, { author: "bob", title: "Crash window" }, 2);
    await fs.copyFile(path.join(pairDir, `${id}.jsonl`), managedPath);

    const staleRow = await getConversationById(id);
    expect(staleRow?.savedMessageCount).toBe(1);
    expect(await fs.readFile(managedPath, "utf8")).toContain("Message 1");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    const healedRow = await getConversationById(id);
    expect(healedRow?.savedMessageCount).toBe(2);
    expect(await fs.readFile(managedPath, "utf8")).toContain("Message 1");
  });

  it("recreates a missing managed import copy when the row is otherwise unchanged", async () => {
    const id = "ba0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
    await writePairFixture(pairDir, id, { author: "bob", title: "Missing managed copy" }, 1);
    await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);
    await setConversationIndexedAt(id, "2026-03-01T10:00:00.000Z");

    const managedPath = getImportConversationPath("claude-code", id);
    await fs.rm(managedPath);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain("1 updated");
    await expect(fs.readFile(managedPath, "utf8")).resolves.toContain("Message 0");
    const row = await getConversationById(id);
    expect(row?.indexedAt).toBe("2026-03-01T10:00:00.000Z");
  });

  it("plans the fill collision matrix without unique-constraint failures", () => {
    const pair = validatedPair("b8888888-8888-8888-8888-888888888888", {
      author: "alice",
      title: "Incoming",
    });

    expect(singleAction({ pair, mode: "file", owner: conversation({ state: "discovered" }) })).toMatchObject({
      kind: "skip",
      reason: "local_discovered_precedence",
      failure: false,
    });
    expect(singleAction({ pair, mode: "own", owner: conversation({ state: "discovered" }) })).toMatchObject({
      kind: "restore_discovered",
    });
    expect(singleAction({ pair, mode: "file", owner: conversation({ state: "saved" }) })).toMatchObject({
      kind: "skip",
      reason: "local_saved_precedence",
      failure: false,
    });
    expect(singleAction({ pair, mode: "own", owner: conversation({ state: "saved" }) })).toMatchObject({
      kind: "skip",
      reason: "local_saved_precedence",
      failure: false,
    });
    expect(singleAction({
      pair,
      mode: "file",
      owner: conversation({ originKind: "file", originRef: null, title: "Old" }),
    })).toMatchObject({
      kind: "update",
    });
    expect(singleAction({
      pair,
      mode: "own",
      owner: conversation({ originKind: "file", originRef: null }),
    })).toMatchObject({
      kind: "skip",
      reason: "unsupported_promotion",
      failure: true,
    });
    expect(singleAction({
      pair,
      mode: "file",
      owner: conversation({ originKind: "git", originRef: "git@example.com:repo.git" }),
    })).toMatchObject({
      kind: "skip",
      reason: "git_collision",
      failure: true,
    });
    expect(singleAction({
      pair,
      mode: "own",
      owner: conversation({ originKind: "git", originRef: "git@example.com:repo.git" }),
    })).toMatchObject({
      kind: "skip",
      reason: "unsupported_promotion",
      failure: true,
    });
  });
});

async function runBuiltCommandCapturingError(
  builder: () => Command,
  args: string[],
): Promise<{
  stdout: string;
  stderr: string;
  error: unknown;
  exitCode: typeof process.exitCode;
}> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    const result = await captureOutputWithError(async () => {
      const cmd = builder();
      cmd.exitOverride();
      await cmd.parseAsync(args, { from: "user" });
    });
    return { ...result, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}

async function writePairFixture(
  dir: string,
  id: string,
  overrides: Partial<PairMetadata>,
  messageCount: number,
  messagePrefix = "Message",
): Promise<void> {
  await writePair({
    metaPath: path.join(dir, `${id}.meta.json`),
    jsonlPath: path.join(dir, `${id}.jsonl`),
    meta: makePairMetadata(id, overrides),
    jsonl: makeClaudeJsonl(messageCount, messagePrefix),
  });
}

function makePairMetadata(id: string, overrides: Partial<PairMetadata> = {}): PairMetadata {
  return {
    id,
    title: "Imported conversation",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    tags: [],
    author: "bob",
    projectName: "api-service",
    savedAt: "2026-02-20T10:00:00.000Z",
    modifiedAt: "2026-02-20T10:00:00.000Z",
    source: "claude-code",
    createdAt: "2026-02-19T09:15:00.000Z",
    slug: null,
    ...overrides,
  };
}

function makeClaudeJsonl(messageCount: number, prefix = "Message"): string {
  return `${makeClaudeLines(messageCount, prefix).map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function makeClaudeLines(messageCount: number, prefix = "Message"): unknown[] {
  const lines: unknown[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    lines.push({
      type: "user",
      timestamp: `2026-02-19T09:${String(15 + index).padStart(2, "0")}:00.000Z`,
      cwd: "/tmp/api-service",
      message: {
        role: "user",
        content: `${prefix} ${index}`,
      },
    });
  }
  return lines;
}

function singleAction(args: {
  pair: ValidatedPair;
  mode: FillMode;
  owner: ConversationMeta;
}) {
  const plan = planFill({
    candidates: [{ kind: "valid", pair: args.pair }],
    existingRows: [args.owner],
    mode: args.mode,
    author: "alice",
    importTime: "2026-03-01T10:00:00.000Z",
    getManagedPath: (pair) => `/managed/${pair.meta.id}.jsonl`,
  });
  return plan.actions[0];
}

function validatedPair(id: string, overrides: Partial<PairMetadata> = {}): ValidatedPair {
  return {
    rootDir: "/tmp/pairs",
    relativeDir: "",
    stem: id,
    normalizedRelativePath: id,
    metaPath: `/tmp/pairs/${id}.meta.json`,
    jsonlPath: `/tmp/pairs/${id}.jsonl`,
    meta: makePairMetadata(id, overrides),
    messageCount: 1,
  };
}

function conversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const id = overrides.id ?? "b8888888-8888-8888-8888-888888888888";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Existing",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: [],
    slug: null,
    createdAt: "2026-02-19T09:15:00.000Z",
    discoveredAt: "2026-02-19T09:16:00.000Z",
    modifiedAt: "2026-02-19T09:16:00.000Z",
    state: "saved",
    savedAt: "2026-02-19T09:16:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: "/managed/existing.jsonl",
    filePath: "/managed/existing.jsonl",
    sourceMtime: "2026-02-19T09:16:00.000Z",
    indexedAt: null,
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}
