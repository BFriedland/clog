import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import type { Command } from "commander";
import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildDrainCommand } from "../src/cli/drain.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import {
  ArchiveResourceError,
  createDeterministicArchive,
  MAX_SELECTED_ARCHIVE_BYTES,
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
    createDeterministicArchive: vi.fn(actual.createDeterministicArchive),
  };
});

const repositoryRoot = process.cwd();
const tsxImport = import.meta.resolve("tsx");

describe("clog drain archive transport", () => {
  let tempDir: string;
  let originalCwd: string;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    originalCwd = process.cwd();
    originalIsTTY = process.stdin.isTTY;
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: false,
    });
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-drain-test-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    await ensureClogHome({ interactive: false });
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude-sources")];
    config.sources["codex-cli"].enabled = false;
    await fs.mkdir(config.sources["claude-code"].paths[0]!, { recursive: true });
    await saveConfig(config);
  });

  afterEach(async () => {
    vi.clearAllMocks();
    process.chdir(originalCwd);
    Object.defineProperty(process.stdin, "isTTY", {
      configurable: true,
      value: originalIsTTY,
    });
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("writes a deterministic zip by default and preserves pair bytes", async () => {
    const id = "d1111111-1111-1111-1111-111111111111";
    const parentId = "d1010101-1010-1010-1010-101010101010";
    const conversation = await seedSavedConversation(id, {
      title: "Default archive",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });
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
    expect(JSON.parse(
      Buffer.from(decoded[`claude-code/${id}.meta.json`]!).toString("utf8"),
    )).toMatchObject({
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });

    await fs.rm(path.join(tempDir, "clog-export.zip"));
    await runBuiltCommandCapturingError(buildDrainCommand, [id]);
    expect(await fs.readFile(path.join(tempDir, "clog-export.zip"))).toEqual(firstBytes);
  });

  it("reports indeterminate ID resolution when configured source discovery is incomplete", async () => {
    const sourceRoot = path.join(tempDir, "claude-sources");
    await fs.rm(sourceRoot, { recursive: true, force: true });

    const noMatch = await runBuiltCommandCapturingError(buildDrainCommand, [
      "eeeeeeee",
      "-o",
      path.join(tempDir, "no-match.zip"),
    ]);
    expect((noMatch.error as Error).message).toMatch(/could not determine/i);

    const id = "efffffff-ffff-ffff-ffff-ffffffffffff";
    await seedSavedConversation(id);
    const shortenedMatch = await runBuiltCommandCapturingError(buildDrainCommand, [
      "efff",
      "-o",
      path.join(tempDir, "shortened.zip"),
    ]);
    expect((shortenedMatch.error as Error).message).toMatch(/could not determine/i);
  });

  it("keeps an ID-shaped project selector indeterminate when discovery is incomplete", async () => {
    const sourceRoot = path.join(tempDir, "claude-sources");
    await fs.rm(sourceRoot, { recursive: true, force: true });
    const projectName = "deadbeef";
    const conversation = await seedSavedConversation(
      "d1212121-1212-1212-1212-121212121212",
      { projectName },
    );

    const bare = await runBuiltCommandCapturingError(buildDrainCommand, [
      projectName,
      "-o",
      path.join(tempDir, "ambiguous-project.zip"),
    ]);
    expect((bare.error as Error).message).toMatch(/could not determine/i);

    const explicitOutput = path.join(tempDir, "explicit-project.zip");
    const explicit = await runBuiltCommandCapturingError(buildDrainCommand, [
      `project:${projectName}`,
      "-o",
      explicitOutput,
    ]);
    expect(explicit.error).toBeNull();
    expect(Object.keys(unzipSync(await fs.readFile(explicitOutput)))).toContain(
      `claude-code/${conversation.id}.meta.json`,
    );
  });

  it("exports every concrete branch selected by project", async () => {
    const parentId = "d1313131-1313-1313-1313-131313131313";
    const childId = "d1414141-1414-1414-1414-141414141414";
    await seedSavedConversation(parentId, {
      title: "Branch parent",
      projectName: "branched-project",
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
    });
    await seedSavedConversation(childId, {
      title: "Branch child",
      projectName: "branched-project",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });
    const output = path.join(tempDir, "branched-project.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "project:branched-project",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain("Exported 2 conversations");
    expect(Object.keys(unzipSync(await fs.readFile(output)))).toEqual([
      `claude-code/${parentId}.jsonl`,
      `claude-code/${parentId}.meta.json`,
      `claude-code/${childId}.jsonl`,
      `claude-code/${childId}.meta.json`,
    ]);
  });

  it("resolves saved IDs when filters exclude all unseen unsaved conversations", async () => {
    const sourceRoot = path.join(tempDir, "claude-sources");
    await fs.rm(sourceRoot, { recursive: true, force: true });
    const id = "fabcd123-1234-1234-1234-123456789abc";
    await seedSavedConversation(id, {
      author: "bob",
      tags: ["filtered-export"],
      originKind: "file",
      originRef: null,
    });

    const cases = [
      ["--origin", "remote"],
      ["--tag", "filtered-export"],
      ["--author", "bob"],
    ] as const;

    for (const [index, filter] of cases.entries()) {
      const output = path.join(tempDir, `filtered-${index}.zip`);
      const result = await runBuiltCommandCapturingError(buildDrainCommand, [
        id.slice(0, 4),
        ...filter,
        "-o",
        output,
      ]);

      expect(result.error).toBeNull();
      expect(Object.keys(unzipSync(await fs.readFile(output)))).toContain(
        `claude-code/${id}.meta.json`,
      );
    }
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
      "dir",
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
      "dir",
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
      "dir",
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
    const createArchiveMock = vi.mocked(createDeterministicArchive);
    const resourceFailure = () => new ArchiveResourceError(
      `Archive selected conversation bytes observed ${MAX_SELECTED_ARCHIVE_BYTES + 1}; limit is ${MAX_SELECTED_ARCHIVE_BYTES}. Use directory input or output instead.`,
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
      `selected conversation bytes observed ${MAX_SELECTED_ARCHIVE_BYTES + 1}`,
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
    await writeUnsavedClaudeConversation(tempDir, unsavedId);
    const broadOutput = path.join(tempDir, "broad.zip");

    const broad = await runBuiltCommandCapturingError(buildDrainCommand, [
      "webapp",
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

  it("exports saved local and imported conversations with --include-imported", async () => {
    const localAlice = await seedSavedConversation(
      "d8888888-8888-8888-8888-888888888888",
      { author: "alice" },
    );
    const importedBob = await seedSavedConversation(
      "d9999999-9999-9999-9999-999999999999",
      { author: "bob", originKind: "git", originRef: "git@example.com:team/repo.git" },
    );
    const importedAlice = await seedSavedConversation(
      "d9898989-9898-9898-9898-989898989898",
      { author: "alice", originKind: "file", originRef: null },
    );
    const unsavedId = "d9797979-9797-9797-9797-979797979797";
    const output = path.join(tempDir, "with-imports.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--include-imported",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    expect(result.stdout).not.toContain("[y/N]");
    const names = Object.keys(unzipSync(await fs.readFile(output)));
    expect(names).toContain(`claude-code/${localAlice.id}.meta.json`);
    expect(names).toContain(`claude-code/${importedBob.id}.meta.json`);
    expect(names).toContain(`claude-code/${importedAlice.id}.meta.json`);
    expect(names).not.toContain(`claude-code/${unsavedId}.meta.json`);

    const redundantYesOutput = path.join(tempDir, "with-imports-and-yes.zip");
    const redundantYes = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--include-imported",
      "--yes",
      "-o",
      redundantYesOutput,
    ]);
    expect(redundantYes.error).toBeNull();
    expect(Object.keys(unzipSync(await fs.readFile(redundantYesOutput)))).toEqual(names);
  });

  it("exports only saved local conversations with --yes", async () => {
    const localAlice = await seedSavedConversation(
      "d1010101-1010-1010-1010-101010101010",
      { author: "alice" },
    );
    const localBob = await seedSavedConversation(
      "d2020202-2020-2020-2020-202020202020",
      { author: "bob" },
    );
    const remoteAlice = await seedSavedConversation(
      "d3030303-3030-3030-3030-303030303030",
      { author: "alice", originKind: "file", originRef: null },
    );
    const remoteBob = await seedSavedConversation(
      "d4040404-4040-4040-4040-404040404040",
      { author: "bob", originKind: "file", originRef: null },
    );
    const unsavedId = "d4141414-4141-4141-4141-414141414141";
    const output = path.join(tempDir, "saved-local.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--yes",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    const names = Object.keys(unzipSync(await fs.readFile(output)));
    expect(names).toContain(`claude-code/${localAlice.id}.meta.json`);
    expect(names).toContain(`claude-code/${localBob.id}.meta.json`);
    expect(names).not.toContain(`claude-code/${remoteAlice.id}.meta.json`);
    expect(names).not.toContain(`claude-code/${remoteBob.id}.meta.json`);
    expect(names).not.toContain(`claude-code/${unsavedId}.meta.json`);
  });

  it("accepts redundant --yes without prompting for an explicit selection", async () => {
    const conversation = await seedSavedConversation(
      "d7070707-7070-7070-7070-707070707070",
    );
    const output = path.join(tempDir, "explicit-yes.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "--yes",
      "-o",
      output,
    ]);

    expect(result.error).toBeNull();
    await expect(fs.access(output)).resolves.toBeUndefined();
    expect(result.stdout).not.toContain("saved local conversation");
  });

  it("does not let --yes replace an archive destination without --force", async () => {
    await seedSavedConversation("d8080808-8080-8080-8080-808080808080");
    const output = path.join(tempDir, "existing-local.zip");
    await fs.writeFile(output, "existing archive bytes");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--yes",
      "-o",
      output,
    ]);

    expect(result.error).toMatchObject({ exitCode: 1 });
    expect(await fs.readFile(output, "utf8")).toBe("existing archive bytes");
  });

  it("fails an empty bare selection without creating output", async () => {
    const output = path.join(tempDir, "empty-local.zip");

    const result = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--yes",
      "-o",
      output,
    ]);

    expect(result.error).toMatchObject({ exitCode: 1 });
    expect((result.error as Error).message).toContain("No conversations match");
    await expect(fs.access(output)).rejects.toThrow();

    await writeUnsavedClaudeConversation(
      tempDir,
      "d5050505-5050-5050-5050-505050505050",
    );
    const stillEmpty = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--yes",
      "-o",
      output,
    ]);

    expect(stillEmpty.error).toMatchObject({ exitCode: 1 });
    expect((stillEmpty.error as Error).message).toContain("No conversations match");
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("fails an interactive bare drain with nothing to export before prompting", async () => {
    const result = await runInteractiveCli(["drain"], "", {
      cwd: tempDir,
      clogHome: process.env.CLOG_HOME!,
    });

    expect(result.code).toBe(1);
    expect(result.stdout).not.toContain("[y/N]");
    expect(result.stderr).toContain("No conversations match");
    await expect(fs.access(path.join(tempDir, "clog-export.zip"))).rejects.toThrow();
  });

  it("prompts for an interactive bare archive and exports after acceptance", async () => {
    await seedSavedConversation("d9090909-9090-9090-9090-909090909090");

    const result = await runInteractiveCli(["drain"], "y\n", {
      cwd: tempDir,
      clogHome: process.env.CLOG_HOME!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(
      "Export 1 saved local conversation to ./clog-export.zip? [y/N]",
    );
    expect(result.stderr).toContain("Exported 1 conversation to ./clog-export.zip");
    await expect(fs.access(path.join(tempDir, "clog-export.zip"))).resolves.toBeUndefined();
  });

  it("does not let --force skip interactive confirmation or replace a declined archive", async () => {
    await seedSavedConversation("d9191919-9191-9191-9191-919191919191");
    const output = path.join(tempDir, "existing-interactive.zip");
    await fs.writeFile(output, "existing archive bytes");

    const result = await runInteractiveCli([
      "drain",
      "--force",
      "-o",
      output,
    ], "n\n", {
      cwd: tempDir,
      clogHome: process.env.CLOG_HOME!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`to ${output}? [y/N]`);
    expect(result.stdout).toContain("Operation cancelled.");
    expect(result.stderr).toBe("");
    expect(await fs.readFile(output, "utf8")).toBe("existing archive bytes");
  });

  it("cancels an interactive bare pair export before creating its destination", async () => {
    await seedSavedConversation("da0a0a0a-a0a0-a0a0-a0a0-a0a0a0a0a0a0");
    const output = path.join(tempDir, "declined-pairs");

    const result = await runInteractiveCli([
      "drain",
      "--format",
      "dir",
      "-o",
      output,
    ], "n\n", {
      cwd: tempDir,
      clogHome: process.env.CLOG_HOME!,
    });

    expect(result.code).toBe(0);
    expect(result.stdout).toContain(`to ${output}? [y/N]`);
    expect(result.stdout).toContain("Operation cancelled.");
    expect(result.stderr).toBe("");
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("requires --yes for non-interactive bare drain and rejects empty filter values", async () => {
    for (const args of [
      [] as string[],
      ["-o", path.join(tempDir, "bare.zip")],
      ["--tag", ""],
      ["--origin", ""],
    ]) {
      const result = await runBuiltCommandCapturingError(buildDrainCommand, args);
      expect(result.error).toMatchObject({ exitCode: 2 });
    }

    const removedRefresh = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--refresh",
      "--force",
    ]);
    expect(removedRefresh.error).toMatchObject({ exitCode: 1 });

    const bare = await runBuiltCommandCapturingError(buildDrainCommand, []);
    expect((bare.error as Error).message).toBe(
      "Exporting all saved local conversations requires confirmation. Add a conversation or project selector, add a filter, or use --yes.",
    );
  });

  it("reports migration guidance for removed destinations and render formats", async () => {
    const command = buildDrainCommand();
    const help = command.helpInformation();
    expect(help).toContain("--output");
    expect(help).toContain("--include-imported");
    expect(help).toContain("--yes");
    expect(help).toContain("saved local conversations");
    expect(help).not.toContain("--to-dir");
    expect(help).not.toContain("--raw");
    expect(help).not.toContain("--state");

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

    const savedState = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--state",
      "saved",
    ]);
    expect(savedState.error).toMatchObject({ exitCode: 2 });
    expect((savedState.error as Error).message).toContain("--include-imported");

    for (const args of [
      ["abcd", "--state", "saved"],
      ["--author", "alice", "--state", "saved"],
    ]) {
      const selectedSavedState = await runBuiltCommandCapturingError(
        buildDrainCommand,
        args,
      );
      expect(selectedSavedState.error).toMatchObject({ exitCode: 2 });
      expect((selectedSavedState.error as Error).message).toContain("Remove --state");
      expect((selectedSavedState.error as Error).message).not.toContain(
        "--include-imported",
      );
    }

    const unsavedState = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--state",
      "unsaved",
    ]);
    expect(unsavedState.error).toMatchObject({ exitCode: 2 });
    expect((unsavedState.error as Error).message).toContain(
      "exports saved conversations only",
    );
  });

  it("rejects --include-imported with selectors or selection filters", async () => {
    const conversation = await seedSavedConversation(
      "da1a1a1a-a1a1-a1a1-a1a1-a1a1a1a1a1a1",
    );

    for (const args of [
      ["--include-imported", conversation.id],
      ["--include-imported", "--author", "alice"],
    ]) {
      const result = await runBuiltCommandCapturingError(buildDrainCommand, args);
      expect(result.error).toMatchObject({ exitCode: 2 });
      expect((result.error as Error).message).toContain("cannot be combined");
    }
  });

  it("requires -o for pair output and rejects ineligible archive destinations", async () => {
    const conversation = await seedSavedConversation(
      "daaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa",
    );
    const missingPairOutput = await runBuiltCommandCapturingError(buildDrainCommand, [
      conversation.id,
      "--format",
      "dir",
    ]);
    expect(missingPairOutput.error).toMatchObject({ exitCode: 2 });

    const bareMissingPairOutput = await runBuiltCommandCapturingError(buildDrainCommand, [
      "--format",
      "dir",
    ]);
    expect(bareMissingPairOutput.error).toMatchObject({ exitCode: 2 });
    expect((bareMissingPairOutput.error as Error).message).toContain("requires -o");

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

async function writeUnsavedClaudeConversation(rootDir: string, id: string): Promise<void> {
  const sourcePath = path.join(rootDir, "claude-sources", "webapp", `${id}.jsonl`);
  await writeJsonl(sourcePath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/projects/webapp",
      message: { role: "user", content: `Unsaved conversation ${id}` },
    },
  ]);
}

async function runInteractiveCli(
  args: string[],
  stdin: string,
  options: { cwd: string; clogHome: string },
): Promise<{ code: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [
        "--import",
        tsxImport,
        path.join(repositoryRoot, "tests/helpers/interactive-cli.ts"),
        ...args,
      ],
      {
        cwd: options.cwd,
        env: {
          ...process.env,
          CLOG_HOME: options.clogHome,
        },
        stdio: ["pipe", "pipe", "pipe"],
      },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk: string) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(stdin);
  });
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
  const state = overrides.state ?? "unsaved";
  const common = {
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
    sourcePath: path.join(os.tmpdir(), `${id}.jsonl`),
    filePath: null,
    sourceMtime: timestamp,
    indexedAt: null,
    originKind: "local",
    originRef: null,
  };
  return state === "saved"
    ? {
        ...common,
        state,
        savedAt: timestamp,
        savedMessageCount: 0,
        saveVersion: 1,
        ...overrides,
      } as ConversationMeta
    : {
        ...common,
        state,
        savedAt: null,
        savedMessageCount: null,
        saveVersion: 0,
        ...overrides,
      } as ConversationMeta;
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
