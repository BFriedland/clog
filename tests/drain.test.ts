import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDrainCommand } from "../src/cli/drain.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import {
  ArchiveResourceError,
  createDeterministicPairArchive,
  MAX_SELECTED_PAIR_BYTES,
} from "../src/interchange/archive.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { getRawConversationPath } from "../src/utils/paths.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutputWithError } from "./helpers/output.js";

vi.mock("../src/interchange/archive.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/interchange/archive.js")>();
  return {
    ...actual,
    createDeterministicPairArchive: vi.fn(actual.createDeterministicPairArchive),
  };
});

describe("clog drain archive transport", () => {
  let tempDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-drain-test-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    await ensureClogHome({ interactive: false });
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    process.chdir(originalCwd);
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes a deterministic zip by default and preserves pair bytes", async () => {
    const id = "d1111111-1111-1111-1111-111111111111";
    const conversation = await seedSavedConversation(id, { title: "Default archive" });
    process.chdir(tempDir);

    const first = await runBuiltCommandCapturingError(buildDrainCommand, [id]);
    expect(first.error).toBeNull();
    expect(first.exitCode).toBeUndefined();
    expect(first.stderr).toContain("Exported 1 conversation to ./clog-export.zip");
    const firstBytes = await fs.readFile(path.join(tempDir, "clog-export.zip"));
    const decoded = unzipSync(firstBytes);
    const entryNames = Object.keys(decoded);
    expect(entryNames).toEqual([
      `claude-code/${id}.jsonl`,
      `claude-code/${id}.meta.json`,
    ]);
    expect(Buffer.from(decoded[`claude-code/${id}.jsonl`]!)).toEqual(
      await fs.readFile(conversation.filePath!),
    );

    await fs.rm(path.join(tempDir, "clog-export.zip"));
    await runBuiltCommandCapturingError(buildDrainCommand, [id]);
    expect(await fs.readFile(path.join(tempDir, "clog-export.zip"))).toEqual(firstBytes);
  });

  it("writes pair output to -o and retains pair-directory partial success", async () => {
    const good = await seedSavedConversation(
      "d2222222-2222-2222-2222-222222222222",
      { tags: ["pair-partial"] },
    );
    await insertConversation(makeConversation({
      id: "d3333333-3333-3333-3333-333333333333",
      sourceId: "d3333333-3333-3333-3333-333333333333",
      state: "saved",
      savedAt: "2026-02-01T10:00:00.000Z",
      saveVersion: 1,
      filePath: path.join(tempDir, "missing.jsonl"),
      tags: ["pair-partial"],
    }));
    const output = path.join(tempDir, "pairs");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "pair-partial",
      "--format",
      "pair",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Exported 1 conversation to ${output}${path.sep} (1 failed)`);
    await expect(
      fs.access(path.join(output, good.source, `${good.id}.meta.json`)),
    ).resolves.toBeUndefined();
  });

  it("exports readable saved rows from a syntactically valid unknown source", async () => {
    const id = "dabababa-baba-baba-baba-babababababa";
    const contentPath = path.join(tempDir, "future-agent.jsonl");
    await fs.writeFile(contentPath, "future source bytes\n");
    await insertConversation(makeConversation({
      id,
      sourceId: id,
      source: "future-agent",
      state: "saved",
      savedAt: "2026-02-01T10:00:00.000Z",
      saveVersion: 1,
      filePath: contentPath,
      sourcePath: contentPath,
    }));
    const output = path.join(tempDir, "archive-without-extension");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [id, "-o", output]);

    expect(result.error).toBeNull();
    const decoded = unzipSync(await fs.readFile(output));
    expect(Buffer.from(decoded[`future-agent/${id}.jsonl`]!).toString("utf8")).toBe(
      "future source bytes\n",
    );
    await expect(fs.access(`${output}.zip`)).rejects.toThrow();
  });

  it("keeps pair conflict behavior and replaces both sides only with --force", async () => {
    const conversation = await seedSavedConversation(
      "dbacacac-acac-acac-acac-acacacacacac",
    );
    const output = path.join(tempDir, "pair-conflict");
    const sourceOutput = path.join(output, conversation.source);
    const metadataPath = path.join(sourceOutput, `${conversation.id}.meta.json`);
    const jsonlPath = path.join(sourceOutput, `${conversation.id}.jsonl`);
    await fs.mkdir(sourceOutput, { recursive: true });
    await fs.writeFile(metadataPath, "existing metadata\n");

    const blocked = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "--format",
      "pair",
      "-o",
      output,
    ]);
    expect(blocked.error).toBeNull();
    expect(blocked.exitCode).toBe(1);
    expect(await fs.readFile(metadataPath, "utf8")).toBe("existing metadata\n");
    await expect(fs.access(jsonlPath)).rejects.toThrow();

    const forced = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "--format",
      "pair",
      "-o",
      output,
      "--force",
    ]);
    expect(forced.error).toBeNull();
    expect(forced.exitCode).toBeUndefined();
    expect(JSON.parse(await fs.readFile(metadataPath, "utf8"))).toMatchObject({
      id: conversation.id,
      source: conversation.source,
    });
    await expect(fs.access(jsonlPath)).resolves.toBeUndefined();
  });

  it("publishes no archive and preserves a forced destination after a conversation failure", async () => {
    await seedSavedConversation(
      "d4444444-4444-4444-4444-444444444444",
      { tags: ["archive-atomic"] },
    );
    const missingId = "d5555555-5555-5555-5555-555555555555";
    await insertConversation(makeConversation({
      id: missingId,
      sourceId: missingId,
      state: "saved",
      savedAt: "2026-02-01T10:00:00.000Z",
      saveVersion: 1,
      filePath: path.join(tempDir, "missing-archive.jsonl"),
      tags: ["archive-atomic"],
    }));
    const output = path.join(tempDir, "existing.zip");
    await fs.writeFile(output, "existing archive bytes");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "archive-atomic",
      "-o",
      output,
      "--force",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`Exported 0 conversations to ${output} (1 failed)`);
    expect(await fs.readFile(output, "utf8")).toBe("existing archive bytes");
    expect(result.stderr).not.toContain("clog-private-");
  });

  it("shows the first drain failure by default and expands later failures on request", async () => {
    const firstId = "d5656565-5656-5656-5656-565656565656";
    const secondId = "d5757575-5757-5757-5757-575757575757";
    for (const id of [firstId, secondId]) {
      await insertConversation(makeConversation({
        id,
        sourceId: id,
        state: "saved",
        savedAt: "2026-02-01T10:00:00.000Z",
        saveVersion: 1,
        filePath: path.join(tempDir, `${id}-missing.jsonl`),
        tags: ["bounded-drain-errors"],
      }));
    }

    const collapsedOutput = path.join(tempDir, "collapsed-failures.zip");
    const collapsed = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "bounded-drain-errors",
      "-o",
      collapsedOutput,
    ]);

    expect(collapsed.error).toBeNull();
    expect(collapsed.exitCode).toBe(1);
    expect(collapsed.stderr).toContain(`Could not export ${firstId.slice(0, 8)}@claude-code`);
    expect(collapsed.stderr).not.toContain(`Could not export ${secondId.slice(0, 8)}@claude-code`);
    expect(collapsed.stderr).toContain(
      "error: 2 conversations could not be exported; only the first failure is shown. Re-run with --show-all-errors to list every failure.",
    );
    expect(collapsed.stderr).toContain(`Exported 0 conversations to ${collapsedOutput} (2 failed)`);
    await expect(fs.access(collapsedOutput)).rejects.toThrow();

    const expandedOutput = path.join(tempDir, "expanded-failures.zip");
    const expanded = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "bounded-drain-errors",
      "-o",
      expandedOutput,
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBe(1);
    expect(expanded.stderr).toContain(`Could not export ${firstId.slice(0, 8)}@claude-code`);
    expect(expanded.stderr).toContain(`Could not export ${secondId.slice(0, 8)}@claude-code`);
    expect(expanded.stderr).not.toContain("only the first failure is shown");
    expect(expanded.stderr).toContain(`Exported 0 conversations to ${expandedOutput} (2 failed)`);
    await expect(fs.access(expandedOutput)).rejects.toThrow();
  });

  it("reports archive entry collisions without exposing temporary paths", async () => {
    if (!(await directoryIsCaseInsensitive(tempDir))) {
      return;
    }

    const upperId = "DABABABA-BABA-BABA-BABA-BABABABABABA";
    const lowerId = upperId.toLowerCase();
    const rawPath = path.join(tempDir, "case-collision-content.jsonl");
    await writeJsonl(rawPath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/projects/webapp",
        message: { role: "user", content: "Case collision export" },
      },
    ]);
    for (const id of [upperId, lowerId]) {
      await insertConversation(makeConversation({
        id,
        sourceId: id,
        state: "saved",
        savedAt: "2026-02-01T10:00:00.000Z",
        savedMessageCount: 1,
        saveVersion: 1,
        filePath: rawPath,
        sourcePath: rawPath,
        tags: ["archive-case-collision"],
      }));
    }
    const output = path.join(tempDir, "case-collision.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "archive-case-collision",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Archive entry claude-code/");
    expect(result.stderr).toContain("collides with another selected conversation on this filesystem");
    expect(result.stderr).toContain("No archive was written");
    expect(result.stderr).toContain("--force cannot resolve collisions inside one archive export");
    expect(result.stderr).toContain(`Exported 0 conversations to ${output} (1 failed)`);
    expect(result.stderr).not.toContain("clog-private-");
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("publishes nothing after a representative archive resource failure", async () => {
    const id = "d4545454-4545-4545-4545-454545454545";
    await seedSavedConversation(id);
    const createArchiveMock = vi.mocked(createDeterministicPairArchive);
    const resourceFailure = () => new ArchiveResourceError(
      `Archive selected pair bytes observed ${MAX_SELECTED_PAIR_BYTES + 1}; limit is ${MAX_SELECTED_PAIR_BYTES}. Use unpacked pair-directory input or output instead.`,
    );

    const absentOutput = path.join(tempDir, "absent-resource-output.zip");
    createArchiveMock.mockRejectedValueOnce(resourceFailure());
    const absentResult = await runBuiltCommandCapturingError(buildDrainCommand, [
      id,
      "-o",
      absentOutput,
    ]);

    expect(absentResult.error).toMatchObject({ exitCode: 1 });
    expect((absentResult.error as Error).message).toContain(
      `selected pair bytes observed ${MAX_SELECTED_PAIR_BYTES + 1}`,
    );
    await expect(fs.access(absentOutput)).rejects.toThrow();

    const forcedOutput = path.join(tempDir, "forced-resource-output.zip");
    await fs.writeFile(forcedOutput, "existing archive bytes");
    createArchiveMock.mockRejectedValueOnce(resourceFailure());
    const forcedResult = await runBuiltCommandCapturingError(buildDrainCommand, [
      id,
      "-o",
      forcedOutput,
      "--force",
    ]);

    expect(forcedResult.error).toMatchObject({ exitCode: 1 });
    expect(await fs.readFile(forcedOutput, "utf8")).toBe("existing archive bytes");
    expect(createArchiveMock).toHaveBeenCalledTimes(2);
  });

  it("skips unsaved rows from broad selections and fails explicitly named unsaved rows", async () => {
    const saved = await seedSavedConversation(
      "d6666666-6666-6666-6666-666666666666",
      { tags: ["saved-only"] },
    );
    const unsavedId = "d7777777-7777-7777-7777-777777777777";
    await insertConversation(makeConversation({
      id: unsavedId,
      sourceId: unsavedId,
      tags: ["saved-only"],
    }));
    const broadOutput = path.join(tempDir, "broad.zip");

    const broad = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--tag",
      "saved-only",
      "-o",
      broadOutput,
    ]);
    expect(broad.error).toBeNull();
    expect(broad.exitCode).toBeUndefined();
    expect(broad.stderr).toContain("1 unsaved skipped");
    expect(Object.keys(unzipSync(await fs.readFile(broadOutput)))).toEqual([
      `claude-code/${saved.id}.jsonl`,
      `claude-code/${saved.id}.meta.json`,
    ]);

    const explicitOutput = path.join(tempDir, "explicit-unsaved.zip");
    const explicit = await runBuiltCommandCapturingError(buildDrainCommand, [
      unsavedId,
      "-o",
      explicitOutput,
    ]);
    expect(explicit.error).toBeNull();
    expect(explicit.exitCode).toBe(1);
    await expect(fs.access(explicitOutput)).rejects.toThrow();
  });

  it("treats --state saved as an explicit all-author and all-origin selection", async () => {
    const alice = await seedSavedConversation(
      "d8888888-8888-8888-8888-888888888888",
      { author: "alice" },
    );
    const bob = await seedSavedConversation(
      "d9999999-9999-9999-9999-999999999999",
      { author: "bob", originKind: "git", originRef: "git@example.com:team/repo.git" },
    );
    const output = path.join(tempDir, "all-saved.zip");

    await runBuiltCommandCapturingError(buildDrainCommand, [
      "--state",
      "saved",
      "-o",
      output,
    ]);

    const names = Object.keys(unzipSync(await fs.readFile(output)));
    expect(names).toContain(`claude-code/${alice.id}.meta.json`);
    expect(names).toContain(`claude-code/${bob.id}.meta.json`);
  });

  it("requires explicit selection and rejects empty constrained filter values", async () => {
    for (const args of [
      [] as string[],
      ["-o", path.join(tempDir, "bare.zip")],
      ["--refresh", "--force"],
      ["--tag", ""],
      ["--origin", ""],
    ]) {
      const result = await runBuiltCommandCapturingError(buildDrainCommand, args);
      expect(result.error).toMatchObject({ exitCode: 2 });
    }
  });

  it("reports migration guidance for removed destinations and render formats", async () => {
    const command = buildDrainCommand();
    const help = command.helpInformation();
    expect(help).toContain("--output");
    expect(help).not.toContain("--to-dir");
    expect(help).not.toContain("--raw");

    for (const [args, message] of [
      [["abcd", "--to", "out.zip"], "--output"],
      [["abcd", "--to-dir", "out"], "--output"],
      [["abcd", "--raw"], "clog show"],
      [["abcd", "--format", "json"], "clog show"],
      [["abcd", "--format", "md"], "clog show"],
    ] as const) {
      const result = await runBuiltCommandCapturingError(buildDrainCommand, [...args]);
      expect(result.error).toMatchObject({ exitCode: 2 });
      expect((result.error as Error).message).toContain(message);
    }
  });

  it("requires -o for pair output and rejects ineligible archive destinations", async () => {
    const conversation = await seedSavedConversation(
      "daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const missingPairOutput = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "--format",
      "pair",
    ]);
    expect(missingPairOutput.error).toMatchObject({ exitCode: 2 });

    const directoryDestination = path.join(tempDir, "directory.zip");
    await fs.mkdir(directoryDestination);
    const directoryResult = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "-o",
      directoryDestination,
    ]);
    expect(directoryResult.error).toMatchObject({ exitCode: 1 });

    const missingParentResult = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "-o",
      path.join(tempDir, "missing", "archive.zip"),
    ]);
    expect(missingParentResult.error).toMatchObject({ exitCode: 1 });
  });
});

async function seedSavedConversation(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", id);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await writeJsonl(rawPath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/projects/webapp",
      message: { role: "user", content: `Conversation ${id}` },
    },
  ]);
  const conversation = makeConversation({
    id,
    sourceId: id,
    state: "saved",
    savedAt: "2026-02-01T10:00:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    filePath: rawPath,
    sourcePath: rawPath,
    ...overrides,
  });
  await insertConversation(conversation);
  return conversation;
}

async function directoryIsCaseInsensitive(directory: string): Promise<boolean> {
  const probePath = path.join(directory, "CASE-SENSITIVITY-PROBE");
  await fs.writeFile(probePath, "probe");
  try {
    return await fs.readFile(probePath.toLowerCase(), "utf8") === "probe";
  } catch {
    return false;
  } finally {
    await fs.rm(probePath, { force: true });
  }
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const timestamp = "2026-02-01T10:00:00.000Z";
  const id = overrides.id ?? "dbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Test conversation",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: "webapp",
    projectPath: "/Users/alice/projects/webapp",
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "unsaved",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: path.join(os.tmpdir(), `${id}.jsonl`),
    filePath: null,
    sourceMtime: timestamp,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}

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
      const command = builder();
      command.exitOverride();
      await command.parseAsync(args, { from: "user" });
    });
    return { ...result, exitCode: process.exitCode };
  } finally {
    process.exitCode = previousExitCode;
  }
}
