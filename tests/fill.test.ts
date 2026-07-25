import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { zipSync } from "fflate";
import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as adapterRegistry from "../src/adapters/registry.js";
import { applyFillWriteAction } from "../src/cli/fill-executor.js";
import { buildFillCommand } from "../src/cli/fill.js";
import { buildRemoveCommand } from "../src/cli/remove.js";
import { buildTagCommand } from "../src/cli/tag.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import {
  getConversationById,
  setConversationIndexedAt,
  withDb,
} from "../src/db/index.js";
import * as dbModule from "../src/db/index.js";
import * as atomicWrite from "../src/utils/atomic-write.js";
import {
  createDeterministicPairArchive,
  MAX_ARCHIVE_BYTES,
} from "../src/interchange/archive.js";
import { planFill, type FillMode, type FillWriteAction } from "../src/interchange/fill.js";
import { writePair, type PairMetadata, type ValidatedPair } from "../src/interchange/pairs.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  getImportConversationPath,
  getRawConversationPath,
} from "../src/utils/paths.js";
import { insertConversation, updateConversation } from "./helpers/db.js";
import { captureOutputWithError } from "./helpers/output.js";

describe("clog fill", () => {
  let tempDir: string;
  let pairDir: string;
  let originalCwd: string;

  beforeEach(async () => {
    originalCwd = process.cwd();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-fill-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    pairDir = path.join(tempDir, "pairs");

    await ensureClogHome({ interactive: false });

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "source")];
    config.sources["codex-cli"].enabled = false;
    await fs.mkdir(config.sources["claude-code"].paths[0]!, { recursive: true });
    await saveConfig(config);
  });

  afterEach(async () => {
    process.chdir(originalCwd);
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("preserves a relative directory spelling in incomplete-pair diagnostics", async () => {
    const id = "a0101010-1010-1010-1010-101010101010";
    const inputPath = "./pairs";
    await fs.mkdir(pairDir, { recursive: true });
    await fs.writeFile(path.join(pairDir, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");
    process.chdir(tempDir);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      `Skipping conversation pair ${inputPath}${path.sep}${id}`,
    );
    expect(result.stderr).toContain(
      `paths=${inputPath}${path.sep}${id}.meta.json, ${inputPath}${path.sep}${id}.jsonl`,
    );
    expect(result.stderr).not.toContain(pairDir);
  });

  it("runs local source discovery once for one fill invocation", async () => {
    const id = "a0202020-2020-2020-2020-202020202020";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    const discover = vi.fn(async function* () {
      return;
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      name: "claude-code",
      relationshipInspectionVersion: 1,
      transcriptProjectionVersion: 2,
      watchPaths: () => [],
      inspectRelationships: async () => ({
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
        relationships: [],
      }),
      parseTranscript: async () => ({ messages: [], warnings: [] }),
      discover,
    }]);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(discover).toHaveBeenCalledOnce();
  });

  it("renders descendants of a dot input beneath ./", async () => {
    const id = "a0202020-2020-2020-2020-202020202020";
    await fs.mkdir(pairDir, { recursive: true });
    await fs.writeFile(path.join(pairDir, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");
    process.chdir(pairDir);

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["."]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain(`Skipping conversation pair .${path.sep}${id}`);
    expect(result.stderr).not.toContain(pairDir);
  });

  it("preserves a quoted home-directory spelling in diagnostics", async () => {
    const id = "a0303030-3030-3030-3030-303030303030";
    const fakeHome = path.join(tempDir, "home");
    vi.spyOn(os, "homedir").mockReturnValue(fakeHome);
    await fs.mkdir(fakeHome, { recursive: true });
    await fs.writeFile(path.join(fakeHome, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["~"]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain(`Skipping conversation pair ~${path.sep}${id}`);
    expect(result.stderr).not.toContain(fakeHome);
  });

  it("reports a missing relative directory without its resolved physical path", async () => {
    process.chdir(tempDir);
    const physicalMissingPath = path.join(tempDir, "missing");

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["./missing"]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "Import path is not readable: ./missing (ENOENT)",
    );
    expect((result.error as Error).message).not.toContain(physicalMissingPath);
  });

  it("retains filesystem details for a missing absolute directory with a trailing separator", async () => {
    const missingPath = path.join(tempDir, "missing");
    const inputPath = `${missingPath}${path.sep}`;

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      `Import path is not readable: ${inputPath} (ENOENT)`,
    );
  });

  it("uses the supplied path when a directory contains no conversation pairs", async () => {
    const emptyDir = path.join(tempDir, "empty");
    await fs.mkdir(emptyDir);
    process.chdir(tempDir);

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["./empty"]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("No conversation pairs found in ./empty.");
    expect((result.error as Error).message).not.toContain(emptyDir);
  });

  it("imports a clog archive through the existing pair plan and write pipeline", async () => {
    const id = "a0353535-3535-3535-3535-353535353535";
    await writePairFixture(pairDir, id, { author: "bob", title: "Archived pair" }, 2);
    const archivePath = path.join(tempDir, "portable.bin");
    await fs.writeFile(archivePath, await createDeterministicPairArchive(pairDir));

    const result = await runBuiltCommandCapturingError(buildFillCommand, [archivePath]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain(`Processed 1 conversation pair from ${archivePath}`);
    expect(await getConversationById(id)).toMatchObject({
      title: "Archived pair",
      author: "bob",
      originKind: "file",
      savedMessageCount: 2,
      sourceMtime: null,
      transcriptProjectionVersion: 2,
      relationshipInspection: {
        status: "unknown",
        version: 1,
        diagnostic: "relationship_inspection_not_implemented",
      },
      relationships: [],
    });
  });

  it("preserves own, dry-run, allow-partial, and expanded-error behavior for archives", async () => {
    const validId = "a0343434-3434-3434-3434-343434343434";
    const incompleteId = "a0344444-4444-4444-4444-444444444444";
    await writePairFixture(pairDir, validId, { author: "alice" }, 1);
    await fs.writeFile(
      path.join(pairDir, `${incompleteId}.jsonl`),
      makeClaudeJsonl(1),
      "utf8",
    );
    const archivePath = path.join(tempDir, "option-parity.zip");
    await fs.writeFile(archivePath, await createDeterministicPairArchive(pairDir));

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      archivePath,
      "--own",
      "--dry-run",
      "--allow-partial",
      "--show-all-errors",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("Dry run:");
    expect(result.stderr).toContain(`${archivePath}:${incompleteId}`);
    expect(result.stderr).not.toContain("clog-private-");
    expect(await getConversationById(validId)).toBeNull();
  });

  it("uses archive entry display paths without exposing private extraction paths", async () => {
    const id = "a0363636-3636-3636-3636-363636363636";
    const archivePath = path.join(tempDir, "invalid-pair.data");
    const archive = zipSync({
      [`claude-code/${id}.meta.json`]: Buffer.from("{invalid\n"),
      [`claude-code/${id}.jsonl`]: Buffer.from(makeClaudeJsonl(1)),
    });
    await fs.writeFile(archivePath, archive);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [archivePath]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(`${archivePath}:claude-code/${id}`);
    expect(result.stderr).not.toContain("clog-private-");
  });

  it("translates an archive entry read failure without exposing its temporary path", async () => {
    const id = "a0383838-3838-3838-3838-383838383838";
    await writePairFixture(path.join(pairDir, "claude-code"), id, { author: "bob" }, 1);
    const archivePath = path.join(tempDir, "entry-read-failure.zip");
    await fs.writeFile(archivePath, await createDeterministicPairArchive(pairDir));
    const expectedSuffix = path.join("claude-code", `${id}.meta.json`);
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile");
    let temporaryMetaPath = "";
    readFileSpy.mockImplementation(async (filePath, ...args) => {
      const candidatePath = String(filePath);
      if (candidatePath.includes("clog-private-") && candidatePath.endsWith(expectedSuffix)) {
        temporaryMetaPath = candidatePath;
        throw makeFilesystemError("ENOENT", candidatePath);
      }

      return originalReadFile(filePath, ...args) as ReturnType<typeof fs.readFile>;
    });

    const result = await runBuiltCommandCapturingError(buildFillCommand, [archivePath]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(temporaryMetaPath).not.toBe("");
    expect(result.stderr).toContain("failed to read .meta.json (ENOENT)");
    expect(result.stderr).toContain(`${archivePath}:claude-code/${id}`);
    expect(result.stderr).toContain(
      `path=${archivePath}:claude-code/${id}.meta.json`,
    );
    expect(result.stderr).not.toContain(temporaryMetaPath);
    expect(result.stderr).not.toContain("clog-private-");
  });

  it("returns a usage error for a regular file without a zip signature", async () => {
    const inputPath = path.join(tempDir, "not-an-archive.zip");
    await fs.writeFile(inputPath, "not zip data");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toMatchObject({ exitCode: 2 });
    expect((result.error as Error).message).toBe(
      `Import file is not a recognized zip archive: ${inputPath}. Use a zip archive or unpacked pair directory.`,
    );
  });

  it("rejects an over-budget recognized archive before reading the complete file", async () => {
    const inputPath = path.join(tempDir, "over-budget.zip");
    await fs.writeFile(inputPath, Uint8Array.of(0x50, 0x4b, 0x03, 0x04));
    await fs.truncate(inputPath, MAX_ARCHIVE_BYTES + 1);
    const readFileSpy = vi.spyOn(fs, "readFile");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toMatchObject({ exitCode: 1 });
    expect((result.error as Error).message).toContain(
      `Archive zip file bytes observed ${MAX_ARCHIVE_BYTES + 1}; limit is ${MAX_ARCHIVE_BYTES}`,
    );
    expect((result.error as Error).message).toContain("Use unpacked pair-directory input");
    expect(
      readFileSpy.mock.calls.some(([filePath]) => String(filePath) === inputPath),
    ).toBe(false);
  });

  it("rejects malformed, empty, pair-less, and unsafe recognized archives before pair import", async () => {
    const malformedPath = path.join(tempDir, "malformed.zip");
    const emptyPath = path.join(tempDir, "empty.zip");
    const pairlessPath = path.join(tempDir, "pairless.zip");
    const unsafePath = path.join(tempDir, "unsafe.zip");
    await fs.writeFile(malformedPath, Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0));
    await fs.writeFile(emptyPath, zipSync({}));
    await fs.writeFile(pairlessPath, zipSync({ "notes.txt": Buffer.from("ignored") }));
    await fs.writeFile(
      unsafePath,
      zipSync({ "../escaped.jsonl": Buffer.from(makeClaudeJsonl(1)) }),
    );

    for (const [inputPath, message] of [
      [malformedPath, "could not be decoded"],
      [emptyPath, "contains no conversation pair files"],
      [pairlessPath, "contains no conversation pair files"],
      [unsafePath, "traversal component"],
    ] as const) {
      const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);
      expect(result.error).toMatchObject({ exitCode: 1 });
      expect((result.error as Error).message).toContain(message);
    }
    const partial = await runBuiltCommandCapturingError(buildFillCommand, [
      malformedPath,
      "--allow-partial",
    ]);
    expect(partial.error).toMatchObject({ exitCode: 1 });
    expect((partial.error as Error).message).toContain("could not be decoded");
    await expect(fs.access(path.join(tempDir, "escaped.jsonl"))).rejects.toThrow();
  });

  it("uses an absolute input path in pair diagnostics", async () => {
    const id = "a0404040-4040-4040-4040-404040404040";
    await fs.mkdir(pairDir, { recursive: true });
    await fs.writeFile(path.join(pairDir, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain(
      `Skipping conversation pair ${path.join(pairDir, id)}`,
    );
  });

  it("does not double a supplied trailing separator in paths or summaries", async () => {
    const id = "a0505050-5050-5050-5050-505050505050";
    const incompleteId = "a0555555-5555-5555-5555-555555555555";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    await fs.writeFile(
      path.join(pairDir, `${incompleteId}.jsonl`),
      makeClaudeJsonl(1),
      "utf8",
    );
    process.chdir(tempDir);
    const inputPath = `.${path.sep}pairs${path.sep}`;

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      inputPath,
      "--allow-partial",
    ]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain(`Skipping conversation pair ${inputPath}${incompleteId}`);
    expect(result.stderr).toContain(`from ${inputPath}`);
    expect(result.stderr).not.toContain(`pairs${path.sep}${path.sep}`);
  });

  it("uses display paths while reading and reporting invalid metadata", async () => {
    const id = "a0606060-6060-6060-6060-606060606060";
    const inputPath = "./pairs";
    await fs.mkdir(pairDir, { recursive: true });
    await fs.writeFile(path.join(pairDir, `${id}.meta.json`), "{invalid\n", "utf8");
    await fs.writeFile(path.join(pairDir, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");
    process.chdir(tempDir);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain(
      `Skipping conversation pair ${inputPath}${path.sep}${id}`,
    );
    expect(result.stderr).toContain(`path=${inputPath}${path.sep}${id}.meta.json`);
    expect(result.stderr).not.toContain(pairDir);
  });

  it("translates a metadata read failure without exposing the physical input path", async () => {
    const id = "a0707070-7070-7070-7070-707070707070";
    const inputPath = "./pairs";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    process.chdir(tempDir);
    const physicalPairDir = path.resolve("./pairs");
    const metaPath = path.join(physicalPairDir, `${id}.meta.json`);
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementation(async (filePath, ...args) => {
      if (String(filePath) === metaPath) {
        throw makeFilesystemError("ENOENT", metaPath);
      }

      return originalReadFile(filePath, ...args) as ReturnType<typeof fs.readFile>;
    });
    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeNull();
    expect(result.stderr).toContain("failed to read .meta.json (ENOENT)");
    expect(result.stderr).toContain(`path=${inputPath}${path.sep}${id}.meta.json`);
    // The display path is reported once via `path=`, not repeated in the message.
    expect(result.stderr).not.toContain(`from ${inputPath}${path.sep}${id}.meta.json`);
    expect(result.stderr).not.toContain(metaPath);
    expect(readFileSpy).toHaveBeenCalledWith(metaPath, "utf8");
  });

  it("translates a pair-directory read failure without exposing the physical input path", async () => {
    const id = "a0757575-7575-7575-7575-757575757575";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    process.chdir(tempDir);
    const physicalPairDir = path.resolve("./pairs");
    const originalReadDir = fs.readdir.bind(fs);
    vi.spyOn(fs, "readdir").mockImplementation(async (directoryPath, ...args) => {
      if (String(directoryPath) === physicalPairDir) {
        throw makeFilesystemError("EACCES", physicalPairDir);
      }

      return originalReadDir(directoryPath, ...args) as ReturnType<typeof fs.readdir>;
    });

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["./pairs"]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe(
      "Failed to read pair directory ./pairs (EACCES)",
    );
    expect((result.error as Error).message).not.toContain(physicalPairDir);
  });

  it("translates a managed-copy source read failure without exposing its physical path", async () => {
    const id = "a0808080-8080-8080-8080-808080808080";
    const inputPath = "./pairs";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    process.chdir(tempDir);
    const physicalPairDir = path.resolve("./pairs");
    const jsonlPath = path.join(physicalPairDir, `${id}.jsonl`);
    const managedPath = getImportConversationPath("claude-code", id);
    const originalReadFile = fs.readFile.bind(fs);
    let sourceReadCount = 0;
    vi.spyOn(fs, "readFile").mockImplementation(async (filePath, ...args) => {
      if (String(filePath) === jsonlPath) {
        sourceReadCount += 1;
        if (sourceReadCount === 2) {
          throw makeFilesystemError("ENOENT", jsonlPath);
        }
      }

      return originalReadFile(filePath, ...args) as ReturnType<typeof fs.readFile>;
    });
    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toContain(
      `Failed to copy pair content to ${managedPath} from ${inputPath}${path.sep}${id}.jsonl (ENOENT)`,
    );
    expect((result.error as Error).message).not.toContain(jsonlPath);
    expect(sourceReadCount).toBe(2);
  });

  it("uses a safe command-level error when an unexpected failure contains the physical root", async () => {
    const id = "a0909090-9090-9090-9090-909090909090";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    process.chdir(tempDir);
    const physicalPairDir = path.resolve("./pairs");
    vi.spyOn(dbModule, "withDb").mockRejectedValue(
      new Error(
        `Unexpected failure while processing ${path.join(physicalPairDir, `${id}.jsonl`)}`,
      ),
    );

    const result = await runBuiltCommandCapturingError(buildFillCommand, ["./pairs"]);

    expect(result.error).toBeInstanceOf(Error);
    expect((result.error as Error).message).toBe("Failed to process import input ./pairs.");
    expect((result.error as Error).message).not.toContain(physicalPairDir);
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

  it("runs the fill database phase in a single withDb critical section", async () => {
    await writePairFixture(pairDir, "c1111111-1111-1111-1111-111111111111", { author: "bob", title: "First" }, 1);
    await writePairFixture(pairDir, "c2222222-2222-2222-2222-222222222222", { author: "bob", title: "Second" }, 1);
    await writePairFixture(pairDir, "c3333333-3333-3333-3333-333333333333", { author: "bob", title: "Third" }, 1);

    // Fill scans and validates pair files before opening the DB. Once it enters
    // the database phase, planning and all writes should share one
    // acquire/load/apply/flush/release cycle for the whole import batch.
    const withDbSpy = vi.spyOn(dbModule, "withDb");
    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);
    const withDbCalls = withDbSpy.mock.calls.length;

    expect(result.error).toBeNull();
    expect(result.stderr).toContain("Processed 3 conversation pair");
    expect(withDbCalls).toBe(1);
  });

  it("hints to use --own when every importable pair is the configured author's", async () => {
    const id = "ad111111-1111-1111-1111-111111111111";
    await writePairFixture(pairDir, id, { author: "alice", title: "My own debug" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain(
      "Re-run with --own to import them as editable local copies",
    );
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
    expect(result.stderr).toContain(
      `error: Skipping conversation pair ${path.join(pairDir, "broken", badId)} - incomplete pair`,
    );
    expect(result.stderr).not.toContain("input pairs could not be imported");
    expect(result.stderr).toContain(
      "Errors were found while importing from the input directory",
    );
    expect(result.stderr).toContain("no conversations were imported");
    expect(result.stderr).not.toContain("Filled ");
    expect(result.stderr).not.toContain("clog list --all");
    expect(await getConversationById(goodId)).toBeNull();
    await expect(fs.stat(getImportConversationPath("claude-code", goodId))).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("collapses multiple pair-level validation errors unless --show-all-errors is present", async () => {
    const firstBadId = "ad222222-2222-2222-2222-222222222222";
    const secondBadId = "ad333333-3333-3333-3333-333333333333";
    await fs.mkdir(pairDir, { recursive: true });
    await fs.writeFile(path.join(pairDir, `${firstBadId}.jsonl`), makeClaudeJsonl(1), "utf8");
    await fs.mkdir(path.join(pairDir, "nested"), { recursive: true });
    await fs.writeFile(
      path.join(pairDir, "nested", `${secondBadId}.jsonl`),
      makeClaudeJsonl(1),
      "utf8",
    );

    const result = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain(
      "error: 2 input pairs could not be imported. Re-run with --show-all-errors to list each pair.",
    );
    expect(result.stderr).toContain("--show-all-errors");
    expect(result.stderr).not.toContain("incomplete pair");
    expect(result.stderr).toContain("no conversations were imported");

    const expanded = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBe(1);
    expect(expanded.stderr).not.toContain("error: 2 input pairs could not be imported");
    expect(expanded.stderr).toContain(
      `error: Skipping conversation pair ${path.join(pairDir, firstBadId)} - incomplete pair`,
    );
    expect(expanded.stderr).toContain(
      `error: Skipping conversation pair ${path.join(pairDir, "nested", secondBadId)} - incomplete pair`,
    );
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

  it("treats unsupported-source pairs as failure-class candidates", async () => {
    const goodId = "f1111111-1111-1111-1111-111111111111";
    const unknownId = "f2222222-2222-2222-2222-222222222222";
    await writePairFixture(pairDir, goodId, { author: "bob" }, 1);
    await writePairFixture(pairDir, unknownId, { author: "bob", source: "future.agent" }, 1);

    const dryRun = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--dry-run",
    ]);

    expect(dryRun.error).toBeNull();
    expect(dryRun.exitCode).toBe(1);
    expect(dryRun.stderr).toContain('source "future.agent", which this clog build cannot read');
    expect(dryRun.stderr).toContain("Use a clog build with an adapter for that source, or re-run with --allow-partial to import the rest.");
    expect(dryRun.stderr).toContain("Use a clog build with an adapter for the unsupported source, or use --allow-partial to import the valid pairs.");
    expect(dryRun.stderr).toContain("no conversations would be imported");
    expect(await getConversationById(goodId)).toBeNull();
    expect(await getConversationById(unknownId)).toBeNull();

    const fullImport = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(fullImport.error).toBeNull();
    expect(fullImport.exitCode).toBe(1);
    expect(fullImport.stderr).toContain(
      "Errors were found while importing from the input directory",
    );
    expect(fullImport.stderr).toContain("no conversations were imported");
    expect(await getConversationById(goodId)).toBeNull();
    expect(await getConversationById(unknownId)).toBeNull();

    const partialImport = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--allow-partial",
    ]);

    expect(partialImport.error).toBeNull();
    expect(partialImport.exitCode).toBe(1);
    expect(partialImport.stderr).toContain("Use a clog build with an adapter for that source to import that pair.");
    expect(partialImport.stderr).not.toContain("re-run with --allow-partial to import the rest");
    expect(partialImport.stderr).toContain("Processed 2 conversation pairs");
    expect(partialImport.stderr).toContain("(1 new; 1 skipped)");
    expect(await getConversationById(goodId)).not.toBeNull();
    expect(await getConversationById(unknownId)).toBeNull();

    const ownDir = path.join(tempDir, "own-unknown-source-pairs");
    const ownUnknownId = "f3333333-3333-3333-3333-333333333333";
    await writePairFixture(ownDir, ownUnknownId, {
      author: "alice",
      source: "future.agent",
    }, 1);

    const ownImport = await runBuiltCommandCapturingError(buildFillCommand, [
      ownDir,
      "--own",
      "--allow-partial",
    ]);

    expect(ownImport.error).toBeNull();
    expect(ownImport.exitCode).toBe(1);
    expect(ownImport.stderr).toContain('source "future.agent", which this clog build cannot read');
    expect(await getConversationById(ownUnknownId)).toBeNull();
    await expect(
      fs.stat(getRawConversationPath("future.agent", ownUnknownId)),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports unsupported-source pairs separately from collapsed pair errors", async () => {
    const firstUnsupportedId = "f4444444-4444-4444-4444-444444444444";
    const secondUnsupportedId = "f5555555-5555-5555-5555-555555555555";
    const firstInvalidId = "f6666666-6666-6666-6666-666666666666";
    const secondInvalidId = "f7777777-7777-7777-7777-777777777777";

    await writePairFixture(
      path.join(pairDir, "carol", "future-agent"),
      firstUnsupportedId,
      { author: "carol", source: "future-agent" },
      1,
    );
    await writePairFixture(
      path.join(pairDir, "carol", "future-agent"),
      secondUnsupportedId,
      { author: "carol", source: "future-agent" },
      1,
    );
    await fs.writeFile(path.join(pairDir, `${firstInvalidId}.jsonl`), makeClaudeJsonl(1), "utf8");
    await fs.writeFile(path.join(pairDir, `${secondInvalidId}.jsonl`), makeClaudeJsonl(1), "utf8");
    process.chdir(tempDir);
    const inputPath = `.${path.sep}pairs`;

    const result = await runBuiltCommandCapturingError(buildFillCommand, [inputPath]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: 2 input pairs could not be imported");
    expect(result.stderr).not.toContain("error: 4 input pairs could not be imported");
    expect(result.stderr).toContain('error: 2 pairs use source "future-agent"');
    expect(result.stderr).not.toContain(`    carol/future-agent/${firstUnsupportedId}`);
    expect(result.stderr).not.toContain(`    carol/future-agent/${secondUnsupportedId}`);

    const expanded = await runBuiltCommandCapturingError(buildFillCommand, [
      inputPath,
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBe(1);
    expect(expanded.stderr).toContain(
      `error: Skipping conversation pair ${inputPath}${path.sep}${firstInvalidId} - incomplete pair`,
    );
    expect(expanded.stderr).toContain(
      `error: Skipping conversation pair ${inputPath}${path.sep}${secondInvalidId} - incomplete pair`,
    );
    expect(expanded.stderr).toContain('error: 2 pairs use source "future-agent"');
    expect(expanded.stderr).toContain(
      `    ${inputPath}${path.sep}carol${path.sep}future-agent${path.sep}${firstUnsupportedId}`,
    );
    expect(expanded.stderr).toContain(
      `    ${inputPath}${path.sep}carol${path.sep}future-agent${path.sep}${secondUnsupportedId}`,
    );
  });

  it("rejects duplicate input identities without choosing a winner", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    await writePairFixture(path.join(pairDir, "alice"), id, { author: "alice", title: "Alice" }, 1);
    await writePairFixture(path.join(pairDir, "bob"), id, { author: "bob", title: "Bob" }, 1);
    await writePairFixture(path.join(pairDir, "carol"), id, { author: "carol", title: "Carol" }, 1);
    process.chdir(tempDir);
    const inputPath = `.${path.sep}pairs`;

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      inputPath,
      "--allow-partial",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: 3 input pairs could not be imported");
    expect(result.stderr).not.toContain("duplicate input identity");
    expect(await getConversationById(id)).toBeNull();

    const expanded = await runBuiltCommandCapturingError(buildFillCommand, [
      inputPath,
      "--allow-partial",
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBe(1);
    expect(expanded.stderr).toContain("duplicate input identity");
    expect(expanded.stderr).toContain(`${inputPath}${path.sep}alice${path.sep}${id}.meta.json`);
    expect(expanded.stderr).toContain(`${inputPath}${path.sep}bob${path.sep}${id}.meta.json`);
    expect(expanded.stderr).toContain(`${inputPath}${path.sep}carol${path.sep}${id}.meta.json`);
    expect(expanded.stderr).not.toContain(pairDir);
  });

  it("supports dry-run without writing rows or managed files", async () => {
    const id = "a8888888-8888-8888-8888-888888888888";
    await writePairFixture(pairDir, id, { author: "bob" }, 1);
    await withDb(() => undefined, { mode: "read" });
    const writeSpy = vi.spyOn(atomicWrite, "writeFileAtomic");

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--dry-run",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBeUndefined();
    expect(result.stderr).toContain("Dry run: would process 1 conversation pair");
    expect(await getConversationById(id)).toBeNull();
    expect(writeSpy).not.toHaveBeenCalled();
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
    expect(result.stderr).toContain(
      "Dry run: one or more conversations by another author were found while importing with --own",
    );
    expect(result.stderr).toContain("no conversations would be imported");
    expect(result.stderr).not.toContain("would process");
    expect(await getConversationById(ownId)).toBeNull();
    expect(await getConversationById(foreignId)).toBeNull();
  });

  it("collapses --own author mismatch errors unless --show-all-errors is present", async () => {
    const firstForeignId = "ac555555-5555-5555-5555-555555555555";
    const secondForeignId = "ac666666-6666-6666-6666-666666666666";
    await writePairFixture(pairDir, firstForeignId, { author: "bob" }, 1);
    await writePairFixture(pairDir, secondForeignId, { author: "carol" }, 1);

    const result = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--own",
    ]);

    expect(result.error).toBeNull();
    expect(result.exitCode).toBe(1);
    expect(result.stderr).toContain("error: 2 input pairs could not be imported");
    expect(result.stderr).toContain("Re-run with --show-all-errors to see each pair error");
    expect(result.stderr).not.toContain("pair author");

    const expanded = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--own",
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBe(1);
    expect(expanded.stderr).not.toContain("error: 2 input pairs could not be imported");
    expect(expanded.stderr).toContain(
      `error: Skipping ${firstForeignId.slice(0, 8)} - pair author "bob" does not match configured author "alice".`,
    );
    expect(expanded.stderr).toContain(
      `error: Skipping ${secondForeignId.slice(0, 8)} - pair author "carol" does not match configured author "alice".`,
    );
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

  it("applies clogignore import rules and reports one detailed skip", async () => {
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
    expect(result.stderr).toContain(
      `notice: Skipping conversation ${ignoredId.slice(0, 8)} because it matches clogignore.`,
    );
    expect(result.stderr).not.toContain("Re-run with --show-all-errors");
    expect(await getConversationById(ignoredId)).toBeNull();
    expect(await getConversationById(importedId)).not.toBeNull();
  });

  it("collapses benign skips by reason and expands their conversation identities", async () => {
    const savedIds = [
      "b1212121-1212-1212-1212-121212121212",
      "b1313131-1313-1313-1313-131313131313",
    ];
    const ignoredIds = [
      "b1414141-1414-1414-1414-141414141414",
      "b1515151-1515-1515-1515-151515151515",
    ];

    for (const id of savedIds) {
      await insertConversation(conversation({ id, sourceId: id }));
      await writePairFixture(pairDir, id, { author: "bob", projectName: "visible" }, 1);
    }
    for (const id of ignoredIds) {
      await writePairFixture(pairDir, id, { author: "bob", projectName: "secret" }, 1);
    }
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), "secret\n", "utf8");

    const collapsed = await runBuiltCommandCapturingError(buildFillCommand, [pairDir]);

    expect(collapsed.error).toBeNull();
    expect(collapsed.exitCode).toBeUndefined();
    expect(collapsed.stderr).toContain(
      "notice: 2 input pairs were skipped because matching conversations are already saved locally.",
    );
    expect(collapsed.stderr).toContain(
      "notice: 2 conversation pairs were skipped by clogignore.",
    );
    expect(collapsed.stderr.match(/Re-run with --show-all-errors to list each conversation\./g))
      .toHaveLength(2);
    for (const id of [...savedIds, ...ignoredIds]) {
      expect(collapsed.stderr).not.toContain(`${id.slice(0, 8)}@claude-code`);
    }

    const expanded = await runBuiltCommandCapturingError(buildFillCommand, [
      pairDir,
      "--show-all-errors",
    ]);

    expect(expanded.error).toBeNull();
    expect(expanded.exitCode).toBeUndefined();
    expect(expanded.stderr).not.toContain(
      "Re-run with --show-all-errors to list each conversation.",
    );
    for (const id of [...savedIds, ...ignoredIds]) {
      expect(expanded.stderr).toContain(`    ${id.slice(0, 8)}@claude-code`);
    }
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
    expect(result.stderr).toContain(
      "error: One or more conversations by another author were found while importing with --own",
    );
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

  it("reports imported conversations that need search indexing", async () => {
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
    expect(result.stderr).toContain("1 imported conversation needs search indexing");
    expect(result.stderr).toContain("Run 'clog index'");
  });

  it("restores over discovered local rows through the command", async () => {
    const id = "b8a8a8a8-a8a8-a8a8-a8a8-a8a8a8a8a8a8";
    const sourcePath = path.join(tempDir, "source", "api-service", `${id}.jsonl`);
    await fs.mkdir(path.dirname(sourcePath), { recursive: true });
    await fs.writeFile(sourcePath, makeClaudeJsonl(1), "utf8");
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

  it("rejects a stale write target before overwriting managed content", async () => {
    const id = "bb1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b";
    await writePairFixture(pairDir, id, { author: "bob", title: "Updated pair" }, 2);

    const managedPath = getImportConversationPath("claude-code", id);
    await fs.mkdir(path.dirname(managedPath), { recursive: true });
    await fs.writeFile(managedPath, "existing import content\n", "utf8");

    const fileRow = conversation({
      id,
      sourceId: id,
      author: "bob",
      originKind: "file",
      originRef: null,
      sourcePath: managedPath,
      filePath: managedPath,
    });
    await insertConversation(fileRow);

    await updateConversation({
      ...fileRow,
      originKind: "local",
      originRef: null,
    });

    const action: FillWriteAction = {
      kind: "update",
      rowId: id,
      pair: validatedPairFromFixture(pairDir, id, { author: "bob", title: "Updated pair" }),
      managedPath,
      copyContent: true,
      conversation: {
        ...fileRow,
        title: "Updated pair",
        savedMessageCount: 2,
      },
    };

    await expect(
      withDb((db) => applyFillWriteAction(db, action), { mode: "write" }),
    ).rejects.toThrow(/managed file import/);

    await expect(fs.readFile(managedPath, "utf8")).resolves.toBe("existing import content\n");
    const row = await getConversationById(id);
    expect(row?.originKind).toBe("local");
  });

  it("plans the fill collision matrix without unique-constraint failures", () => {
    const pair = validatedPair("b8888888-8888-8888-8888-888888888888", {
      author: "alice",
      title: "Incoming",
    });

    expect(singleAction({ pair, mode: "file", localCandidate: true })).toMatchObject({
      kind: "skip",
      reason: "local_unsaved_precedence",
      failure: false,
    });
    expect(singleAction({ pair, mode: "own", localCandidate: true })).toMatchObject({
      kind: "insert",
    });
    expect(singleAction({
      pair,
      mode: "file",
      incompleteSources: [pair.meta.source],
    })).toMatchObject({
      kind: "skip",
      reason: "source_discovery_incomplete",
      failure: true,
    });
    expect(singleAction({
      pair,
      mode: "own",
      incompleteSources: [pair.meta.source],
    })).toMatchObject({
      kind: "insert",
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
      mode: "file",
      owner: conversation({
        originKind: "file",
        originRef: null,
        title: "Old",
        transcriptProjectionVersion: 3,
      }),
    })).toMatchObject({
      kind: "skip",
      reason: "adapter_version_skew",
      failure: true,
      warning: {
        code: "adapter_version_skew",
      },
    });
    expect(singleAction({
      pair,
      mode: "file",
      owner: conversation({
        originKind: "file",
        originRef: null,
        title: "Old",
        relationshipInspection: {
          status: "unknown",
          version: 2,
          diagnostic: "newer_inspection",
        },
      }),
    })).toMatchObject({
      kind: "skip",
      reason: "adapter_version_skew",
      failure: true,
      warning: {
        code: "adapter_version_skew",
      },
    });
    expect(singleAction({
      pair,
      mode: "own",
      owner: conversation({ originKind: "file", originRef: null }),
    })).toMatchObject({
      kind: "skip",
      reason: "unsupported_promotion",
      failure: true,
      message: "Skipping b8888888 - this imported conversation is read-only and cannot be made editable. Remove it from clog first, then re-run with --own to import it as an editable local copy.",
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
      message: "Skipping b8888888 - this synced conversation is read-only and cannot be made editable. Remove it from clog first, then re-run with --own to import it as an editable local copy.",
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

function makeFilesystemError(code: string, filePath: string): NodeJS.ErrnoException {
  const error = new Error(
    `${code}: simulated filesystem failure, open '${filePath}'`,
  ) as NodeJS.ErrnoException;
  error.code = code;
  error.path = filePath;
  return error;
}

function singleAction(args: {
  pair: ValidatedPair;
  mode: FillMode;
  owner?: ConversationMeta;
  localCandidate?: boolean;
  incompleteSources?: string[];
}) {
  const plan = planFill({
    candidates: [{ kind: "valid", pair: args.pair }],
    existingRows: args.owner ? [args.owner] : [],
    localCandidates: args.localCandidate
      ? [{
          source: args.pair.meta.source,
          sourceId: args.pair.meta.id,
          sourcePath: "/source/conversation.jsonl",
          sourceMtime: "2026-03-01T09:00:00.000Z",
          relationshipInspection: {
            status: "unknown",
            version: 1,
            diagnostic: "relationship_inspection_not_implemented",
          },
          relationships: [],
          metadata: {
            title: "Source conversation",
            summary: "",
            projectName: "api-service",
            projectPath: "/tmp/api-service",
            createdAt: "2026-02-19T09:15:00.000Z",
            slug: null,
          },
        }]
      : [],
    incompleteSources: args.incompleteSources,
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
    transcriptProjectionVersion: 1,
    relationshipInspection: {
      status: "unknown",
      version: 1,
      diagnostic: "relationship_inspection_not_implemented",
      relationships: [],
    },
  };
}

function validatedPairFromFixture(
  dir: string,
  id: string,
  overrides: Partial<PairMetadata> = {},
): ValidatedPair {
  return {
    ...validatedPair(id, overrides),
    rootDir: dir,
    metaPath: path.join(dir, `${id}.meta.json`),
    jsonlPath: path.join(dir, `${id}.jsonl`),
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
    relationshipInspection: {
      status: "unexamined",
      version: null,
      diagnostic: null,
    },
    relationships: [],
    transcriptProjectionVersion: 1,
    ...overrides,
  };
}
