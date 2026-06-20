import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { EventEmitter } from "node:events";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  confirm: vi.fn(),
  input: vi.fn(),
  select: vi.fn(),
}));

vi.mock("node:child_process", async () => {
  const actual = await vi.importActual<typeof import("node:child_process")>("node:child_process");
  return {
    ...actual,
    execFile: vi.fn(),
    spawn: vi.fn(actual.spawn),
  };
});

vi.mock("../src/sync/staleness.js", async () => {
  const actual = await vi.importActual<typeof import("../src/sync/staleness.js")>(
    "../src/sync/staleness.js",
  );
  return {
    ...actual,
    checkStaleness: vi.fn(async () => ({ kind: "no-remote" as const })),
  };
});

vi.mock("../src/sync/visibility.js", async () => {
  const actual = await vi.importActual<typeof import("../src/sync/visibility.js")>(
    "../src/sync/visibility.js",
  );
  return {
    ...actual,
    checkVisibility: vi.fn(async () => ({
      kind: "unverified" as const,
      reason: "test-default",
    })),
  };
});

const stalenessModule = await import("../src/sync/staleness.js");
const mockedCheckStaleness = vi.mocked(stalenessModule.checkStaleness);

const visibilityModule = await import("../src/sync/visibility.js");
const mockedCheckVisibility = vi.mocked(visibilityModule.checkVisibility);

vi.mock("../src/cli/search-init.js", () => ({
  runSearchInitCommand: vi.fn(async () => {}),
}));

vi.mock("../src/search/deps.js", async () => {
  const actual = await vi.importActual<typeof import("../src/search/deps.js")>(
    "../src/search/deps.js",
  );
  return {
    ...actual,
    getSearchProviders: vi.fn(actual.getSearchProviders),
    searchAvailable: vi.fn(actual.searchAvailable),
  };
});

const promptsModule = await import("@inquirer/prompts");
const mockedPromptConfirm = vi.mocked(promptsModule.confirm);
const mockedPromptSelect = vi.mocked(promptsModule.select);

const childProcessModule = await import("node:child_process");
const actualChildProcessModule = await vi.importActual<typeof import("node:child_process")>(
  "node:child_process",
);
const mockedExecFile = vi.mocked(childProcessModule.execFile);
const mockedSpawn = vi.mocked(childProcessModule.spawn);

const searchInitModule = await import("../src/cli/search-init.js");
const mockedRunSearchInitCommand = vi.mocked(searchInitModule.runSearchInitCommand);

const searchDepsModule = await import("../src/search/deps.js");
const actualSearchDepsModule = await vi.importActual<typeof import("../src/search/deps.js")>(
  "../src/search/deps.js",
);
const mockedGetSearchProviders = vi.mocked(searchDepsModule.getSearchProviders);
const mockedSearchAvailable = vi.mocked(searchDepsModule.searchAvailable);

