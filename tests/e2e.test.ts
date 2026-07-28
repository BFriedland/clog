import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { unzipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeJsonl } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);
const ARCHIVE_WORKFLOW_TIMEOUT_MS = 30_000;

describe("e2e", () => {
  let tempDir: string;
  let clogHome: string;
  let claudeRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-e2e-"));
    clogHome = path.join(tempDir, ".clog");
    claudeRoot = path.join(tempDir, "claude");
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("config set/get round-trips", async () => {
    await run(["config", "set", "author", "alice"]);
    const { stdout } = await run(["config", "get", "author"]);

    expect(stdout.trim()).toBe('"alice"');
  });

  it("plunge exits before init without auto-creating clog home", async () => {
    await expect(run(["plunge"])).rejects.toMatchObject({
      stdout: "No existing clog state to inspect.\n",
    });

    await expect(fs.stat(clogHome)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("search guides the user to setup when search is not configured", async () => {
    await expect(run(["search", "jwt refresh"])).rejects.toMatchObject({
      stderr: expect.stringContaining('Search is not configured. Run "clog search --init".'),
    });
  });

  it("status discovers conversations after source path configuration", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "11111111-1111-1111-1111-111111111111.jsonl"),
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status"]);
    expect(stdout).toContain("api-service");
    expect(stdout).toContain("1 unsaved");
    expect(stdout).not.toContain("11111111");
  });

  it("status --source includes the source column after the short id", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "17171717-1717-1717-1717-171717171717.jsonl"),
      "Status source column",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status", "--source"], { COLUMNS: "120" });
    const lines = stdout.split("\n");
    const discoveredLine = lines.find((line) => line.includes("17171717"));

    expect(discoveredLine).toBeDefined();
    expect(discoveredLine).toContain("17171717  claude-code  2026-02-01");
  });

  it("status --conversations sizes the project column to content width instead of a fixed wide field", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "18181818-1818-1818-1818-181818181818.jsonl"),
      "Compact spacing",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status", "--conversations"], { COLUMNS: "120" });
    const lines = stdout.split("\n");
    const discoveredLine = lines.find((line) => line.includes("18181818"));

    expect(discoveredLine).toBeDefined();
    expect(discoveredLine).toContain("18181818  2026-02-01  api-service Compact spacing");
    expect(discoveredLine).not.toContain("api-service      Compact spacing");
  });

  it("status --conversations does not add ellipses to clean 100-character titles in wide terminals", async () => {
    const title = "A".repeat(120);
    const storedTitle = "A".repeat(100);
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "19191919-1919-1919-1919-191919191919.jsonl"),
      title,
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status", "--conversations"], { COLUMNS: "200" });
    const lines = stdout.split("\n");
    const discoveredLine = lines.find((line) => line.includes("19191919"));

    expect(discoveredLine).toBeDefined();
    expect(discoveredLine).toContain(storedTitle);
    expect(discoveredLine).not.toContain("...");
  });

  it("status omits empty sections and shows a clean fallback message", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status"]);

    expect(stdout).toContain("Nothing to save.");
    expect(stdout).not.toContain("Saved conversations with new messages:");
    expect(stdout).not.toContain("Saved conversations whose source files changed:");
    expect(stdout).not.toContain("Unsaved conversations:");
  });

  it("list performs implicit scanning for discovered conversations", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "44444444-4444-4444-4444-444444444444.jsonl"),
      "Implicit scan test",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["list", "--state", "unsaved"]);
    expect(stdout).toContain("44444444");
    expect(stdout).toContain("Implicit scan test");
  });

  it("list --tag uses exact case-insensitive matching", async () => {
    const firstId = "27272727-2727-2727-2727-272727272727";
    const secondId = "28282828-2828-2828-2828-282828282828";

    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${firstId}.jsonl`),
      "Tagged debugging",
    );
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${secondId}.jsonl`),
      "Tagged bug",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", firstId.slice(0, 8), secondId.slice(0, 8)]);
    await run(["tag", firstId.slice(0, 8), "debugging"]);
    await run(["tag", secondId.slice(0, 8), "bug"]);

    const { stdout } = await run(["list", "--state", "saved", "--tag", "BUG"]);

    expect(stdout).toContain("Tagged bug");
    expect(stdout).not.toContain("Tagged debugging");
  });

  it("list ignores the legacy excluded file and still succeeds", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(path.join(clogHome, "excluded"), "not-valid\n", "utf8");
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout, stderr } = await run(["list"]);

    expect(stdout).toContain("No saved conversations.");
    expect(stderr).toBe("");
  });

  it("list supports explicit columns", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "12121212-1212-1212-1212-121212121212.jsonl"),
      "Columns test",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["list", "--state", "unsaved", "--columns", "id,date,title"]);
    const [header] = stdout.trim().split("\n");

    expect(header).toContain("ID");
    expect(header).toContain("DATE");
    expect(header).toContain("TITLE");
    expect(header).not.toContain("STATE");
    expect(header).not.toContain("PROJECT");
  });

  it("list auto-shows the author column when multiple authors are present", async () => {
    const firstId = "13131313-1313-1313-1313-131313131313";
    const secondId = "14141414-1414-1414-1414-141414141414";

    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${firstId}.jsonl`),
      "First authored conversation",
    );
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${secondId}.jsonl`),
      "Second authored conversation",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", firstId.slice(0, 8), secondId.slice(0, 8)]);
    await run(["save"]);
    await run(["edit", secondId.slice(0, 8), "--author", "bob"]);

    const { stdout } = await run(["list"]);
    const [header] = stdout.trim().split("\n");

    expect(header).toContain("AUTHOR");
    expect(stdout).toContain("First authored conversation");
    expect(stdout).toContain("bob");
  });

  it("drain and export use operation-focused confirmation guidance", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    for (const command of ["drain", "export"]) {
      await expect(run([command])).rejects.toMatchObject({
        code: 2,
        stderr: expect.stringContaining(
          "Exporting all saved local conversations requires confirmation. Add a conversation or project selector, add a filter, or use --yes.",
        ),
      });
    }
  });

  it("drain returns exit code 1 with recovery guidance when an explicit ID does not match", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    await expect(run(["drain", "deadbeef"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `No conversation matches "deadbeef". Run 'clog list' or 'clog status' to inspect available conversations and projects.`,
      ),
    });
  });

  it("show renders a discovered conversation as raw source", async () => {
    const id = "19191919-1919-1919-1919-191919191919";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Drain raw source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    const { stdout } = await run(["show", id.slice(0, 8), "--raw"]);

    expect(stdout).toBe(await fs.readFile(filePath, "utf8"));
  });

  it("round-trips a foreign archive through export and import aliases", async () => {
    const id = "fa111111-1111-1111-1111-111111111111";
    const sourcePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    const exportArchive = path.join(tempDir, "foreign-export.zip");
    const roundTripDir = path.join(tempDir, "foreign-round-trip");
    await writeClaudeConversation(sourcePath, "Foreign fill round trip");

    await run(["config", "set", "author", "bob"]);
    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["export", id.slice(0, 8), "-o", exportArchive]);

    const archiveEntries = unzipSync(await fs.readFile(exportArchive));
    const originalMetaBytes = archiveEntries[`claude-code/${id}.meta.json`]!;
    const originalJsonlBytes = archiveEntries[`claude-code/${id}.jsonl`]!;
    const originalMeta = JSON.parse(Buffer.from(originalMetaBytes).toString("utf8"));
    expect(originalMeta.author).toBe("bob");

    clogHome = path.join(tempDir, ".clog-import-foreign");
    await run(["config", "set", "author", "alice"]);
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    for (const command of ["fill", "import"]) {
      const failedOwnImport = await run([command, exportArchive, "--own"]).catch(
        (error: unknown) => error as { code: number; stderr: string },
      );
      expect(failedOwnImport).toMatchObject({ code: 1 });
      expect(failedOwnImport.stderr).toContain(
        "One or more conversations by another author were found while importing with --own",
      );
      expect(failedOwnImport.stderr).toContain(
        "Fix the errors, or run clog fill without --own to import them as read-only copies.",
      );
    }

    const fill = await run(["import", exportArchive]);
    expect(fill.stderr).toContain("Imported 1 conversation");
    expect(fill.stderr).toContain("clog list --all");

    const hiddenList = await run(["list"]);
    expect(hiddenList.stdout).not.toContain("Foreign fill round trip");

    const allList = await run(["list", "--all", "--columns", "id,author,title"]);
    expect(allList.stdout).toContain(id.slice(0, 8));
    expect(allList.stdout).toContain("bob");
    expect(allList.stdout).toContain("Foreign fill round trip");

    const show = await run(["show", id.slice(0, 8)]);
    expect(show.stdout).toContain("Foreign fill round trip");
    expect(show.stdout).toContain("State:   saved");

    await run(["drain", id.slice(0, 8), "--format", "dir", "-o", roundTripDir]);
    expect(JSON.parse(await fs.readFile(
      path.join(roundTripDir, "claude-code", `${id}.meta.json`),
      "utf8",
    ))).toEqual(originalMeta);
    expect(await fs.readFile(
      path.join(roundTripDir, "claude-code", `${id}.jsonl`),
      "utf8",
    )).toBe(Buffer.from(originalJsonlBytes).toString("utf8"));
  }, ARCHIVE_WORKFLOW_TIMEOUT_MS);

  it("restores an own drained pair as clean and keeps local edit, tag, diff, and save workflows", async () => {
    const id = "fa222222-2222-2222-2222-222222222222";
    const sourcePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    const exportDir = path.join(tempDir, "own-export");
    await writeClaudeConversation(sourcePath, "Own fill workflow");

    await run(["config", "set", "author", "alice"]);
    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["drain", id.slice(0, 8), "--format", "dir", "-o", exportDir]);

    clogHome = path.join(tempDir, ".clog-import-own");
    await run(["config", "set", "author", "alice"]);
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    await run(["fill", exportDir, "--own"]);

    const cleanStatus = await run(["status"]);
    expect(cleanStatus.stdout).toContain("Nothing to save.");
    const cleanSave = await run(["save"]);
    expect(cleanSave.stdout).toContain("No conversations need saving.");

    await run(["edit", id.slice(0, 8), "--title", "Restored local workflow"]);
    await run(["tag", id.slice(0, 8), "restored"]);
    const tagged = await run(["list", "--tag", "restored"]);
    expect(tagged.stdout).toContain("Restored local workflow");

    const rawPath = path.join(clogHome, "raw", "claude-code", `${id}.jsonl`);
    await appendClaudeTurn(rawPath, "Follow-up after restore", "Saved after restore");

    const diff = await run(["diff", id.slice(0, 8)]);
    expect(diff.stdout).toContain("Follow-up after restore");

    const readyStatus = await run(["status"]);
    expect(readyStatus.stdout).toContain("Saved conversations with new messages:");
    expect(readyStatus.stdout).toContain("api-service");

    const saved = await run(["save"]);
    expect(saved.stdout).toContain("Saved 1 conversation(s).");

    const finalStatus = await run(["status"]);
    expect(finalStatus.stdout).toContain("Nothing to save.");
  }, ARCHIVE_WORKFLOW_TIMEOUT_MS);

  it("save then show works for a discovered conversation", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Debug auth flow",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["save"]);

    const { stdout } = await run(["show", id.slice(0, 8)]);
    expect(stdout).toContain("Debug auth flow");
    expect(stdout).toContain("State:   saved");
  });

  it("edit with no flags prints help instead of failing", async () => {
    const id = "21212121-2121-2121-2121-212121212121";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Edit help behavior",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    const { stdout } = await run(["edit", id.slice(0, 8)]);
    expect(stdout).toContain("Usage: clog edit");
    expect(stdout).toContain("--title <text>");
    expect(stdout).toContain("--summary <text>");
    expect(stdout).toContain("--author <name>");
  });

  it("show --path and path resolve discovered conversations to the source path", async () => {
    const id = "15151515-1515-1515-1515-151515151515";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Path from discovered");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    const showPath = await run(["show", id.slice(0, 8), "--path"]);
    const pathCmd = await run(["path", id.slice(0, 8)]);

    expect(showPath.stdout.trim()).toBe(filePath);
    expect(pathCmd.stdout.trim()).toBe(filePath);
  });

  it("show no longer resolves an unsaved conversation after its source file disappears", async () => {
    const id = "26262626-2626-2626-2626-262626262626";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Show missing source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await fs.rm(filePath);

    await expect(run(["show", id.slice(0, 8)])).rejects.toMatchObject({
      stderr: expect.stringContaining(`No conversation matches "${id.slice(0, 8)}".`),
    });
  });

  it("show --path and path resolve curated conversations to the raw copy path", async () => {
    const id = "16161616-1616-1616-1616-161616161616";
    const sourcePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(sourcePath, "Path from curated");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);

    const expectedRawPath = path.join(clogHome, "raw", "claude-code", `${id}.jsonl`);
    const showPath = await run(["show", id.slice(0, 8), "--path"]);
    const pathCmd = await run(["path", id.slice(0, 8)]);

    expect(showPath.stdout.trim()).toBe(expectedRawPath);
    expect(pathCmd.stdout.trim()).toBe(expectedRawPath);
  });

  it("show supports head and tail message limits", async () => {
    const id = "17171717-1717-1717-1717-171717171717";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Show limits",
      [
        {
          type: "assistant",
          timestamp: "2026-02-01T10:00:02.000Z",
          message: {
            id: "msg_2",
            role: "assistant",
            content: [{ type: "text", text: "Assistant first reply." }],
          },
        },
        {
          type: "user",
          timestamp: "2026-02-01T10:00:03.000Z",
          message: {
            role: "user",
            content: "Second user message",
          },
        },
        {
          type: "assistant",
          timestamp: "2026-02-01T10:00:04.000Z",
          message: {
            id: "msg_3",
            role: "assistant",
            content: [{ type: "text", text: "Assistant final reply." }],
          },
        },
      ],
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["save"]);

    const head = await run(["show", id.slice(0, 8), "--first", "2"]);
    const tail = await run(["show", id.slice(0, 8), "--last", "2"]);

    expect(head.stdout).toContain("[USER] Show limits");
    expect(head.stdout).toContain("[ASSISTANT] Working on it.");
    expect(head.stdout).not.toContain("Assistant first reply.");

    expect(tail.stdout).toContain("[USER] Second user message");
    expect(tail.stdout).toContain("[ASSISTANT] Assistant final reply.");
    expect(tail.stdout).not.toContain("[ASSISTANT] Working on it.");
  });

  it("status --conversations renders discovered titles on one line", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "33333333-3333-3333-3333-333333333333.jsonl"),
      "Agent report:\n\n1. First item\n2. Second item",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status", "--conversations"]);
    expect(stdout).toContain("Agent report: 1. First item 2. Second item");
    expect(stdout).not.toContain("Agent report:\n\n1. First item");
  });

  it("explicit save works from discovered state", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Save from discovered",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);

    const { stdout } = await run(["show", id.slice(0, 8)]);
    expect(stdout).toContain("State:   saved");
    expect(stdout).toContain("Save from discovered");
  });

  it("diff uses newer source content for saved conversations before explicit resave", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Diff source growth");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["save"]);

    await writeClaudeConversation(filePath, "Diff source growth", [
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "New source-only message." }],
        },
      },
    ]);

    const { stdout } = await run(["diff", id.slice(0, 8)]);
    expect(stdout).toContain("New source-only message.");
    expect(stdout).toContain("since v1");
  });

  it("diff resolves IDs only against the saved collection", async () => {
    const id = "19191919-1919-1919-1919-191919191919";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Diff wrong state",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    await expect(run(["diff", id.slice(0, 8)])).rejects.toMatchObject({
      stderr: expect.stringContaining(`No conversation matches "${id.slice(0, 8)}".`),
    });
  });

  it("explicit save refreshes a saved raw copy without changing state", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Refresh saved raw copy");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["save"]);

    await writeClaudeConversation(filePath, "Refresh saved raw copy", [
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Refreshed into raw." }],
        },
      },
    ]);

    await run(["save", id.slice(0, 8)]);
    const { stdout } = await run(["show", id.slice(0, 8)]);
    expect(stdout).toContain("State:   saved");
    expect(stdout).toContain("Refreshed into raw.");
  });

  it("targeted save fails clearly when the conversation disappears during refresh", async () => {
    const id = "24242424-2424-2424-2424-242424242424";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Targeted add missing source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await fs.rm(filePath);

    await expect(run(["save", id.slice(0, 8)])).rejects.toMatchObject({
      stderr: expect.stringContaining(`No conversation matches "${id.slice(0, 8)}"`),
    });
  });

  it("exclude writes clogignore and unexclude removes the exact rule again", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Exclude and unexclude",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["exclude", id.slice(0, 8)]);

    const afterExclude = await run(["list", "--state", "unsaved"]);
    expect(afterExclude.stdout).not.toContain("Exclude and unexclude");

    await run(["unexclude", id.slice(0, 8)]);
    const afterUnexclude = await run(["list", "--state", "unsaved"]);
    expect(afterUnexclude.stdout).toContain("Exclude and unexclude");
  });

  it("list --all shows ignored conversations that are still discoverable", async () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Excluded but still on disk",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["exclude", id.slice(0, 8)]);

    const { stdout } = await run(["list", "--all"]);
    expect(stdout).toContain("ignored");
    expect(stdout).toContain("Excluded but still on disk");
  });

  it("exclude rejects project selector syntax", async () => {
    const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Reject project selector",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    await expect(run(["exclude", "project:api-service"])).rejects.toMatchObject({
      stderr: expect.stringContaining("does not accept project selectors"),
    });
  });

  it("unexclude removes exact matching lines without using selector semantics", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(
      path.join(clogHome, "clogignore"),
      ["fffffff", "other", "fffffff"].join("\n"),
      "utf8",
    );

    await run(["unexclude", "fffffff"]);

    await expect(fs.readFile(path.join(clogHome, "clogignore"), "utf8")).resolves.toBe("other\n");
  });

  it("status reports saved source changes", async () => {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Status modified saved");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["save", id.slice(0, 8)]);
    await run(["save"]);

    await writeClaudeConversation(filePath, "Status modified saved", [
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Changed after save." }],
        },
      },
    ]);

    const { stdout } = await run(["status"]);
    expect(stdout).toContain("Saved conversations whose source files changed:");
    expect(stdout).toContain(
      'use "clog save <id>" to refresh the saved copy from its source file',
    );
    expect(stdout).toContain("api-service");
    expect(stdout).toContain("1 conversation");
  });

  it("status ignores the legacy excluded file and still succeeds", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(path.join(clogHome, "excluded"), "not-valid\n", "utf8");
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout, stderr } = await run(["status"]);

    expect(stdout).toContain("Nothing to save.");
    expect(stderr).toBe("");
  });

  it("status --undiscoverable shows details without repeating the hint", async () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await writeJsonl(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      [
        {
          type: "user",
          timestamp: "2026-02-01T10:00:00.000Z",
          message: {
            role: "user",
            content: "Project path missing",
          },
        },
      ],
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const summary = await run(["status"]);
    expect(summary.stdout).toContain('run "clog status --missing-project" for details');

    const detailed = await run(["status", "--missing-project"]);
    expect(detailed.stdout).toContain("Conversations without a project path:");
    expect(detailed.stdout).toContain("claude-code");
    expect(detailed.stdout).not.toContain('run "clog status --missing-project" for details');
  });

  it("status reports Codex undiscoverable conversations in the summary and details", async () => {
    const codexRoot = path.join(tempDir, ".codex");
    const id = "efefefef-1111-2222-3333-444444444444";
    await writeJsonl(
      path.join(
        codexRoot,
        "sessions",
        "2026",
        "02",
        "01",
        `rollout-2026-02-01T10-00-00-${id}.jsonl`,
      ),
      [
        {
          type: "session_meta",
          payload: {
            id,
            timestamp: "2026-02-01T10:00:00.000Z",
          },
        },
      ],
    );

    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.paths", JSON.stringify([codexRoot])]);

    const summary = await run(["status"]);
    expect(summary.stdout).toContain("1 without a project path");
    expect(summary.stdout).toContain('run "clog status --missing-project" for details');
    expect(summary.stderr).not.toContain("project path missing");

    const detailed = await run(["status", "--missing-project"]);
    expect(detailed.stdout).toContain("1 without a project path");
    expect(detailed.stdout).toContain("Conversations without a project path:");
    expect(detailed.stdout).toContain("codex-cli");
    expect(detailed.stdout).not.toContain('run "clog status --missing-project" for details');
  });

  it("status collapses repeated Codex source_id_mismatch warnings into one stderr line", async () => {
    const codexRoot = path.join(tempDir, ".codex");
    const filenameIdOne = "11111111-aaaa-bbbb-cccc-111111111111";
    const embeddedIdOne = "99999999-aaaa-bbbb-cccc-999999999999";
    const filenameIdTwo = "22222222-aaaa-bbbb-cccc-222222222222";
    const embeddedIdTwo = "88888888-aaaa-bbbb-cccc-888888888888";

    await writeMismatchedCodexSession(codexRoot, filenameIdOne, embeddedIdOne);
    await writeMismatchedCodexSession(codexRoot, filenameIdTwo, embeddedIdTwo);

    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.paths", JSON.stringify([codexRoot])]);

    const { stderr } = await run(["status"]);
    expect(stderr).toContain(
      'warning: Codex session ID in file contents does not match the filename suffix; using embedded ID. (2 occurrences)',
    );
    expect(stderr).toContain('hint: Run "clog status --verbose-warnings" for the full list');
    expect(stderr).not.toContain("source=codex-cli");
    expect(stderr).not.toContain(filenameIdOne);
    expect(stderr).not.toContain(filenameIdTwo);
  });

  it("status --verbose-warnings expands collapsed Codex warnings into per-file lines", async () => {
    const codexRoot = path.join(tempDir, ".codex");
    const filenameIdOne = "33333333-aaaa-bbbb-cccc-333333333333";
    const embeddedIdOne = "77777777-aaaa-bbbb-cccc-777777777777";
    const filenameIdTwo = "44444444-aaaa-bbbb-cccc-444444444444";
    const embeddedIdTwo = "66666666-aaaa-bbbb-cccc-666666666666";

    await writeMismatchedCodexSession(codexRoot, filenameIdOne, embeddedIdOne);
    await writeMismatchedCodexSession(codexRoot, filenameIdTwo, embeddedIdTwo);

    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.paths", JSON.stringify([codexRoot])]);

    const { stderr } = await run(["status", "--verbose-warnings"]);
    expect(stderr).not.toContain("occurrences");
    expect(stderr).not.toContain('hint: Run "clog status --verbose-warnings"');
    expect(stderr).toContain("source=codex-cli");
    expect(stderr).toContain(filenameIdOne);
    expect(stderr).toContain(filenameIdTwo);
    const mismatchLines = stderr.split("\n").filter((line) =>
      line.includes("does not match the filename suffix"),
    );
    expect(mismatchLines).toHaveLength(2);
  });

  it("list aggregates undiscoverable warnings into a single stderr line", async () => {
    const firstId = "cdcdcdcd-1111-2222-3333-444444444444";
    const secondId = "efefefef-5555-6666-7777-888888888888";
    await writeJsonl(
      path.join(claudeRoot, "-Users-alice-api-service", `${firstId}.jsonl`),
      [
        {
          type: "user",
          timestamp: "2026-02-01T10:00:00.000Z",
          message: {
            role: "user",
            content: "Missing cwd one",
          },
        },
      ],
    );
    await writeJsonl(
      path.join(claudeRoot, "-Users-alice-api-service", `${secondId}.jsonl`),
      [
        {
          type: "user",
          timestamp: "2026-02-01T10:01:00.000Z",
          message: {
            role: "user",
            content: "Missing cwd two",
          },
        },
      ],
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stderr } = await run(["list", "--state", "unsaved"]);
    expect(stderr).toContain(
      "warning: Skipped 2 conversation(s): project path missing: these conversation files have no cwd metadata.",
    );
    expect(stderr).toContain('hint: Run "clog status --missing-project" for details.');
    expect(stderr).not.toContain(`${firstId}.jsonl`);
    expect(stderr).not.toContain(`${secondId}.jsonl`);
  });

  it("list truncates title columns to fit narrow terminal widths", async () => {
    const id = "cccccccc-cccc-cccc-cccc-cccccccccccc";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "This title should be aggressively truncated for a narrow terminal width",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["list", "--state", "unsaved"], {
      COLUMNS: "55",
    });

    expect(stdout).toContain("...");
  });

  async function run(args: string[], extraEnv: Record<string, string> = {}) {
    return execFileAsync(
      process.execPath,
      ["--import", "tsx", path.join(process.cwd(), "src/index.ts"), ...args],
      {
        cwd: process.cwd(),
        env: {
          ...process.env,
          CLOG_HOME: clogHome,
          ...extraEnv,
        },
      },
    );
  }
});