import { buildConfigCommand } from "../src/cli/config.js";
import { buildDrainCommand } from "../src/cli/drain.js";
import { buildDiffCommand } from "../src/cli/diff.js";
import { buildEditCommand } from "../src/cli/edit.js";
import { buildInitCommand } from "../src/cli/init.js";
import { buildMcpCommand } from "../src/cli/mcp.js";
import { buildListCommand } from "../src/cli/list.js";
import { buildPathCommand } from "../src/cli/path.js";
import { buildSaveCommand } from "../src/cli/save.js";
import { buildRefreshCommand } from "../src/cli/refresh.js";
import { buildRemoteCommand } from "../src/cli/remote.js";
import { buildRenameAuthorCommand, runRenameAuthor } from "../src/cli/rename-author.js";
import { buildShowCommand } from "../src/cli/show.js";
import { buildStatusCommand } from "../src/cli/status.js";
import { buildSummarizeCommand, buildTalkCommand } from "../src/cli/talk.js";
import { buildTagCommand } from "../src/cli/tag.js";
import { buildUntagCommand } from "../src/cli/untag.js";
import { runIndexCommand } from "../src/cli/index-cmd.js";
import { runSearchCommand } from "../src/cli/search.js";
import { applyHeadTail } from "../src/cli/common.js";
import { shouldSkipPreAction } from "../src/cli/prelude.js";
import { getDefaultConfig, loadConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import { getConversationById, insertConversation, setConversationIndexedAt } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { SearchDepsError, SearchSetupIncompleteError } from "../src/search/errors.js";
import { getRemoteRoot } from "../src/sync/paths.js";
import { ClogError } from "../src/utils/errors.js";
import { getClogIgnorePath, getRawConversationPath } from "../src/utils/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutputWithError } from "./helpers/output.js";

const initModule = await import("../src/config/init.js");

describe("cli", () => {
  let tempDir: string;
  let sourceDir: string;
  let originalIsTTY: boolean | undefined;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-cli-"));
    process.env.CLOG_HOME = tempDir;
    sourceDir = path.join(tempDir, "claude-sources");
    await fs.mkdir(sourceDir, { recursive: true });
    await ensureClogHome({ interactive: false });
    originalIsTTY = process.stdin.isTTY;

    const config = getDefaultConfig("testuser");
    config.sources["claude-code"].paths = [sourceDir];
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);

    mockedPromptConfirm.mockReset();
    mockedPromptSelect.mockReset();
    mockedRunSearchInitCommand.mockClear();
    mockedExecFile.mockReset();
    mockedSpawn.mockReset();
    mockedSpawn.mockImplementation(actualChildProcessModule.spawn);
    mockedGetSearchProviders.mockImplementation(actualSearchDepsModule.getSearchProviders);
    mockedSearchAvailable.mockImplementation(actualSearchDepsModule.searchAvailable);
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalIsTTY,
      configurable: true,
    });
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  describe("init (SPEC §7.3, §10)", () => {
    it("offers vector search setup after a fresh interactive init", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: true });
      mockedPromptConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const { stdout } = await runBuiltCommand(buildInitCommand, []);

      expect(stdout).toContain(`Initialized clog at ${tempDir}`);
      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(1, {
        message: "Set up vector search now?",
        default: true,
      });
      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(2, {
        message: "Set up MCP integration now?",
        default: true,
      });
      expect(mockedRunSearchInitCommand).not.toHaveBeenCalled();
    });

    it("runs search setup when the fresh interactive init prompt is accepted", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: true });
      mockedPromptConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runBuiltCommand(buildInitCommand, []);

      expect(mockedRunSearchInitCommand).toHaveBeenCalledTimes(1);
    });

    it("offers vector search setup on rerun when search is still unset", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: false });
      mockedPromptConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      await runBuiltCommand(buildInitCommand, []);

      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(1, {
        message: "Set up vector search now?",
        default: true,
      });
      expect(mockedRunSearchInitCommand).not.toHaveBeenCalled();
    });

    it("does not offer vector search setup when search is already configured", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: false });
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);
      mockedPromptConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(false);

      const { stdout } = await runBuiltCommand(buildInitCommand, []);

      expect(stdout).toContain("Warning: Vector search is already configured.");
      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(1, {
        message: "Re-run vector search setup?",
        default: false,
      });
      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(2, {
        message: "Set up MCP integration now?",
        default: true,
      });
      expect(mockedRunSearchInitCommand).not.toHaveBeenCalled();
    });

    it("re-runs search setup when the configured-search warning prompt is accepted", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: false });
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);
      mockedPromptConfirm.mockResolvedValueOnce(true).mockResolvedValueOnce(false);

      await runBuiltCommand(buildInitCommand, []);

      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(1, {
        message: "Re-run vector search setup?",
        default: false,
      });
      expect(mockedRunSearchInitCommand).toHaveBeenCalledTimes(1);
    });

    it("can set up MCP integration from init", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      vi.spyOn(initModule, "initializeClog").mockResolvedValueOnce({ createdConfig: false });
      mockedPromptConfirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
      mockedPromptSelect.mockResolvedValueOnce("codex");
      mockExecFileSuccess();

      const { stdout } = await runBuiltCommand(buildInitCommand, []);

      expect(mockedPromptConfirm).toHaveBeenNthCalledWith(2, {
        message: "Set up MCP integration now?",
        default: true,
      });
      expect(mockedPromptSelect).toHaveBeenCalledWith({
        message: "Which MCP client should clog set up?",
        choices: expect.any(Array),
        default: "both",
      });
      expect(stdout).toContain("Codex CLI MCP integration configured");
      expect(mockedExecFile).toHaveBeenCalledWith(
        "codex",
        ["mcp", "add", "clog", "--", "npx", "-y", "clog-mcp"],
        expect.any(Function),
      );
    });

    it("skips the global pre-action hook for init but not ordinary commands", () => {
      expect(shouldSkipPreAction("init")).toBe(true);
      expect(shouldSkipPreAction("plunge")).toBe(true);
      expect(shouldSkipPreAction("setup", "mcp")).toBe(true);
      expect(shouldSkipPreAction("status")).toBe(false);
    });

    it("registers setup as an alias for init", () => {
      expect(buildInitCommand().aliases()).toContain("setup");
    });
  });

  describe("mcp", () => {
    it("configures Codex CLI MCP integration", async () => {
      mockExecFileSuccess();

      const { stdout } = await runBuiltCommand(buildMcpCommand, ["setup", "codex"]);

      expect(stdout).toContain("Codex CLI MCP integration configured");
      expect(mockedExecFile).toHaveBeenCalledWith(
        "codex",
        ["mcp", "add", "clog", "--", "npx", "-y", "clog-mcp"],
        expect.any(Function),
      );
    });

    it("configures both clients when requested", async () => {
      mockExecFileSuccess();

      const { stdout } = await runBuiltCommand(buildMcpCommand, ["setup", "both"]);

      expect(stdout).toContain("Claude Code MCP integration configured");
      expect(stdout).toContain("Codex CLI MCP integration configured");
      expect(mockedExecFile).toHaveBeenNthCalledWith(
        1,
        "claude",
        ["mcp", "add", "clog", "--", "npx", "-y", "clog-mcp"],
        expect.any(Function),
      );
      expect(mockedExecFile).toHaveBeenNthCalledWith(
        2,
        "codex",
        ["mcp", "add", "clog", "--", "npx", "-y", "clog-mcp"],
        expect.any(Function),
      );
    });

    it("replaces an existing Claude Code server automatically", async () => {
      mockExecFileFailure("server already exists");
      mockExecFileSuccess();
      mockExecFileSuccess();

      const { stdout } = await runBuiltCommand(buildMcpCommand, ["setup", "claude"]);

      expect(stdout).toContain("Claude Code MCP integration replaced");
      expect(mockedExecFile).toHaveBeenNthCalledWith(
        2,
        "claude",
        ["mcp", "remove", "clog"],
        expect.any(Function),
      );
    });

    it("replaces an existing Codex CLI server automatically", async () => {
      mockExecFileFailure("already exists");
      mockExecFileSuccess();
      mockExecFileSuccess();

      const { stdout } = await runBuiltCommand(buildMcpCommand, ["setup", "codex"]);

      expect(stdout).toContain("Codex CLI MCP integration replaced");
    });

    it("reports a missing client executable clearly", async () => {
      mockExecFileMissing();

      await expect(runBuiltCommand(buildMcpCommand, ["setup", "claude"])).rejects.toThrow(
        /Claude Code is not installed or not on PATH/,
      );
    });
  });

  describe("talk", () => {
    it("launches an explicit client", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      mockSpawnExit();

      await runBuiltCommand(buildTalkCommand, ["claude"]);

      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        [expect.stringContaining("clog's `talk` command")],
        { stdio: "inherit", shell: false },
      );
    });

    it("prompts for a client when none is supplied", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      mockedPromptSelect.mockResolvedValueOnce("claude");
      mockSpawnExit();

      await runBuiltCommand(buildTalkCommand, []);

      expect(mockedPromptSelect).toHaveBeenCalledWith({
        message: "Which agent should open?",
        choices: [
          { value: "claude", name: "Claude Code" },
          { value: "codex", name: "Codex CLI" },
        ],
      });
      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        [expect.stringContaining("clog's `talk` command")],
        { stdio: "inherit", shell: false },
      );
    });
  });

  describe("summarize", () => {
    it("launches an agent with the summarize framing", async () => {
      Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
      mockSpawnExit();

      await runBuiltCommand(buildSummarizeCommand, ["claude"]);

      expect(mockedSpawn).toHaveBeenCalledWith(
        "claude",
        [expect.stringContaining("clog's `summarize` command")],
        { stdio: "inherit", shell: false },
      );
    });
  });

  // ========================================
  // edit
  // ========================================

  describe("edit (SPEC §5.4)", () => {
    it("prints help when no flags are provided", async () => {
      const conv = await seedSavedConversation("11111111-1111-1111-1111-111111111111");
      const { stdout } = await runBuiltCommand(buildEditCommand, [conv.id]);
      expect(stdout).toContain("Usage:");
      expect(stdout).toContain("--title");
      expect(stdout).toContain("--summary");
      expect(stdout).toContain("--author");
    });

    it("updates title, summary, and author together", async () => {
      const conv = await seedSavedConversation("12121212-1212-1212-1212-121212121212");
      await runBuiltCommand(buildEditCommand, [
        conv.id,
        "--title",
        "New title",
        "--summary",
        "New summary",
        "--author",
        "alice",
      ]);
      const reloaded = await getConversationById(conv.id);
      expect(reloaded?.title).toBe("New title");
      expect(reloaded?.summary).toBe("New summary");
      expect(reloaded?.author).toBe("alice");
    });

    it("is a no-op when every supplied value already matches the current metadata", async () => {
      const conv = await seedSavedConversation("13131313-1313-1313-1313-131313131313", {
        title: "Same title",
        summary: "Same summary",
      });
      const originalModifiedAt = conv.modifiedAt;

      const { stdout } = await runBuiltCommand(buildEditCommand, [
        conv.id,
        "--title",
        "Same title",
        "--summary",
        "Same summary",
      ]);

      expect(stdout).toContain("Nothing changed");
      const reloaded = await getConversationById(conv.id);
      expect(reloaded?.modifiedAt).toBe(originalModifiedAt);
    });

    it("throws when the conversation is not found", async () => {
      await expect(
        runBuiltCommand(buildEditCommand, ["9999aaaa-9999-9999-9999-999999999999", "--title", "x"]),
      ).rejects.toThrow(/No conversation matches/);
    });

    it("refuses to edit an imported conversation (SPEC §11.1)", async () => {
      const conv = await seedRemoteConversation("14141414-1414-1414-1414-141414141414");
      await expect(
        runBuiltCommand(buildEditCommand, [conv.id, "--title", "x"]),
      ).rejects.toThrow(/imported conversations are read-only/i);
    });

    it("leaves indexedAt untouched when search is not configured (SPEC §10.8.1)", async () => {
      // "If search is not set up, the metadata update succeeds and Phase 2 remains inert."
      const convId = "15151515-1515-1515-1515-151515151515";
      const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
      await writeMinimalClaudeJsonl(sourcePath, "Initial");
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.copyFile(sourcePath, rawPath);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          sourcePath,
          filePath: rawPath,
          state: "saved",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: "2026-02-01T10:00:00.000Z",
        }),
      );

      await runBuiltCommand(buildEditCommand, [convId, "--title", "Different"]);

      const reloaded = await getConversationById(convId);
      expect(reloaded?.title).toBe("Different");
      expect(reloaded?.indexedAt).toBe("2026-02-01T10:00:00.000Z");
    });

    it("leaves indexedAt untouched on a no-op edit of a saved conversation", async () => {
      const convId = "16161616-1616-1616-1616-161616161616";
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: "/tmp/raw.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: "2026-02-01T10:00:00.000Z",
          title: "Unchanged",
        }),
      );

      await runBuiltCommand(buildEditCommand, [convId, "--title", "Unchanged"]);

      const reloaded = await getConversationById(convId);
      expect(reloaded?.indexedAt).toBe("2026-02-01T10:00:00.000Z");
    });
  });

  // ========================================
  // drain
  // ========================================

  describe("drain (SPEC §5)", () => {
    it("drains a single explicit ID as one JSON object to stdout", async () => {
      const convId = "d1111111-1111-1111-1111-111111111111";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Drain object");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Drain object",
          tags: ["debug"],
        }),
      );

      const { stdout } = await runBuiltCommand(buildDrainCommand, [convId]);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;

      expect(parsed).toMatchObject({
        id: convId,
        source: "claude-code",
        title: "Drain object",
        summary: "",
        author: "testuser",
        projectName: "webapp",
        tags: ["debug"],
        slug: null,
        createdAt: "2026-02-01T10:00:00.000Z",
        savedAt: null,
        state: "saved",
      });
      expect(parsed.messages).toEqual([
        {
          role: "user",
          content: "Drain object",
          timestamp: "2026-02-01T10:00:00.000Z",
        },
        {
          role: "assistant",
          content: "Response",
          timestamp: "2026-02-01T10:00:01.000Z",
        },
      ]);
      expect(stdout.endsWith("\n")).toBe(true);
    });

    it("drains filter-based selection as a deterministically ordered JSON array", async () => {
      const firstId = "d2222222-2222-2222-2222-222222222222";
      const secondId = "d3333333-3333-3333-3333-333333333333";

      const firstRaw = getRawConversationPath("claude-code", firstId);
      const secondRaw = getRawConversationPath("claude-code", secondId);
      await writeMinimalClaudeJsonl(firstRaw, "Later");
      await writeMinimalClaudeJsonl(secondRaw, "Earlier");

      await insertConversation(
        makeConversation({
          id: firstId,
          sourceId: firstId,
          state: "saved",
          filePath: firstRaw,
          title: "Later",
          createdAt: "2026-02-01T10:00:02.000Z",
          tags: ["auth"],
        }),
      );
      await insertConversation(
        makeConversation({
          id: secondId,
          sourceId: secondId,
          state: "saved",
          filePath: secondRaw,
          title: "Earlier",
          createdAt: "2026-02-01T10:00:01.000Z",
          savedAt: "2026-02-01T10:05:00.000Z",
          saveVersion: 1,
          tags: ["AUTH"],
        }),
      );

      const { stdout } = await runBuiltCommand(buildDrainCommand, ["--tag", "auth"]);
      const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;

      expect(parsed).toHaveLength(2);
      expect(parsed.map((item) => item.id)).toEqual([secondId, firstId]);
    });

    it("uses filters to disambiguate an otherwise ambiguous explicit ID", async () => {
      const aliceId = "dabc1111-1111-1111-1111-111111111111";
      const bobId = "dabc2222-2222-2222-2222-222222222222";

      const aliceRaw = getRawConversationPath("claude-code", aliceId);
      const bobRaw = getRawConversationPath("claude-code", bobId);
      await writeMinimalClaudeJsonl(aliceRaw, "Alice export");
      await writeMinimalClaudeJsonl(bobRaw, "Bob export");

      await insertConversation(
        makeConversation({
          id: aliceId,
          sourceId: aliceId,
          state: "saved",
          filePath: aliceRaw,
          author: "alice",
          title: "Alice export",
        }),
      );
      await insertConversation(
        makeConversation({
          id: bobId,
          sourceId: bobId,
          state: "saved",
          filePath: bobRaw,
          author: "bob",
          title: "Bob export",
        }),
      );

      const { stdout } = await runBuiltCommand(buildDrainCommand, ["dabc", "--author", "alice"]);
      const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe(aliceId);
      expect(parsed[0]?.author).toBe("alice");
    });

    it("includes same-author remote conversations in bare directory mode when config.author is set", async () => {
      const local = await seedSavedConversation("d1010101-1010-1010-1010-101010101010", {
        title: "Local export",
      });
      const remotePath = path.join(tempDir, "remote-export.jsonl");
      await writeMinimalClaudeJsonl(remotePath, "Remote export");
      const remote = await seedRemoteConversation("d2020202-2020-2020-2020-202020202020", {
        title: "Remote export",
        author: "testuser",
        filePath: remotePath,
      });

      const outDir = path.join(tempDir, "drain-default-scope");
      const { stderr } = await runBuiltCommand(buildDrainCommand, ["--to-dir", outDir]);

      expect(stderr).toContain(`Drained 2 conversations to ${outDir}/`);
      expect(await fs.readFile(path.join(outDir, `${local.id}.json`), "utf8")).toContain(
        local.id,
      );
      expect(await fs.readFile(path.join(outDir, `${remote.id}.json`), "utf8")).toContain(
        remote.id,
      );
    });

    it("falls back to local curated conversations only in bare directory mode when config.author is empty", async () => {
      const config = await loadConfig();
      config.author = "";
      await saveConfig(config);

      await seedSavedConversation("d3030303-3030-3030-3030-303030303030", {
        title: "Local only",
      });
      await seedRemoteConversation("d4040404-4040-4040-4040-404040404040", {
        title: "Hidden remote",
        author: "alice",
      });

      const outDir = path.join(tempDir, "drain-local-only");
      const { stderr } = await runBuiltCommand(buildDrainCommand, ["--to-dir", outDir]);

      expect(stderr).toContain(`Drained 1 conversation to ${outDir}/`);
      expect(
        await fs.readFile(
          path.join(outDir, "d3030303-3030-3030-3030-303030303030.json"),
          "utf8",
        ),
      ).toContain(
        "d3030303-3030-3030-3030-303030303030",
      );
      await expect(
        fs.access(path.join(outDir, "d4040404-4040-4040-4040-404040404040.json")),
      ).rejects.toThrow();
    });

    it("writes no stdout bytes when a multi-conversation stdout export fails partway through", async () => {
      const goodId = "d5050505-5050-5050-5050-505050505050";
      const badId = "d6060606-6060-6060-6060-606060606060";
      const goodRaw = getRawConversationPath("claude-code", goodId);
      await writeMinimalClaudeJsonl(goodRaw, "Good export");

      await insertConversation(
        makeConversation({
          id: goodId,
          sourceId: goodId,
          state: "saved",
          filePath: goodRaw,
          title: "Good export",
          tags: ["atomicity"],
        }),
      );
      await insertConversation(
        makeConversation({
          id: badId,
          sourceId: badId,
          state: "saved",
          filePath: path.join(tempDir, "missing.jsonl"),
          title: "Bad export",
          tags: ["atomicity"],
        }),
      );

      const result = await runBuiltCommandCapturingError(buildDrainCommand, ["--tag", "atomicity"]);

      expect(result.error).toBeInstanceOf(Error);
      expect(result.stdout).toBe("");
      expect(String((result.error as Error)?.message ?? "")).toMatch(/Curated raw file is missing/i);
    });

    it("reports remote-specific recovery guidance when a raw remote backing file is missing", async () => {
      const conv = await seedRemoteConversation("d7070707-7070-7070-7070-707070707070", {
        filePath: path.join(tempDir, "missing-remote-checkout.jsonl"),
      });

      const result = await runBuiltCommandCapturingError(buildDrainCommand, [conv.id, "--raw"]);

      expect(result.error).toBeInstanceOf(Error);
      expect(result.stdout).toBe("");
      expect(String((result.error as Error)?.message ?? "")).toMatch(/Remote checkout file is missing/i);
      expect(String((result.error as Error)?.message ?? "")).toMatch(/clog refresh/);
      expect(String((result.error as Error)?.message ?? "")).toMatch(/clog sync pull/);
      expect(String((result.error as Error)?.message ?? "")).not.toMatch(/clog add/);
    });

    it("requires exactly one match for markdown stdout", async () => {
      const first = await seedSavedConversation("d4444444-4444-4444-4444-444444444444", {
        title: "First markdown",
      });
      const second = await seedSavedConversation("d5555555-5555-5555-5555-555555555555", {
        title: "Second markdown",
      });

      await expect(
        runBuiltCommand(buildDrainCommand, [first.id, second.id, "--format", "md"]),
      ).rejects.toThrow(/markdown stdout requires exactly one conversation/i);
    });

    it("renders markdown with at least triple-backtick fences", async () => {
      const convId = "d8888888-8888-8888-8888-888888888888";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeJsonl(rawPath, [
        userLine("Contains `inline` ticks"),
        assistantLine("Reply with ``` fenced content", "msg_md_1"),
      ]);
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Markdown fences",
        }),
      );

      const { stdout } = await runBuiltCommand(buildDrainCommand, [convId, "--format", "md"]);

      expect(stdout).toContain("```text\nContains `inline` ticks\n```");
      expect(stdout).toContain("````text\nReply with ``` fenced content\n````");
    });

    it("writes directory exports and skips existing files without --force", async () => {
      const convId = "d6666666-6666-6666-6666-666666666666";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Collision title");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Collision title",
        }),
      );

      const outDir = path.join(tempDir, "drain-out");
      await fs.mkdir(outDir, { recursive: true });
      await fs.writeFile(
        path.join(outDir, `${convId}.json`),
        "existing\n",
        "utf8",
      );

      const { stderr } = await runBuiltCommand(buildDrainCommand, [convId, "--to-dir", outDir]);

      expect(stderr).toContain("Could not drain d6666666@claude-code");
      expect(stderr).toContain("already exists");
      expect(stderr).toContain(`Drained 0 conversations to ${outDir}/ (1 failed)`);
    });

    it("continues directory export after one conversation fails and writes the others", async () => {
      const goodId = "d9090909-9090-9090-9090-909090909090";
      const badId = "da0a0a0a-0a0a-0a0a-0a0a-0a0a0a0a0a0a";
      const goodRaw = getRawConversationPath("claude-code", goodId);
      await writeMinimalClaudeJsonl(goodRaw, "Directory success");

      await insertConversation(
        makeConversation({
          id: goodId,
          sourceId: goodId,
          state: "saved",
          filePath: goodRaw,
          title: "Directory success",
          tags: ["dir-partial"],
        }),
      );
      await insertConversation(
        makeConversation({
          id: badId,
          sourceId: badId,
          state: "saved",
          filePath: path.join(tempDir, "missing-dir.jsonl"),
          title: "Directory failure",
          tags: ["dir-partial"],
        }),
      );

      const outDir = path.join(tempDir, "drain-partial");
      const { stderr } = await runBuiltCommand(buildDrainCommand, [
        "--tag",
        "dir-partial",
        "--to-dir",
        outDir,
      ]);

      expect(stderr).toContain("Could not drain da0a0a0a@claude-code");
      expect(stderr).toContain(`Drained 1 conversation to ${outDir}/ (1 failed)`);
      expect(await fs.readFile(path.join(outDir, `${goodId}.json`), "utf8")).toContain(
        goodId,
      );
    });

    it("serializes drain JSON with the documented top-level field order", async () => {
      const convId = "db1b1b1b-1b1b-1b1b-1b1b-1b1b1b1b1b1b";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Ordered JSON");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Ordered JSON",
          savedAt: "2026-02-01T10:05:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildDrainCommand, [convId]);
      const parsed = JSON.parse(stdout) as Record<string, unknown>;

      expect(Object.keys(parsed)).toEqual([
        "id",
        "source",
        "title",
        "summary",
        "summaryKind",
        "extraction",
        "author",
        "projectName",
        "tags",
        "slug",
        "createdAt",
        "savedAt",
        "state",
        "messages",
      ]);
      expect(Object.keys((parsed.messages as Array<Record<string, unknown>>)[0] ?? {})).toEqual([
        "role",
        "content",
        "timestamp",
      ]);
    });

    it("validates --format, --origin, and output-flag usage errors", async () => {
      await expect(
        runBuiltCommand(buildDrainCommand, ["d1111111", "--format", "yaml"]),
      ).rejects.toThrow(/--format must be "json" or "md"/i);
      await expect(
        runBuiltCommand(buildDrainCommand, ["d1111111", "--origin", "somewhere"]),
      ).rejects.toThrow(/--origin must be "local" or "remote"/i);
      await expect(
        runBuiltCommand(buildDrainCommand, ["d1111111", "--force"]),
      ).rejects.toThrow(/--force requires --to <path> or --to-dir <dir>/i);
      await expect(
        runBuiltCommand(buildDrainCommand, ["d1111111", "--to", "/tmp/out.json", "--to-dir", "/tmp/out"]),
      ).rejects.toThrow(/--to and --to-dir cannot be combined/i);
    });

    it("writes a single conversation to the exact file path supplied by --to", async () => {
      const convId = "dc1c1c1c-1c1c-1c1c-1c1c-1c1c1c1c1c1c";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Single file");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Single file",
        }),
      );

      const outPath = path.join(tempDir, "drain-one.json");
      const { stdout, stderr } = await runBuiltCommand(buildDrainCommand, [convId, "--to", outPath]);

      expect(stdout).toBe("");
      expect(stderr).toBe("");
      const parsed = JSON.parse(await fs.readFile(outPath, "utf8")) as Record<string, unknown>;
      expect(parsed.id).toBe(convId);
    });

    it("overwrites an existing single-file target only when --force is passed", async () => {
      const convId = "dc5c5c5c-5c5c-5c5c-5c5c-5c5c5c5c5c5c";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Force overwrite");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          title: "Force overwrite",
        }),
      );

      const outPath = path.join(tempDir, "drain-force.json");
      await fs.writeFile(outPath, '{"existing":true}\n', "utf8");

      await expect(
        runBuiltCommand(buildDrainCommand, [convId, "--to", outPath]),
      ).rejects.toThrow(/Output file already exists/i);

      await runBuiltCommand(buildDrainCommand, [convId, "--to", outPath, "--force"]);

      const parsed = JSON.parse(await fs.readFile(outPath, "utf8")) as Record<string, unknown>;
      expect(parsed.id).toBe(convId);
      expect(parsed.title).toBe("Force overwrite");
    });

    it("rejects multi-conversation export with --to and points to --to-dir", async () => {
      await seedSavedConversation("dc2c2c2c-2c2c-2c2c-2c2c-2c2c2c2c2c2c", {
        title: "First file mode",
        tags: ["multi-to"],
      });
      await seedSavedConversation("dc3c3c3c-3c3c-3c3c-3c3c-3c3c3c3c3c3c", {
        title: "Second file mode",
        tags: ["multi-to"],
      });

      await expect(
        runBuiltCommand(buildDrainCommand, ["--tag", "multi-to", "--to", path.join(tempDir, "out.json")]),
      ).rejects.toThrow(/Use --to-dir <dir> for multi-conversation export/i);
    });

    it("rejects --to when the parent directory does not exist", async () => {
      const convId = "dc4c4c4c-4c4c-4c4c-4c4c-4c4c4c4c4c4c";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Missing parent");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
        }),
      );

      await expect(
        runBuiltCommand(
          buildDrainCommand,
          [convId, "--to", path.join(tempDir, "missing-parent", "out.json")],
        ),
      ).rejects.toThrow(/Parent directory does not exist/i);
    });

    it("reports a clear no-match message when an explicit id is absent from the filtered candidate set", async () => {
      const convId = "d7777777-7777-7777-7777-777777777777";
      const rawPath = getRawConversationPath("claude-code", convId);
      await writeMinimalClaudeJsonl(rawPath, "Overlap");
      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
          author: "alice",
        }),
      );

      await expect(
        runBuiltCommand(buildDrainCommand, [convId, "--author", "bob"]),
      ).rejects.toThrow(/No conversation matches "d7777777-7777-7777-7777-777777777777"/);
    });

    it("reports a clear filter-only message when no conversations match", async () => {
      await expect(runBuiltCommand(buildDrainCommand, ["--author", "nobody"])).rejects.toThrow(
        /Try 'clog list' with the same filters to inspect the current set/,
      );
    });
  });

  // ========================================
  // tag / untag
  // ========================================

  describe("tag and untag (SPEC §5.4.1)", () => {
    it("adds tags and normalizes them (trim, lowercase, dedupe)", async () => {
      const conv = await seedSavedConversation("21212121-2121-2121-2121-212121212121");
      await runBuiltCommand(buildTagCommand, [
        conv.id,
        "Debug",
        "  FRONTEND ",
        "debug",
      ]);

      const reloaded = await getConversationById(conv.id);
      expect(new Set(reloaded?.tags)).toEqual(new Set(["debug", "frontend"]));
    });

    it("reports no-new-tags and does not bump modifiedAt when every tag is already present", async () => {
      const conv = await seedSavedConversation("22222222-2222-2222-2222-222222222222", {
        tags: ["auth"],
      });
      const original = conv.modifiedAt;

      const { stdout } = await runBuiltCommand(buildTagCommand, [conv.id, "auth"]);
      expect(stdout).toContain("No new tags were added");

      const reloaded = await getConversationById(conv.id);
      expect(reloaded?.modifiedAt).toBe(original);
    });

    it("untag removes existing tags", async () => {
      const conv = await seedSavedConversation("23232323-2323-2323-2323-232323232323", {
        tags: ["bug", "urgent", "frontend"],
      });

      await runBuiltCommand(buildUntagCommand, [conv.id, "bug", "urgent"]);

      const reloaded = await getConversationById(conv.id);
      expect(reloaded?.tags).toEqual(["frontend"]);
    });

    it("untag no-op when the tag is not present (SPEC §5.4.1)", async () => {
      const conv = await seedSavedConversation("24242424-2424-2424-2424-242424242424", {
        tags: ["keep-me"],
      });
      const original = conv.modifiedAt;

      const { stdout } = await runBuiltCommand(buildUntagCommand, [conv.id, "nonexistent"]);
      expect(stdout).toContain("No matching tags were found");

      const reloaded = await getConversationById(conv.id);
      expect(reloaded?.tags).toEqual(["keep-me"]);
      expect(reloaded?.modifiedAt).toBe(original);
    });

    it("tag refuses an imported conversation (SPEC §11.1)", async () => {
      const conv = await seedRemoteConversation("25252525-2525-2525-2525-252525252525");
      await expect(runBuiltCommand(buildTagCommand, [conv.id, "x"])).rejects.toThrow(
        /imported conversations are read-only/i,
      );
    });

    it("untag refuses an imported conversation (SPEC §11.1)", async () => {
      const conv = await seedRemoteConversation("26262626-2626-2626-2626-262626262626", {
        tags: ["already-there"],
      });
      await expect(
        runBuiltCommand(buildUntagCommand, [conv.id, "already-there"]),
      ).rejects.toThrow(/imported conversations are read-only/i);
    });
  });

  // ========================================
  // save
  // ========================================

  describe("save (SPEC §5.6)", () => {
    it("prints a helpful message when called with no args and nothing needs saving", async () => {
      const { stdout } = await runBuiltCommand(buildSaveCommand, []);
      expect(stdout).toContain("No conversations need saving");
    });

    it("throws when a targeted ID is not found", async () => {
      await expect(
        runBuiltCommand(buildSaveCommand, ["9999bbbb-9999-9999-9999-999999999999"]),
      ).rejects.toThrow(/No conversation matches/);
    });

    it("refuses an imported conversation (SPEC §5.6, §11.1)", async () => {
      const conv = await seedRemoteConversation("52525252-5252-5252-5252-525252525252");
      await expect(runBuiltCommand(buildSaveCommand, [conv.id])).rejects.toThrow(
        /imported conversations are read-only/i,
      );
    });

    it("records savedMessageCount from the parsed transcript", async () => {
      const convId = "51515151-5151-5151-5151-515151515151";
      const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
      await writeJsonl(sourcePath, [
        userLine("First prompt", "2026-02-01T10:00:00.000Z"),
        assistantLine("First reply", "msg_01", "2026-02-01T10:00:01.000Z"),
        userLine("Second prompt", "2026-02-01T10:00:02.000Z"),
        assistantLine("Second reply", "msg_02", "2026-02-01T10:00:03.000Z"),
      ]);
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.copyFile(sourcePath, rawPath);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          sourcePath,
          filePath: rawPath,
          state: "saved",
        }),
      );

      await runBuiltCommand(buildSaveCommand, [convId]);

      const reloaded = await getConversationById(convId);
      expect(reloaded?.state).toBe("saved");
      expect(reloaded?.savedMessageCount).toBe(4);
    });

    it("resaves metadata-only saved conversations when called without ids", async () => {
      const convId = "53535353-5353-5353-5353-535353535353";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("First"),
        assistantLine("Reply", "msg_01"),
      ]);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          title: "Metadata changed",
          state: "saved",
          filePath: rawPath,
          sourcePath: "/tmp/nonexistent-source.jsonl",
          modifiedAt: "2026-02-01T10:05:00.000Z",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 modified");

      const saved = await getConversationById(convId);
      expect(saved?.saveVersion).toBe(1);
      expect(saved?.savedAt).toBe("2026-02-01T10:00:00.000Z");

      const saveResult = await runBuiltCommand(buildSaveCommand, []);
      expect(saveResult.stdout).toContain("Saved 1 conversation(s)");

      const reloaded = await getConversationById(convId);
      expect(reloaded?.saveVersion).toBe(2);
      expect(reloaded?.savedAt).not.toBe("2026-02-01T10:00:00.000Z");
      expect(reloaded?.modifiedAt).toBe(reloaded?.savedAt);
    });

    it("--all saves discovered conversations and refreshes saved conversations with source changes", async () => {
      const discoveredId = "54545454-5454-5454-5454-545454545454";
      const discoveredSource = claudeDiscoveredSourcePath(sourceDir, "api-service", discoveredId);
      await writeMinimalClaudeJsonl(discoveredSource, "New discovered conversation");
      await seedConversation(discoveredId, {
        sourcePath: discoveredSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const sourceAheadId = "55555555-5555-5555-5555-555555555555";
      const sourceAheadSource = claudeDiscoveredSourcePath(sourceDir, "api-service", sourceAheadId);
      await writeMinimalClaudeJsonl(sourceAheadSource, "Initial prompt");
      await seedConversation(sourceAheadId, {
        sourcePath: sourceAheadSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await runBuiltCommand(buildSaveCommand, [sourceAheadId]);
      const firstSaved = await getConversationById(sourceAheadId);
      await writeJsonl(sourceAheadSource, [
        userLine("Initial prompt"),
        assistantLine("Response", "msg_01"),
        userLine("Follow-up", "2026-02-01T10:05:00.000Z"),
        assistantLine("Updated response", "msg_02", "2026-02-01T10:05:01.000Z"),
      ]);

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["--all"]);
      expect(stdout).toContain("Saved 2 conversation(s)");

      expect((await getConversationById(discoveredId))?.state).toBe("saved");

      const refreshed = await getConversationById(sourceAheadId);
      expect(refreshed?.savedMessageCount).toBe(4);
      expect(refreshed?.saveVersion).toBe((firstSaved?.saveVersion ?? 0) + 1);
      const rawContent = await fs.readFile(refreshed!.filePath!, "utf8");
      const sourceContent = await fs.readFile(sourceAheadSource, "utf8");
      expect(rawContent).toBe(sourceContent);
    });

    it("rejects --all when selectors are also present", async () => {
      await expect(runBuiltCommand(buildSaveCommand, ["--all", "api-service"])).rejects.toThrow(
        /Cannot combine --all with selectors/,
      );
    });

    it("hints at unindexed saved conversations when search is configured", async () => {
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);

      await insertConversation(
        makeConversation({
          id: "c6666666-6666-6666-6666-666666666666",
          sourceId: "c6666666-6666-6666-6666-666666666666",
          title: "Saved but unindexed",
          state: "saved",
          filePath: "/tmp/saved-unindexed.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );

      const { stdout } = await runBuiltCommand(buildSaveCommand, []);
      expect(stdout).toContain("No conversations need saving");
      expect(stdout).toContain("1 saved conversation(s) still unindexed");
      expect(stdout).toContain("Run `clog index` to finish");
    });

    it("announces that indexing is unnecessary after saving when search is not configured", async () => {
      const id = "c3333333-3333-4444-5555-666666666666";
      const sourcePath = claudeDiscoveredSourcePath(sourceDir, "api-service", id);
      await writeMinimalClaudeJsonl(sourcePath, "No search configured");
      await seedConversation(id, {
        sourcePath,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const { stdout } = await runBuiltCommand(buildSaveCommand, [id]);

      expect(stdout).toContain("Saved 1 conversation(s)");
      expect(stdout).toContain("Search indexing is not configured; no indexing necessary.");
    });

    it("announces indexing after saving a single conversation when search is configured", async () => {
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);
      mockedSearchAvailable.mockResolvedValue(true);
      const upsert = vi.fn(async () => undefined);
      mockedGetSearchProviders.mockResolvedValue({
        embedding: {
          name: "stub",
          dimensions: 3,
          embed: async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3]),
        },
        vectorStore: {
          upsert,
          search: async () => [],
          delete: async () => undefined,
        },
      });

      const id = "c3333333-7777-4444-5555-666666666666";
      const sourcePath = claudeDiscoveredSourcePath(sourceDir, "api-service", id);
      await writeMinimalClaudeJsonl(sourcePath, "Search configured");
      await seedConversation(id, {
        sourcePath,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const { stdout } = await runBuiltCommand(buildSaveCommand, [id]);

      expect(stdout).toContain("Saved 1 conversation(s)");
      expect(stdout).toContain("Indexing 1 conversation(s) for vector search");
      expect(stdout).toContain("Indexed 1/1 conversation(s) for vector search.");
      expect(stdout).not.toContain("still unindexed");
      expect(upsert).toHaveBeenCalledTimes(1);
      expect((await getConversationById(id))?.indexedAt).not.toBeNull();
    });

    it("does not hint at unindexed saved conversations when search is not configured", async () => {
      await insertConversation(
        makeConversation({
          id: "c4444444-4444-4444-4444-444444444444",
          sourceId: "c4444444-4444-4444-4444-444444444444",
          title: "Saved but unindexed",
          state: "saved",
          filePath: "/tmp/saved-unindexed.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );

      const { stdout } = await runBuiltCommand(buildSaveCommand, []);
      expect(stdout).toContain("No conversations need saving");
      expect(stdout).not.toContain("still unindexed");
      expect(stdout).not.toContain("clog index");
    });
  });

  describe("search optional dependencies", () => {
    it("search reports missing search packages", async () => {
      mockedGetSearchProviders.mockRejectedValue(new SearchDepsError(["vectra"]));

      const result = await captureOutputWithError(() => runSearchCommand("auth", {}));

      expect(result.error).toBeInstanceOf(SearchDepsError);
      expect(result.error).toMatchObject({
        message: expect.stringContaining("npm install vectra"),
      });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("index reports missing search packages", async () => {
      mockedGetSearchProviders.mockRejectedValue(new SearchDepsError(["vectra"]));

      const result = await captureOutputWithError(() => runIndexCommand({}));

      expect(result.error).toBeInstanceOf(SearchDepsError);
      expect(result.error).toMatchObject({
        message: expect.stringContaining("npm install vectra"),
      });
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe("");
    });

    it("save still saves locally when search packages are missing", async () => {
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);
      mockedSearchAvailable.mockResolvedValue(false);
      mockedGetSearchProviders.mockRejectedValue(new SearchDepsError(["vectra"]));

      const id = "c5555555-5555-5555-5555-555555555555";
      await seedSavedConversationWithMessages(id, 2);

      const result = await runBuiltCommand(buildSaveCommand, [id]);

      expect(result.stdout).toContain("Saved 1 conversation(s).");
      expect(result.stdout).toContain("Search indexing is unavailable");
      expect(result.stdout).toContain("1 saved conversation(s) still unindexed");
      expect(result.stderr).toBe("");
      const saved = await getConversationById(id);
      expect(saved?.state).toBe("saved");
      expect(saved?.indexedAt).toBeNull();
    });

    it("search preserves SearchSetupIncompleteError instead of wrapping it as a vector-index error", async () => {
      const id = "c6666666-6666-6666-6666-666666666666";
      await seedSavedConversationWithRawMessages(id, 1, 1);
      await setConversationIndexedAt(id, "2026-02-01T10:00:00.000Z");

      mockedGetSearchProviders.mockResolvedValue({
        embedding: {
          name: "stub",
          dimensions: 384,
          embed: async () => {
            throw new SearchSetupIncompleteError();
          },
        },
        vectorStore: {
          upsert: async () => undefined,
          search: async () => [],
          delete: async () => undefined,
        },
      });

      const result = await captureOutputWithError(() => runSearchCommand("auth", {}));

      expect(result.error).toBeInstanceOf(SearchSetupIncompleteError);
      expect(result.error).not.toBeInstanceOf(ClogError);
      expect((result.error as Error)?.message).not.toContain("clog index --rebuild");
    });

    it("search wraps unknown vector-store errors with a rebuild hint", async () => {
      const id = "c7777777-7777-7777-7777-777777777777";
      await seedSavedConversationWithRawMessages(id, 1, 1);
      await setConversationIndexedAt(id, "2026-02-01T10:00:00.000Z");

      mockedGetSearchProviders.mockResolvedValue({
        embedding: {
          name: "stub",
          dimensions: 384,
          embed: async () => [[0.1, 0.2, 0.3]],
        },
        vectorStore: {
          upsert: async () => undefined,
          search: async () => {
            throw new Error("malformed index shape");
          },
          delete: async () => undefined,
        },
      });

      const result = await captureOutputWithError(() => runSearchCommand("auth", {}));

      expect(result.error).toBeInstanceOf(ClogError);
      expect((result.error as Error)?.message).toContain("malformed index shape");
      expect((result.error as Error)?.message).toContain("clog index --rebuild");
    });
  });

  describe("project-aware selectors", () => {
    it("saves discovered conversations by bare project name", async () => {
      const firstId = "71111111-1111-1111-1111-111111111111";
      const secondId = "72222222-2222-2222-2222-222222222222";
      const firstSource = claudeDiscoveredSourcePath(sourceDir, "api-service", firstId);
      const secondSource = claudeDiscoveredSourcePath(sourceDir, "api-service", secondId);
      await writeMinimalClaudeJsonl(firstSource, "API one");
      await writeMinimalClaudeJsonl(secondSource, "API two");

      await seedConversation(firstId, {
        sourcePath: firstSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await seedConversation(secondId, {
        sourcePath: secondSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await seedConversation("73333333-3333-3333-3333-333333333333", {
        projectName: "webapp",
      });

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["api-service"]);

      expect(stdout).toContain("Saved 2 conversation(s)");
      expect((await getConversationById(firstId))?.state).toBe("saved");
      expect((await getConversationById(secondId))?.state).toBe("saved");
      expect((await getConversationById("73333333-3333-3333-3333-333333333333"))?.state).toBe(
        "discovered",
      );
    });

    it("skips and removes a discovered row whose source file is missing while saving the rest", async () => {
      const missingId = "7eeeeeee-1111-1111-1111-111111111111";
      const goodId = "7eeeeeee-2222-2222-2222-222222222222";
      const goodSource = claudeDiscoveredSourcePath(sourceDir, "api-service", goodId);
      await writeMinimalClaudeJsonl(goodSource, "Still available");

      await seedConversation(missingId, {
        sourcePath: path.join(tempDir, "outside-scan-root", `${missingId}.jsonl`),
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await seedConversation(goodId, {
        sourcePath: goodSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const { stdout, stderr } = await runBuiltCommand(buildSaveCommand, ["api-service"]);

      expect(stdout).toContain("Saved 1 conversation(s)");
      expect(stderr).toContain(`warning: skipped ${missingId.slice(0, 8)}`);
      expect(stderr).toContain("source file is missing");
      expect(await getConversationById(missingId)).toBeNull();
      expect((await getConversationById(goodId))?.state).toBe("saved");
    });

    it("scans before resolving a project selector so newly discovered project conversations are included", async () => {
      const existingId = "7bbbbbbb-1111-1111-1111-111111111111";
      const newId = "7ccccccc-2222-2222-2222-222222222222";
      const existingSource = claudeDiscoveredSourcePath(sourceDir, "api-service", existingId);
      const newSource = claudeDiscoveredSourcePath(sourceDir, "api-service", newId);
      await writeMinimalClaudeJsonl(existingSource, "Existing API");
      await writeMinimalClaudeJsonl(newSource, "New API");

      await seedConversation(existingId, {
        sourcePath: existingSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["api-service"]);

      expect(stdout).toContain("Saved 2 conversation(s)");
      expect((await getConversationById(existingId))?.state).toBe("saved");
      expect((await getConversationById(newId))?.state).toBe("saved");
    });

    it("refreshes saved conversations by project selector", async () => {
      const convId = "7aaaaaaa-1111-2222-3333-444444444444";
      const sourcePath = claudeDiscoveredSourcePath(sourceDir, "api-service", convId);
      await writeMinimalClaudeJsonl(sourcePath, "Initial prompt");

      await seedConversation(convId, {
        sourcePath,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      await runBuiltCommand(buildSaveCommand, [convId]);
      await runBuiltCommand(buildSaveCommand, [convId]);

      const firstSaved = await getConversationById(convId);
      expect(firstSaved?.state).toBe("saved");
      const firstModifiedAt = firstSaved?.modifiedAt;
      const firstSavedAt = firstSaved?.savedAt;
      const firstSaveVersion = firstSaved?.saveVersion;

      await writeJsonl(sourcePath, [
        userLine("Initial prompt"),
        assistantLine("Response", "msg_01"),
        userLine("Follow-up", "2026-02-01T10:05:00.000Z"),
        assistantLine("Updated response", "msg_02", "2026-02-01T10:05:01.000Z"),
      ]);

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["api-service"]);
      expect(stdout).toContain("Saved 1 conversation(s)");

      const refreshed = await getConversationById(convId);
      expect(refreshed?.state).toBe("saved");
      expect(refreshed?.modifiedAt).not.toBe(firstModifiedAt);
      expect(refreshed?.savedAt).not.toBe(firstSavedAt);
      expect(refreshed?.saveVersion).toBe((firstSaveVersion ?? 0) + 1);
      expect(refreshed?.savedMessageCount).toBe(4);

      const rawContent = await fs.readFile(refreshed!.filePath!, "utf8");
      const sourceContent = await fs.readFile(sourcePath, "utf8");
      expect(rawContent).toBe(sourceContent);
    });

    it("does not resave clean saved conversations by project selector", async () => {
      const convId = "7ddddddd-1111-2222-3333-444444444444";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("Already saved"),
        assistantLine("Response", "msg_01"),
      ]);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          sourcePath: "/tmp/nonexistent-source.jsonl",
          filePath: rawPath,
          state: "saved",
          projectName: "api-service",
          projectPath: "/Users/testuser/projects/api-service",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["api-service"]);

      expect(stdout).toContain("No conversations need saving");
      const reloaded = await getConversationById(convId);
      expect(reloaded?.state).toBe("saved");
      expect(reloaded?.saveVersion).toBe(1);
      expect(reloaded?.savedMessageCount).toBe(2);
      expect(reloaded?.savedAt).toBe("2026-02-01T10:00:00.000Z");
    });

    it("saves only pending conversations in a project batch", async () => {
      const discoveredId = "7ddddddd-2222-2222-3333-444444444444";
      const discoveredSource = claudeDiscoveredSourcePath(sourceDir, "api-service", discoveredId);
      await writeMinimalClaudeJsonl(discoveredSource, "New project conversation");
      await seedConversation(discoveredId, {
        sourcePath: discoveredSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const sourceAheadId = "7ddddddd-3333-2222-3333-444444444444";
      const sourceAheadSource = claudeDiscoveredSourcePath(sourceDir, "api-service", sourceAheadId);
      const sourceAheadRaw = getRawConversationPath("claude-code", sourceAheadId);
      await fs.mkdir(path.dirname(sourceAheadRaw), { recursive: true });
      await writeJsonl(sourceAheadRaw, [
        userLine("Initial"),
        assistantLine("Response", "msg_01"),
      ]);
      await writeJsonl(sourceAheadSource, [
        userLine("Initial"),
        assistantLine("Response", "msg_01"),
        userLine("Follow-up", "2026-02-01T10:05:00.000Z"),
        assistantLine("Updated response", "msg_02", "2026-02-01T10:05:01.000Z"),
      ]);
      await insertConversation(
        makeConversation({
          id: sourceAheadId,
          sourceId: sourceAheadId,
          sourcePath: sourceAheadSource,
          filePath: sourceAheadRaw,
          state: "saved",
          projectName: "api-service",
          projectPath: "/Users/testuser/projects/api-service",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const cleanId = "7ddddddd-4444-2222-3333-444444444444";
      const cleanRaw = getRawConversationPath("claude-code", cleanId);
      await fs.mkdir(path.dirname(cleanRaw), { recursive: true });
      await writeJsonl(cleanRaw, [
        userLine("Already saved"),
        assistantLine("Response", "msg_01"),
      ]);
      await insertConversation(
        makeConversation({
          id: cleanId,
          sourceId: cleanId,
          sourcePath: "/tmp/nonexistent-clean-source.jsonl",
          filePath: cleanRaw,
          state: "saved",
          projectName: "api-service",
          projectPath: "/Users/testuser/projects/api-service",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["api-service"]);

      expect(stdout).toContain("Saved 2 conversation(s)");
      expect((await getConversationById(discoveredId))?.state).toBe("saved");
      expect((await getConversationById(sourceAheadId))?.saveVersion).toBe(2);
      expect((await getConversationById(cleanId))?.saveVersion).toBe(1);
    });

    it("resolves a short bare token as a project name", async () => {
      const id = "78888888-8888-8888-8888-888888888881";
      const sourcePath = claudeDiscoveredSourcePath(sourceDir, "ui", id);
      await writeMinimalClaudeJsonl(sourcePath, "UI work");
      await seedConversation(id, {
        sourcePath,
        projectName: "ui",
        projectPath: "/Users/testuser/projects/ui",
      });

      const { stdout } = await runBuiltCommand(buildSaveCommand, ["ui"]);

      expect(stdout).toContain("Saved 1 conversation(s)");
      expect((await getConversationById(id))?.state).toBe("saved");
    });

    it("rejects a short source-qualified token with the ID-length error", async () => {
      await expect(
        runBuiltCommand(buildSaveCommand, ["ab@claude-code"]),
      ).rejects.toThrow(/at least 4 characters/);
    });

    it("reports cross-space ambiguity for a sub-4-char bare token that matches both a project and an ID prefix", async () => {
      const collidingId = "ab111111-2222-3333-4444-555555555555";
      const collidingSource = claudeDiscoveredSourcePath(sourceDir, "other", collidingId);
      await writeMinimalClaudeJsonl(collidingSource, "ID starts with ab");
      await seedConversation(collidingId, {
        sourcePath: collidingSource,
        projectName: "other",
        projectPath: "/Users/testuser/projects/other",
      });

      const projectId = "78888888-8888-8888-8888-888888888882";
      const projectSource = claudeDiscoveredSourcePath(sourceDir, "ab", projectId);
      await writeMinimalClaudeJsonl(projectSource, "Project ab");
      await seedConversation(projectId, {
        sourcePath: projectSource,
        projectName: "ab",
        projectPath: "/Users/testuser/projects/ab",
      });

      await expect(runBuiltCommand(buildSaveCommand, ["ab"])).rejects.toThrow(/ambiguous/i);
    });

    it("reports ambiguity when a bare selector matches both an id prefix and a project", async () => {
      const sourcePath = claudeDiscoveredSourcePath(
        sourceDir,
        "other-project",
        "webapp0000-1111-1111-1111-111111111111",
      );
      await writeMinimalClaudeJsonl(sourcePath, "Collision");

      await seedConversation("webapp0000-1111-1111-1111-111111111111", {
        sourcePath,
        projectName: "other-project",
      });
      const webappSource = claudeDiscoveredSourcePath(
        sourceDir,
        "webapp",
        "74444444-4444-4444-4444-444444444444",
      );
      await writeMinimalClaudeJsonl(webappSource, "Project row");
      await seedConversation("74444444-4444-4444-4444-444444444444", {
        sourcePath: webappSource,
        projectName: "webapp",
        projectPath: "/Users/testuser/projects/webapp",
      });

      await expect(runBuiltCommand(buildSaveCommand, ["webapp"])).rejects.toThrow(/ambiguous/i);
    });

    it("saves by project selector", async () => {
      const firstId = "77777777-7777-7777-7777-777777777771";
      const secondId = "77777777-7777-7777-7777-777777777772";
      const firstSource = claudeDiscoveredSourcePath(sourceDir, "api-service", firstId);
      const secondSource = claudeDiscoveredSourcePath(sourceDir, "api-service", secondId);
      await writeMinimalClaudeJsonl(firstSource, "Save one");
      await writeMinimalClaudeJsonl(secondSource, "Save two");

      await seedConversation(firstId, {
        sourcePath: firstSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await seedConversation(secondId, {
        sourcePath: secondSource,
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      await runBuiltCommand(buildSaveCommand, ["project:api-service"]);
      expect((await getConversationById(firstId))?.state).toBe("saved");
      expect((await getConversationById(secondId))?.state).toBe("saved");
    });

    it("resolves drain project selectors against the filtered candidate set", async () => {
      const aliceId = "78888888-8888-8888-8888-888888888888";
      const bobId = "79999999-9999-9999-9999-999999999999";
      const aliceRaw = getRawConversationPath("claude-code", aliceId);
      const bobRaw = getRawConversationPath("claude-code", bobId);
      await writeMinimalClaudeJsonl(aliceRaw, "Alice API");
      await writeMinimalClaudeJsonl(bobRaw, "Bob API");

      await seedConversation(aliceId, {
        state: "saved",
        filePath: aliceRaw,
        author: "alice",
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });
      await seedConversation(bobId, {
        state: "saved",
        filePath: bobRaw,
        author: "bob",
        projectName: "api-service",
        projectPath: "/Users/testuser/projects/api-service",
      });

      const { stdout } = await runBuiltCommand(buildDrainCommand, ["api-service", "--author", "alice"]);
      const parsed = JSON.parse(stdout) as Array<Record<string, unknown>>;

      expect(parsed).toHaveLength(1);
      expect(parsed[0]?.id).toBe(aliceId);
    });

    it("rejects project selectors on singular commands", async () => {
      await expect(runBuiltCommand(buildShowCommand, ["project:api-service"])).rejects.toThrow(
        /only accepts conversation IDs/i,
      );
    });
  });

  // ========================================
  // rename-author
  // ========================================

  describe("rename-author (SPEC §5.12)", () => {
    it("prints a friendly message when there are no matches for the old name", async () => {
      const { stdout } = await runBuiltCommand(buildRenameAuthorCommand, ["ghost", "alice"]);
      expect(stdout).toContain('No conversations found for author "ghost"');
    });

    it("aborts (non-interactively) rather than renaming without confirmation", async () => {
      const convId = "61616161-6161-6161-6161-616161616161";
      await insertConversation(makeConversation({ id: convId, sourceId: convId, author: "bob" }));

      const { stdout } = await runBuiltCommand(buildRenameAuthorCommand, ["bob", "robert"]);
      expect(stdout).toContain("Aborted");

      const reloaded = await getConversationById(convId);
      expect(reloaded?.author).toBe("bob");
    });

    it("does not treat imported rows as rename targets", async () => {
      await insertConversation(
        makeConversation({
          id: "62626262-6262-6262-6262-626262626262",
          sourceId: "62626262-6262-6262-6262-626262626262",
          author: "bob",
          state: "saved",
          filePath: "/tmp/git-import.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildRenameAuthorCommand, ["bob", "robert"]);
      expect(stdout).toContain('No conversations found for author "bob"');
    });

    it("renames only local rows when the author also has imported rows", async () => {
      const localId = "63636363-6363-6363-6363-636363636363";
      const gitId = "64646464-6464-6464-6464-646464646464";
      const fileId = "65656565-6565-6565-6565-656565656565";

      await insertConversation(makeConversation({ id: localId, sourceId: localId, author: "bob" }));
      await insertConversation(
        makeConversation({
          id: gitId,
          sourceId: gitId,
          author: "bob",
          state: "saved",
          filePath: "/tmp/git-import.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: fileId,
          sourceId: fileId,
          author: "bob",
          state: "saved",
          filePath: "/tmp/file-import.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const result = await captureOutputWithError(async () => {
        await runRenameAuthor("bob", "robert", async () => true);
      });

      expect(result.error).toBeNull();
      expect(result.stdout).toContain("Renamed author on 1 conversation(s)");
      await expect(getConversationById(localId)).resolves.toMatchObject({ author: "robert" });
      await expect(getConversationById(gitId)).resolves.toMatchObject({ author: "bob" });
      await expect(getConversationById(fileId)).resolves.toMatchObject({ author: "bob" });
    });
  });

  // ========================================
  // config
  // ========================================

  describe("config (SPEC §7)", () => {
    it("get with a top-level key prints the value as JSON", async () => {
      const { stdout } = await runBuiltCommand(() => buildConfigCommand(), [
        "get",
        "author",
      ]);
      expect(stdout.trim()).toBe('"testuser"');
    });

    it("get with a nested key uses dot notation", async () => {
      const { stdout } = await runBuiltCommand(() => buildConfigCommand(), [
        "get",
        "sources.claude-code.enabled",
      ]);
      expect(stdout.trim()).toBe("true");
    });

    it("set parses JSON first and falls back to a plain string", async () => {
      await runBuiltCommand(() => buildConfigCommand(), ["set", "author", "alice"]);
      await runBuiltCommand(() => buildConfigCommand(), [
        "set",
        "defaultTags",
        '["team-a","team-b"]',
      ]);
      await runBuiltCommand(() => buildConfigCommand(), [
        "set",
        "autoScan",
        "true",
      ]);

      const config = await loadConfig();
      expect(config.author).toBe("alice");
      expect(config.defaultTags).toEqual(["team-a", "team-b"]);
      expect(config.autoScan).toBe(true);
    });

    it("get with no key dumps the full config", async () => {
      const { stdout } = await runBuiltCommand(() => buildConfigCommand(), ["get"]);
      expect(stdout).toContain('"author": "testuser"');
      expect(stdout).toContain('"sources"');
    });

    it("get returns undefined for a missing key without throwing", async () => {
      const { stdout } = await runBuiltCommand(() => buildConfigCommand(), [
        "get",
        "no.such.key",
      ]);
      expect(stdout.trim()).toBe("undefined");
    });

    it("set rejects unknown top-level keys instead of silently dropping them", async () => {
      await expect(
        runBuiltCommand(() => buildConfigCommand(), ["set", "authore", "alice"]),
      ).rejects.toThrow(/Unknown config key "authore"/);

      const config = await loadConfig();
      expect(config).not.toHaveProperty("authore");
    });

    it("set rejects unknown nested keys instead of silently dropping them", async () => {
      await expect(
        runBuiltCommand(() => buildConfigCommand(), [
          "set",
          "sources.unknown-source.enabled",
          "true",
        ]),
      ).rejects.toThrow(/Unknown config key "sources\.unknown-source\.enabled"/);
    });

    it("set rejects values that fail schema validation with a useful path", async () => {
      await expect(
        runBuiltCommand(() => buildConfigCommand(), [
          "set",
          "sources.claude-code.enabled",
          '"yes"',
        ]),
      ).rejects.toThrow(/sources\.claude-code\.enabled/);
    });

    it("set rejects unknown keys nested inside a JSON-object value", async () => {
      // Without this guard, zod silently strips `urll` and fills `url` with
      // its default null — losing both the typo and the user's intent.
      await expect(
        runBuiltCommand(() => buildConfigCommand(), [
          "set",
          "remote",
          '{"urll":"git@example.com:team/repo.git"}',
        ]),
      ).rejects.toThrow(/Unknown config key "remote\.urll"/);

      const config = await loadConfig();
      expect(config.remote.url).toBeNull();
    });
  });

  // ========================================
  // show and path
  // ========================================

  describe("show and path (SPEC §5.7.1)", () => {
    it("show --path prints the raw file path for a curated conversation", async () => {
      const convId = "71717171-7171-7171-7171-717171717171";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.writeFile(rawPath, "", "utf8");

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          filePath: rawPath,
        }),
      );

      const { stdout } = await runBuiltCommand(buildShowCommand, [convId, "--path"]);
      expect(stdout.trim()).toBe(rawPath);
    });

    it("path prints the source path for a discovered conversation", async () => {
      const convId = "72727272-7272-7272-7272-727272727272";
      const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
      await writeMinimalClaudeJsonl(sourcePath, "Discovered");

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "discovered",
          sourcePath,
        }),
      );

      const { stdout } = await runBuiltCommand(buildPathCommand, [convId]);
      expect(stdout.trim()).toBe(sourcePath);
    });

    it("show renders the metadata header and at least one message", async () => {
      const convId = "73737373-7373-7373-7373-737373737373";
      const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
      await writeMinimalClaudeJsonl(sourcePath, "Greetings");
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await fs.copyFile(sourcePath, rawPath);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          state: "saved",
          sourcePath,
          filePath: rawPath,
          title: "Hello header",
          projectName: "webapp",
        }),
      );

      const { stdout } = await runBuiltCommand(buildShowCommand, [convId]);
      expect(stdout).toContain("ID:");
      expect(stdout).toContain("Source:  claude-code");
      expect(stdout).toContain("Title:   Hello header");
      expect(stdout).toContain("Project: webapp");
      expect(stdout).toContain("[USER]");
    });

    it("show rejects a non-positive --head value with a clear error", async () => {
      const conv = await seedSavedConversation("74747474-7474-7474-7474-747474747474");
      await expect(
        runBuiltCommand(buildShowCommand, [conv.id, "--head", "0"]),
      ).rejects.toThrow(/positive integer/);
    });
  });

  // ========================================
  // applyHeadTail helper
  // ========================================

  // ========================================
  // diff
  // ========================================

  describe("diff (SPEC §5.8)", () => {
    it("default mode on a clean DB prints nothing", async () => {
      const { stdout } = await runBuiltCommand(buildDiffCommand, []);
      expect(stdout).toBe("");
    });

    it("rejects --head 0 with 'positive integer'", async () => {
      const conv = await seedSavedConversationWithRawMessages(
        "81818181-8181-8181-8181-818181818181",
        3,
        1,
      );
      await expect(
        runBuiltCommand(buildDiffCommand, [conv.id, "--head", "0"]),
      ).rejects.toThrow(/positive integer/);
    });

    it("prints new-since-save messages and a descriptive header line", async () => {
      // Raw has 4 messages, saved checkpoint is at 2 → 2 new messages to show.
      const conv = await seedSavedConversationWithRawMessages(
        "84848484-8484-8484-8484-848484848484",
        4,
        2,
      );
      const { stdout } = await runBuiltCommand(buildDiffCommand, [conv.id]);
      expect(stdout).toContain(conv.id.slice(0, 8));
      expect(stdout).toContain("2 new messages");
      // Assistant messages are text "Reply N"; the diff should include at least one.
      expect(stdout).toMatch(/\[USER\]|\[ASSISTANT\]/);
    });

    it("default mode ignores imported saved conversations", async () => {
      await seedSavedConversationWithRawMessages(
        "82828282-8282-8282-8282-828282828282",
        3,
        1,
        {
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
        },
      );
      await seedSavedConversationWithRawMessages(
        "83838383-8383-8383-8383-838383838383",
        3,
        1,
        {
          originKind: "file",
          originRef: null,
        },
      );

      const { stdout } = await runBuiltCommand(buildDiffCommand, []);
      expect(stdout).toBe("");
    });

    it.each([
      [
        "git",
        "88888888-8888-8888-8888-888888888888",
        { originKind: "git" as const, originRef: "git@example.com:team/repo.git" },
      ],
      [
        "file",
        "89898989-8989-8989-8989-898989898989",
        { originKind: "file" as const, originRef: null },
      ],
    ])("rejects an explicit %s imported conversation", async (_kind, id, provenance) => {
      await seedSavedConversationWithRawMessages(id, 3, 1, provenance);

      await expect(runBuiltCommand(buildDiffCommand, [id])).rejects.toThrow(
        /imported conversations are read-only/i,
      );
    });

    it("errors when the raw file shrinks below the saved checkpoint", async () => {
      // Raw has 1 message, checkpoint says 4 → fewer parsed messages than stored checkpoint.
      const conv = await seedSavedConversationWithRawMessages(
        "85858585-8585-8585-8585-858585858585",
        1,
        4,
      );
      await expect(
        runBuiltCommand(buildDiffCommand, [conv.id]),
      ).rejects.toThrow(/fewer parsed messages/);
    });

    it("--head trims the diff output with a truncation note in the header", async () => {
      // 5 new messages, only the first 2 should appear.
      const conv = await seedSavedConversationWithRawMessages(
        "87878787-8787-8787-8787-878787878787",
        5,
        0,
      );
      const { stdout } = await runBuiltCommand(buildDiffCommand, [conv.id, "--head", "2"]);
      expect(stdout).toContain("showing 2 of 5 new messages");
    });
  });

  // ========================================
  // list
  // ========================================

  describe("list (SPEC §5.3, §11.10)", () => {
    it("prints the empty-default message when there is nothing curated", async () => {
      const { stdout } = await runBuiltCommand(buildListCommand, []);
      expect(stdout).toContain("No saved conversations");
    });

    it("shows saved conversations by default", async () => {
      await seedSavedConversation("a1111111-1111-1111-1111-111111111111", {
        title: "Saved one",
      });
      await insertConversation(
        makeConversation({
          id: "a2222222-2222-2222-2222-222222222222",
          sourceId: "a2222222-2222-2222-2222-222222222222",
          title: "Saved two",
          state: "saved",
          filePath: "/tmp/fake.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildListCommand, []);
      expect(stdout).toContain("Saved one");
      expect(stdout).toContain("Saved two");
    });

    it("--state discovered filters to discovered rows only", async () => {
      await insertConversation(
        makeConversation({
          id: "a3333333-3333-3333-3333-333333333333",
          sourceId: "a3333333-3333-3333-3333-333333333333",
          title: "Discovered one",
          state: "discovered",
        }),
      );
      await seedSavedConversation("a4444444-4444-4444-4444-444444444444", {
        title: "Saved one",
      });

      const { stdout } = await runBuiltCommand(buildListCommand, ["--state", "discovered"]);
      expect(stdout).toContain("Discovered one");
      expect(stdout).not.toContain("Saved one");
    });

    it("--project filters case-insensitively", async () => {
      await seedSavedConversation("a5555555-5555-5555-5555-555555555555", {
        projectName: "api-service",
      });
      await seedSavedConversation("a6666666-6666-6666-6666-666666666666", {
        projectName: "webapp",
      });

      const { stdout } = await runBuiltCommand(buildListCommand, ["--project", "API-SERVICE"]);
      expect(stdout).toContain("a5555555");
      expect(stdout).not.toContain("a6666666");
    });

    it("--grep filters by text match on title", async () => {
      await seedSavedConversation("a7777777-7777-7777-7777-777777777777", {
        title: "Debug JWT refresh race",
      });
      await seedSavedConversation("a8888888-8888-8888-8888-888888888888", {
        title: "Unrelated work",
      });

      const { stdout } = await runBuiltCommand(buildListCommand, ["--grep", "jwt"]);
      expect(stdout).toContain("Debug JWT refresh race");
      expect(stdout).not.toContain("Unrelated work");
    });

    it("--origin rejects unknown values with a clear error", async () => {
      await expect(
        runBuiltCommand(buildListCommand, ["--origin", "somewhere"]),
      ).rejects.toThrow(/--origin must be "local" or "remote"/);
    });

    it("--origin remote restricts to remote rows", async () => {
      await seedSavedConversation("a9999999-9999-9999-9999-999999999999", {
        title: "Local saved",
      });
      await insertConversation(
        makeConversation({
          id: "b1111111-1111-1111-1111-111111111111",
          sourceId: "b1111111-1111-1111-1111-111111111111",
          title: "Remote saved",
          author: "bob",
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildListCommand, ["--origin", "remote"]);
      expect(stdout).toContain("Remote saved");
      expect(stdout).not.toContain("Local saved");
    });

    it("--columns rejects an unknown column name", async () => {
      await expect(
        runBuiltCommand(buildListCommand, ["--columns", "id,notreal"]),
      ).rejects.toThrow(/Unknown column "notreal"/);
    });

    it("--columns all expands to every known column", async () => {
      await seedSavedConversation("b2222222-2222-2222-2222-222222222222", {
        title: "Headers on",
      });
      const { stdout } = await runBuiltCommand(buildListCommand, ["--columns", "all"]);
      expect(stdout).toMatch(/ID\s+DATE\s+STATE\s+SOURCE/);
      expect(stdout).toContain("AUTHOR");
      expect(stdout).toContain("PROJECT");
      expect(stdout).toContain("TITLE");
    });

    it("prints 'No conversations found.' when a filter excludes everything", async () => {
      await seedSavedConversation("b9999999-9999-9999-9999-999999999999", {
        projectName: "webapp",
      });

      const { stdout } = await runBuiltCommand(buildListCommand, ["--project", "no-such-project"]);
      expect(stdout).toContain("No conversations found.");
    });

    it("falls back to origin-only default when config.author is empty", async () => {
      const config = await loadConfig();
      config.author = "";
      await saveConfig(config);

      await seedSavedConversation("ba000000-0000-0000-0000-000000000001", {
        title: "Author-less local",
        author: "anyone",
      });
      await insertConversation(
        makeConversation({
          id: "ba000000-0000-0000-0000-000000000002",
          sourceId: "ba000000-0000-0000-0000-000000000002",
          title: "Author-less git import",
          author: "bob",
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: "ba000000-0000-0000-0000-000000000003",
          sourceId: "ba000000-0000-0000-0000-000000000003",
          title: "Author-less file import",
          author: "carol",
          state: "saved",
          filePath: "/tmp/imported-file.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildListCommand, []);
      // Local rows are still shown even when config.author is empty.
      expect(stdout).toContain("Author-less local");
      expect(stdout).not.toContain("Author-less git import");
      expect(stdout).not.toContain("Author-less file import");
    });

    it("--all rediscovers ignored conversations from the source adapter (SPEC §5.3)", async () => {
      const convId = "bb000000-0000-0000-0000-000000000002";
      const sourcePath = path.join(sourceDir, "-Users-alice-proj", `${convId}.jsonl`);
      await writeJsonl(sourcePath, [
        {
          type: "user",
          timestamp: "2026-02-01T10:00:00.000Z",
          cwd: "/Users/alice/proj",
          message: { role: "user", content: "To be ignored" },
        },
      ]);

      await fs.writeFile(getClogIgnorePath(), `${convId}\n`, "utf8");

      const { stdout } = await runBuiltCommand(buildListCommand, ["--all"]);
      expect(stdout).toContain(convId.slice(0, 8));
      expect(stdout).toContain("ignored");
    });

    it("--all renders the display table including saved and discovered rows", async () => {
      await seedSavedConversation("b5555555-5555-5555-5555-555555555555", {
        title: "Saved all",
      });
      await insertConversation(
        makeConversation({
          id: "b6666666-6666-6666-6666-666666666666",
          sourceId: "b6666666-6666-6666-6666-666666666666",
          title: "Discovered all",
          state: "discovered",
        }),
      );

      const { stdout } = await runBuiltCommand(buildListCommand, ["--all"]);
      expect(stdout).toContain("Saved all");
      expect(stdout).toContain("Discovered all");
    });

    it("prints a remote-staleness warning when checkStaleness reports stale", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      mockedCheckStaleness.mockResolvedValueOnce({
        kind: "stale",
        head: "ffff000000000000000000000000000000000000",
        lastSyncHead: "aaaa000000000000000000000000000000000000",
      });

      await seedSavedConversation("b7777777-7777-7777-7777-777777777777");

      const { stdout } = await runBuiltCommand(buildListCommand, []);
      expect(stdout).toContain("remote checkout has changed outside of clog");
      expect(stdout).toContain("clog refresh");
    });

    it("shows the team-conversation footer when a remote has hidden rows", async () => {
      // config.author is 'testuser'; remote row by another author should be hidden from default view.
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      await seedSavedConversation("b3333333-3333-3333-3333-333333333333");
      await insertConversation(
        makeConversation({
          id: "b4444444-4444-4444-4444-444444444444",
          sourceId: "b4444444-4444-4444-4444-444444444444",
          author: "bob",
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: "b5555555-4444-4444-4444-444444444444",
          sourceId: "b5555555-4444-4444-4444-444444444444",
          author: "bob",
          state: "saved",
          filePath: "/tmp/imported-file.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildListCommand, []);
      expect(stdout).toContain("1 team conversation(s) available");
      expect(stdout).toContain("clog list --all");
    });
  });

  // ========================================
  // status
  // ========================================

  describe("status (SPEC §5.2)", () => {
    it("prints the clean-state message when there is nothing pending", async () => {
      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Nothing to save.");
    });

    it("shows saved rows that need resaving under 'Saved conversations to resave:'", async () => {
      await seedSavedConversation("c1111111-1111-1111-1111-111111111111", {
        title: "Saved change",
      });

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Saved conversations to resave:");
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 modified");
      expect(stdout).not.toContain("Saved change");
      expect(stdout).toContain('use "clog save" to save these updates');
    });

    it("shows discovered project counts under 'Unsaved conversations:'", async () => {
      await insertConversation(
        makeConversation({
          id: "c2222222-2222-2222-2222-222222222222",
          sourceId: "c2222222-2222-2222-2222-222222222222",
          title: "Pending discovery",
          state: "discovered",
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Unsaved conversations:");
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 discovered");
      expect(stdout).not.toContain("Pending discovery");
    });

    it("sorts project summaries by newest bucket date and shows that date", async () => {
      await insertConversation(
        makeConversation({
          id: "c2323232-2323-2323-2323-232323232323",
          sourceId: "c2323232-2323-2323-2323-232323232323",
          state: "discovered",
          projectName: "zeta",
          createdAt: "2026-02-06T10:00:00.000Z",
        }),
      );
      await insertConversation(
        makeConversation({
          id: "c2424242-2424-2424-2424-242424242424",
          sourceId: "c2424242-2424-2424-2424-242424242424",
          state: "discovered",
          projectName: "api",
          createdAt: "2026-02-03T10:00:00.000Z",
        }),
      );
      await insertConversation(
        makeConversation({
          id: "c2525252-2525-2525-2525-252525252525",
          sourceId: "c2525252-2525-2525-2525-252525252525",
          state: "discovered",
          projectName: "api",
          createdAt: "2026-02-05T10:00:00.000Z",
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      const apiIndex = stdout.indexOf("api");
      const zetaIndex = stdout.indexOf("zeta");

      expect(apiIndex).toBeGreaterThan(-1);
      expect(zetaIndex).toBeGreaterThan(-1);
      expect(zetaIndex).toBeLessThan(apiIndex);
      expect(stdout).toContain("zeta  1 discovered  2026-02-06");
      expect(stdout).toContain("api   2 discovered  2026-02-05");
    });

    it("treats a saved conversation whose raw copy is ahead of the saved checkpoint as ready to save", async () => {
      const convId = "c3333333-3333-3333-3333-333333333333";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("Something"),
        assistantLine("Reply", "msg_01"),
        userLine("And more"),
        assistantLine("Reply 2", "msg_02"),
      ]);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          title: "Saved with refreshed raw copy",
          state: "saved",
          filePath: rawPath,
          savedAt: "2020-01-01T00:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Saved conversations to resave:");
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 modified");
      expect(stdout).not.toContain("Saved with refreshed raw copy");
      expect(stdout).toContain('use "clog save" to save these updates');
    });

    it("--conversations restores the conversation-level status rows", async () => {
      await seedSavedConversation("c3434343-3434-3434-3434-343434343434", {
        title: "Conversation fallback",
      });

      const { stdout } = await runBuiltCommand(buildStatusCommand, ["--conversations"]);
      expect(stdout).toContain("c3434343");
      expect(stdout).toContain("Conversation fallback");
      expect(stdout).toContain("modified:");
    });

    it("--source adds the source column after the short id", async () => {
      await seedSavedConversation("c4444444-4444-4444-4444-444444444444", {
        title: "With source column",
      });

      const { stdout } = await runBuiltCommand(buildStatusCommand, ["--source"]);
      expect(stdout).toContain("c4444444");
      expect(stdout).toMatch(/c4444444\s+claude-code/);
    });

    it("prints a staleness warning in the remote section when checkStaleness reports stale", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      mockedCheckStaleness.mockResolvedValueOnce({
        kind: "stale",
        head: "ffff000000000000000000000000000000000000",
        lastSyncHead: "aaaa000000000000000000000000000000000000",
      });

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("remote checkout has changed outside of clog");
    });

    it("marks a saved conversation as ready when parsed messages exceed the saved checkpoint", async () => {
      const convId = "c6666666-6666-6666-6666-666666666666";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("First"),
        assistantLine("Reply 1", "msg_01"),
        userLine("Second"),
        assistantLine("Reply 2", "msg_02"),
      ]);


      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          title: "Checkpoint lag",
          state: "saved",
          filePath: rawPath,
          sourcePath: "/tmp/nonexistent-source.jsonl",
          modifiedAt: "2026-02-01T10:00:00.000Z",
          savedAt: "2026-02-01T10:00:00.000Z",
          // Parsed count will be 4; saved checkpoint is 2 → 2 new messages.
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Saved conversations to resave:");
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 modified");
      expect(stdout).not.toContain("Checkpoint lag");
      expect(stdout).toContain('use "clog save" to save these updates');
    });

    it("marks a saved conversation as ready when metadata changed after save", async () => {
      const convId = "c7777777-7777-7777-7777-777777777777";
      const rawPath = getRawConversationPath("claude-code", convId);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("First"),
        assistantLine("Reply", "msg_01"),
      ]);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          title: "Metadata changed",
          state: "saved",
          filePath: rawPath,
          sourcePath: "/tmp/nonexistent-source.jsonl",
          modifiedAt: "2026-02-01T10:05:00.000Z",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Saved conversations to resave:");
      expect(stdout).toContain("webapp");
      expect(stdout).toContain("1 modified");
      expect(stdout).not.toContain("Metadata changed");
      expect(stdout).toContain('use "clog save" to save these updates');
    });

    it("shows saved source changes separately from saved rows ready to resave", async () => {
      await seedSavedConversation("c7878787-7878-7878-7878-787878787878", {
        title: "Ready saved conversation",
      });

      const convId = "c7979797-7979-7979-7979-797979797979";
      const rawPath = getRawConversationPath("claude-code", convId);
      const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
      await fs.mkdir(path.dirname(rawPath), { recursive: true });
      await writeJsonl(rawPath, [
        userLine("First"),
        assistantLine("Reply", "msg_01"),
      ]);
      await writeJsonl(sourcePath, [
        userLine("First"),
        assistantLine("Reply", "msg_01"),
        userLine("Second"),
        assistantLine("Reply 2", "msg_02"),
      ]);

      await insertConversation(
        makeConversation({
          id: convId,
          sourceId: convId,
          title: "Modified saved conversation",
          state: "saved",
          filePath: rawPath,
          sourcePath,
          modifiedAt: "2026-02-01T10:05:00.000Z",
          savedAt: "2026-02-01T10:00:00.000Z",
          savedMessageCount: 2,
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Saved conversations to resave:");
      expect(stdout).toContain("Saved conversations whose source files changed:");
      expect(stdout).toContain('use "clog save <id>" to refresh the saved copy from its source file');
      expect(stdout).toContain("1 modified");
      expect(stdout).toContain("1 conversation");
      expect(stdout).not.toContain("1 source");
    });

    it("shows unindexed saved conversations in a search section when search is configured, even without a remote", async () => {
      const config = await loadConfig();
      config.search = {
        embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
        vectorStore: { type: "vectra" },
      };
      await saveConfig(config);

      await insertConversation(
        makeConversation({
          id: "c8888888-8888-8888-8888-888888888888",
          sourceId: "c8888888-8888-8888-8888-888888888888",
          title: "Local unindexed row",
          state: "saved",
          filePath: "/tmp/local-unindexed.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Search:");
      expect(stdout).toContain("1 conversation(s) not yet indexed");
      expect(stdout).not.toContain("Remote:");
    });

    it("hides the search section when search is not configured", async () => {
      await insertConversation(
        makeConversation({
          id: "c7777777-7777-7777-7777-777777777777",
          sourceId: "c7777777-7777-7777-7777-777777777777",
          title: "Local unindexed row",
          state: "saved",
          filePath: "/tmp/local-unindexed.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).not.toContain("Search:");
      expect(stdout).not.toContain("not yet indexed");
    });

    it("renders a remote section when a remote is configured", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      await insertConversation(
        makeConversation({
          id: "c5555555-5555-5555-5555-555555555555",
          sourceId: "c5555555-5555-5555-5555-555555555555",
          title: "Remote row",
          author: "bob",
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );
      await insertConversation(
        makeConversation({
          id: "c5656565-5555-5555-5555-555555555555",
          sourceId: "c5656565-5555-5555-5555-555555555555",
          title: "File row",
          author: "bob",
          state: "saved",
          filePath: "/tmp/imported-file.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
          indexedAt: null,
        }),
      );

      const { stdout } = await runBuiltCommand(buildStatusCommand, []);
      expect(stdout).toContain("Remote: git@example.com:team/repo.git");
      expect(stdout).toContain("1 conversation(s) imported from remote");
      expect(stdout).not.toContain("Search:");
    });
  });

  // ========================================
  // remote add/show/remove
  // ========================================

  describe("remote (SPEC §11.6)", () => {
    beforeEach(() => {
      mockedCheckVisibility.mockReset();
      mockedCheckVisibility.mockResolvedValue({
        kind: "unverified",
        reason: "test-default",
      });
    });

    it("add refuses when a remote is already configured", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      await expect(
        runBuiltCommand(buildRemoteCommand, ["add", "git@example.com:other/repo.git", "--yes"]),
      ).rejects.toThrow(/already configured/);
    });

    it("add rejects an empty URL", async () => {
      await expect(
        runBuiltCommand(buildRemoteCommand, ["add", "   ", "--yes"]),
      ).rejects.toThrow(/cannot be empty/);
    });

    it("add stores the URL and marks visibilityConfirmed=true on an unverified probe with --yes", async () => {
      mockedCheckVisibility.mockResolvedValueOnce({
        kind: "unverified",
        reason: "non-GitHub host — clog cannot probe visibility over REST",
      });

      const { stdout } = await runBuiltCommand(buildRemoteCommand, [
        "add",
        "git@example.com:team/repo.git",
        "--yes",
      ]);

      expect(stdout).toContain("Remote configured");
      const config = await loadConfig();
      expect(config.remote.url).toBe("git@example.com:team/repo.git");
      expect(config.remote.visibilityConfirmed).toBe(true);
    });

    it("add refuses a proven-public repo and includes the repo label in the error", async () => {
      mockedCheckVisibility.mockResolvedValueOnce({ kind: "public" });

      await expect(
        runBuiltCommand(buildRemoteCommand, [
          "add",
          "git@github.com:myorg/clog-team.git",
          "--yes",
        ]),
      ).rejects.toThrow(/Repository myorg\/clog-team is public/);

      // Refused adds must not write the remote config.
      const config = await loadConfig();
      expect(config.remote.url).toBeNull();
    });

    it("add proceeds with a warning when the repo is public but allowPublicRemote is set", async () => {
      const config = await loadConfig();
      config.remote.allowPublicRemote = true;
      await saveConfig(config);

      mockedCheckVisibility.mockResolvedValueOnce({ kind: "public" });

      const { stderr, stdout } = await runBuiltCommand(buildRemoteCommand, [
        "add",
        "git@github.com:myorg/clog-team.git",
        "--yes",
      ]);

      expect(stderr).toContain("public");
      expect(stdout).toContain("Remote configured");
      const reloaded = await loadConfig();
      expect(reloaded.remote.url).toBe("git@github.com:myorg/clog-team.git");
    });

    it("add prints an HTTPS-GitHub authentication warning before running the visibility probe", async () => {
      mockedCheckVisibility.mockResolvedValueOnce({
        kind: "unverified",
        reason: "test",
      });

      const { stderr } = await runBuiltCommand(buildRemoteCommand, [
        "add",
        "https://github.com/myorg/clog-team.git",
        "--yes",
      ]);

      expect(stderr).toContain("GitHub does not support password authentication over HTTPS");
      expect(stderr).toContain("git@github.com:owner/repo.git");
    });

    it("show reports no remote when the config is unset", async () => {
      const { stdout } = await runBuiltCommand(buildRemoteCommand, ["show"]);
      expect(stdout).toContain("No remote configured");
    });

    it("show prints URL, last-sync HEAD, and local/remote counts when a remote is configured", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      config.remote.lastSyncHead = "abc1234";
      await saveConfig(config);

      await insertConversation(
        makeConversation({
          id: "d1111111-1111-1111-1111-111111111111",
          sourceId: "d1111111-1111-1111-1111-111111111111",
          state: "saved",
          filePath: "/tmp/local.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: "d2222222-2222-2222-2222-222222222222",
          sourceId: "d2222222-2222-2222-2222-222222222222",
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: "d2323232-2222-2222-2222-222222222222",
          sourceId: "d2323232-2222-2222-2222-222222222222",
          state: "saved",
          filePath: "/tmp/imported-file.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildRemoteCommand, ["show"]);
      expect(stdout).toContain("Remote URL: git@example.com:team/repo.git");
      expect(stdout).toContain("Last sync HEAD: abc1234");
      expect(stdout).toContain("Local saved conversations: 1");
      expect(stdout).toContain("Remote conversations imported: 1");
    });

    it("remove refuses when no remote is configured", async () => {
      await expect(
        runBuiltCommand(buildRemoteCommand, ["remove", "--yes"]),
      ).rejects.toThrow(/No remote configured/);
    });

    it("remove deletes git-origin rows, clears config, and preserves local rows", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      const localId = "d3333333-3333-3333-3333-333333333333";
      const remoteId = "d4444444-4444-4444-4444-444444444444";
      const fileId = "d4545454-4444-4444-4444-444444444444";

      await insertConversation(
        makeConversation({
          id: localId,
          sourceId: localId,
          state: "saved",
          filePath: "/tmp/local.jsonl",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: remoteId,
          sourceId: remoteId,
          state: "saved",
          filePath: "/tmp/remote.jsonl",
          originKind: "git",
          originRef: "git@example.com:team/repo.git",
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );
      await insertConversation(
        makeConversation({
          id: fileId,
          sourceId: fileId,
          state: "saved",
          filePath: "/tmp/imported-file.jsonl",
          originKind: "file",
          originRef: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          saveVersion: 1,
        }),
      );

      const { stdout } = await runBuiltCommand(buildRemoteCommand, ["remove", "--yes"]);
      expect(stdout).toContain("Remote removed");
      expect(stdout).toContain("Deleted 1 conversation(s)");

      const local = await getConversationById(localId);
      const remote = await getConversationById(remoteId);
      const file = await getConversationById(fileId);
      expect(local).not.toBeNull();
      expect(remote).toBeNull();
      expect(file).not.toBeNull();

      const reloaded = await loadConfig();
      expect(reloaded.remote.url).toBeNull();
    });
  });

  // ========================================
  // refresh
  // ========================================

  describe("refresh (SPEC §11)", () => {
    it("prints 'No remote configured' when the config is unset", async () => {
      const { stdout } = await runBuiltCommand(buildRefreshCommand, []);
      expect(stdout).toContain("No remote configured");
    });

    it("prints 'No checkout found' when a remote is configured but the checkout is missing", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      const { stdout } = await runBuiltCommand(buildRefreshCommand, []);
      expect(stdout).toContain("No checkout found");
      expect(stdout).toContain("clog sync pull");
    });

    it("prints one summary line for pairs skipped by clogignore", async () => {
      const config = await loadConfig();
      config.remote.url = "git@example.com:team/repo.git";
      await saveConfig(config);

      const id = "eeeeeeee-1111-2222-3333-444444444444";
      const remoteRoot = getRemoteRoot();
      const sourceDir = path.join(remoteRoot, "alice", "claude-code");
      await fs.mkdir(path.join(remoteRoot, ".git"), { recursive: true });
      await fs.mkdir(sourceDir, { recursive: true });
      await fs.writeFile(
        path.join(sourceDir, `${id}.meta.json`),
        `${JSON.stringify({
          id,
          title: "Ignored remote pair",
          summary: "",
          tags: [],
          author: "alice",
          projectName: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          modifiedAt: "2026-02-01T10:00:00.000Z",
          source: "claude-code",
          createdAt: "2026-02-01T10:00:00.000Z",
          slug: null,
        }, null, 2)}\n`,
        "utf8",
      );
      await writeJsonl(path.join(sourceDir, `${id}.jsonl`), [
        userLine("Ignored", "2026-02-01T10:00:00.000Z"),
      ]);
      await fs.writeFile(getClogIgnorePath(), `${id}\n`, "utf8");

      const { stdout, stderr } = await runBuiltCommand(buildRefreshCommand, []);

      expect(stdout).toContain("Refreshed 0 conversation(s)");
      expect(stderr).toContain(
        "Skipped 1 remote conversation pair(s) because of clogignore",
      );
      expect(stderr.match(/because of clogignore/g)).toHaveLength(1);
    });
  });

  describe("applyHeadTail (SPEC §5.7.1)", () => {
    const items = [1, 2, 3, 4, 5];

    it("returns the first N items when head is supplied", () => {
      expect(applyHeadTail(items, { head: 3 })).toEqual([1, 2, 3]);
    });

    it("returns the last N items when tail is supplied", () => {
      expect(applyHeadTail(items, { tail: 2 })).toEqual([4, 5]);
    });

    it("returns the full array when neither option is supplied", () => {
      expect(applyHeadTail(items, {})).toEqual(items);
    });

    it("throws when both head and tail are supplied together", () => {
      expect(() => applyHeadTail(items, { head: 2, tail: 2 })).toThrow(/Cannot combine/);
    });

    it("clamps tail at 0 to an empty slice", () => {
      expect(applyHeadTail(items, { tail: 0 })).toEqual([]);
    });
  });
});

// ========================================
// helpers
// ========================================

async function runBuiltCommand(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const result = await runBuiltCommandCapturingError(builder, args);
  if (result.error) {
    throw result.error;
  }
  return { stdout: result.stdout, stderr: result.stderr };
}

async function runBuiltCommandCapturingError(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    return await captureOutputWithError(async () => {
      const cmd = builder();
      cmd.exitOverride();
      await cmd.parseAsync(args, { from: "user" });
    });
  } finally {
    process.exitCode = previousExitCode;
  }
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = "2026-02-01T10:00:00.000Z";
  const id = overrides.id ?? "aaaaaaaa-1111-2222-3333-444444444444";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Test conversation",
    summary: "",
    author: "testuser",
    projectName: "webapp",
    projectPath: "/Users/testuser/projects/webapp",
    tags: [],
    slug: null,
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "discovered",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: "/tmp/ignored.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}

async function seedConversation(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<ConversationMeta> {
  const conversation = makeConversation({ id, sourceId: id, ...overrides });
  await insertConversation(conversation);
  return conversation;
}

async function seedSavedConversation(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", id);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });
  await fs.writeFile(rawPath, "", "utf8");

  return seedConversation(id, {
    state: "saved",
    filePath: rawPath,
    savedAt: "2026-02-01T10:00:00.000Z",
    saveVersion: 1,
    ...overrides,
  });
}

async function seedRemoteConversation(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<ConversationMeta> {
  return seedConversation(id, {
    state: "saved",
    filePath: "/tmp/fake-remote.jsonl",
    originKind: "git",
    originRef: "git@example.com:team/repo.git",
    savedAt: "2026-02-01T10:00:00.000Z",
    saveVersion: 1,
    ...overrides,
  });
}

function mockExecFileSuccess(stdout = "", stderr = ""): void {
  mockedExecFile.mockImplementation(
    ((command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      callback(null, stdout, stderr);
      return {} as ReturnType<typeof childProcessModule.execFile>;
    }) as typeof childProcessModule.execFile,
  );
}

function mockExecFileFailure(message: string, stderr = message, stdout = ""): void {
  mockedExecFile.mockImplementationOnce(
    ((command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error(message), { code: 1 });
      callback(error, stdout, stderr);
      return {} as ReturnType<typeof childProcessModule.execFile>;
    }) as typeof childProcessModule.execFile,
  );
}

function mockExecFileMissing(): void {
  mockedExecFile.mockImplementationOnce(
    ((command: string, args: string[], callback: (error: Error | null, stdout: string, stderr: string) => void) => {
      const error = Object.assign(new Error(`${command} not found`), { code: "ENOENT" });
      callback(error, "", "");
      return {} as ReturnType<typeof childProcessModule.execFile>;
    }) as typeof childProcessModule.execFile,
  );
}

function mockSpawnExit(exitCode = 0): void {
  mockedSpawn.mockImplementationOnce(
    ((_command: string, _args?: readonly string[]) => {
      const child = new EventEmitter();
      process.nextTick(() => {
        child.emit("exit", exitCode);
      });
      return child as ReturnType<typeof childProcessModule.spawn>;
    }) as typeof childProcessModule.spawn,
  );
}

async function seedSavedConversationWithRawMessages(
  id: string,
  messageCount: number,
  savedMessageCount: number,
  overrides: Partial<ConversationMeta> = {},
): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", id);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });

  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < messageCount; i++) {
    lines.push(userLine(`Message ${i + 1}`, `2026-02-01T10:${String(i).padStart(2, "0")}:00.000Z`));
  }
  await writeJsonl(rawPath, lines);

  return seedConversation(id, {
    state: "saved",
    filePath: rawPath,
    sourcePath: "/tmp/nonexistent-source.jsonl",
    savedAt: "2026-02-01T10:00:00.000Z",
    saveVersion: 1,
    savedMessageCount,
    ...overrides,
  });
}

async function seedSavedConversationWithMessages(
  id: string,
  messageCount: number,
): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", id);
  await fs.mkdir(path.dirname(rawPath), { recursive: true });

  const lines: Record<string, unknown>[] = [];
  for (let i = 0; i < messageCount; i++) {
    lines.push(userLine(`Saved ${i + 1}`, `2026-02-01T10:${String(i).padStart(2, "0")}:00.000Z`));
  }
  await writeJsonl(rawPath, lines);

  return seedConversation(id, {
    state: "saved",
    filePath: rawPath,
    sourcePath: "/tmp/nonexistent-source.jsonl",
    savedAt: "2026-02-01T10:00:00.000Z",
    saveVersion: 1,
  });
}

async function writeMinimalClaudeJsonl(filePath: string, userText: string): Promise<void> {
  await writeJsonl(filePath, [
    userLine(userText, "2026-02-01T10:00:00.000Z", deriveClaudeCwd(filePath)),
    assistantLine("Response", "msg_01"),
  ]);
}

function userLine(
  content: string,
  timestamp = "2026-02-01T10:00:00.000Z",
  cwd = "/Users/testuser/projects/webapp",
): Record<string, unknown> {
  return {
    type: "user",
    message: { role: "user", content },
    timestamp,
    cwd,
  };
}

function assistantLine(
  text: string,
  msgId: string,
  timestamp = "2026-02-01T10:00:01.000Z",
): Record<string, unknown> {
  return {
    type: "assistant",
    message: {
      id: msgId,
      model: "claude-opus-4-6",
      type: "message",
      role: "assistant",
      content: [{ type: "text", text }],
      stop_reason: "end_turn",
    },
    timestamp,
  };
}

function claudeDiscoveredSourcePath(root: string, projectName: string, id: string): string {
  return path.join(root, projectName, `${id}.jsonl`);
}

function deriveClaudeCwd(filePath: string): string {
  return `/Users/testuser/projects/${path.basename(path.dirname(filePath))}`;
}