async function writeMismatchedCodexSession(
  codexRoot: string,
  filenameId: string,
  embeddedId: string,
): Promise<void> {
  await writeJsonl(
    path.join(
      codexRoot,
      "sessions",
      "2026",
      "02",
      "01",
      `rollout-2026-02-01T10-00-00-${filenameId}.jsonl`,
    ),
    [
      {
        type: "session_meta",
        payload: {
          id: embeddedId,
          timestamp: "2026-02-01T10:00:00.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Codex conversation",
        },
      },
    ],
  );
}

async function writeClaudeConversation(
  filePath: string,
  title = "Title",
  extraLines: unknown[] = [],
): Promise<void> {
  await writeJsonl(filePath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/api-service",
      message: {
        role: "user",
        content: title,
      },
    },
    {
      type: "assistant",
      timestamp: "2026-02-01T10:00:01.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
      },
    },
    ...extraLines,
  ]);
}

async function appendClaudeTurn(
  filePath: string,
  userText: string,
  assistantText: string,
): Promise<void> {
  const lines = [
    {
      type: "user",
      timestamp: "2026-02-01T10:05:00.000Z",
      cwd: "/Users/alice/api-service",
      message: {
        role: "user",
        content: userText,
      },
    },
    {
      type: "assistant",
      timestamp: "2026-02-01T10:05:01.000Z",
      message: {
        id: "msg_2",
        role: "assistant",
        content: [{ type: "text", text: assistantText }],
      },
    },
  ];

  await fs.appendFile(
    filePath,
    lines.map((line) => JSON.stringify(line)).join("\n") + "\n",
    "utf8",
  );
}
