import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { writeJsonl } from "./helpers/fixtures.js";

const execFileAsync = promisify(execFile);

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
    expect(stdout).toContain("1111111");
    expect(stdout).toContain("discovered");
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
    const discoveredLine = lines.find((line) => line.includes("1717171"));

    expect(discoveredLine).toBeDefined();
    expect(discoveredLine).toContain("1717171  claude-code  2026-02-01");
  });

  it("status sizes the project column to content width instead of a fixed wide field", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "18181818-1818-1818-1818-181818181818.jsonl"),
      "Compact spacing",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status"], { COLUMNS: "120" });
    const lines = stdout.split("\n");
    const discoveredLine = lines.find((line) => line.includes("1818181"));

    expect(discoveredLine).toBeDefined();
    expect(discoveredLine).toContain("1818181  2026-02-01  api-service Compact spacing");
    expect(discoveredLine).not.toContain("api-service      Compact spacing");
  });

  it("status omits empty sections and shows a clean fallback message", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status"]);

    expect(stdout).toContain("No conversations pending publication.");
    expect(stdout).not.toContain("Conversations to be published:");
    expect(stdout).not.toContain("Changes not staged for publishing:");
    expect(stdout).not.toContain("Untracked conversations:");
  });

  it("list performs implicit scanning for discovered conversations", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "44444444-4444-4444-4444-444444444444.jsonl"),
      "Implicit scan test",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["list", "--state", "discovered"]);
    expect(stdout).toContain("4444444");
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
    await run(["add", firstId.slice(0, 7), secondId.slice(0, 7)]);
    await run(["tag", firstId.slice(0, 7), "debugging"]);
    await run(["tag", secondId.slice(0, 7), "bug"]);

    const { stdout } = await run(["list", "--state", "staged", "--tag", "BUG"]);

    expect(stdout).toContain("Tagged bug");
    expect(stdout).not.toContain("Tagged debugging");
  });

  it("list warns about invalid excluded entries but still succeeds", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(path.join(clogHome, "excluded"), "not-valid\n", "utf8");
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout, stderr } = await run(["list"]);

    expect(stdout).toContain("No staged or published conversations.");
    expect(stderr).toContain("warning: Invalid excluded-file entry at line 1.");
  });

  it("list supports explicit columns", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "12121212-1212-1212-1212-121212121212.jsonl"),
      "Columns test",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["list", "--state", "discovered", "--columns", "id,date,title"]);
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
    await run(["add", firstId.slice(0, 7), secondId.slice(0, 7)]);
    await run(["publish"]);
    await run(["edit", secondId.slice(0, 7), "--author", "bob"]);

    const { stdout } = await run(["list"]);
    const [header] = stdout.trim().split("\n");

    expect(header).toContain("AUTHOR");
    expect(stdout).toContain("First authored conversation");
    expect(stdout).toContain("bob");
  });

  it("drain returns exit code 2 for stdout usage with no ids, no filters, and no --to", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    await expect(run(["drain"])).rejects.toMatchObject({
      code: 2,
      stderr: expect.stringContaining(
        "clog drain requires a conversation ID, a filter, --to <path>, or --to-dir <dir>.",
      ),
    });
  });

  it("drain returns exit code 1 with recovery guidance when an explicit ID does not match", async () => {
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    await expect(run(["drain", "deadbeef"])).rejects.toMatchObject({
      code: 1,
      stderr: expect.stringContaining(
        `No conversation matches "deadbeef". Run 'clog list' or 'clog status' to find available IDs.`,
      ),
    });
  });

  it("drain exports a discovered conversation as raw source", async () => {
    const id = "19191919-1919-1919-1919-191919191919";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Drain raw source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    const { stdout } = await run(["drain", id.slice(0, 7), "--raw"]);

    expect(stdout).toBe(await fs.readFile(filePath, "utf8"));
  });

  it("add then publish then show works for a discovered conversation", async () => {
    const id = "22222222-2222-2222-2222-222222222222";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Debug auth flow",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

    const { stdout } = await run(["show", id.slice(0, 7)]);
    expect(stdout).toContain("Debug auth flow");
    expect(stdout).toContain("State:   published");
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

    const { stdout } = await run(["edit", id.slice(0, 7)]);
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

    const showPath = await run(["show", id.slice(0, 7), "--path"]);
    const pathCmd = await run(["path", id.slice(0, 7)]);

    expect(showPath.stdout.trim()).toBe(filePath);
    expect(pathCmd.stdout.trim()).toBe(filePath);
  });

  it("show fails with clog-style guidance when a discovered source file is missing", async () => {
    const id = "26262626-2626-2626-2626-262626262626";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Show missing source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await fs.rm(filePath);

    await expect(run(["show", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining(`Source file is missing for ${id}. Run "clog status" to refresh discovery.`),
    });
  });

  it("show --path and path resolve curated conversations to the raw copy path", async () => {
    const id = "16161616-1616-1616-1616-161616161616";
    const sourcePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(sourcePath, "Path from curated");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);

    const expectedRawPath = path.join(clogHome, "raw", "claude-code", `${id}.jsonl`);
    const showPath = await run(["show", id.slice(0, 7), "--path"]);
    const pathCmd = await run(["path", id.slice(0, 7)]);

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
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

    const head = await run(["show", id.slice(0, 7), "--first", "2"]);
    const tail = await run(["show", id.slice(0, 7), "--last", "2"]);

    expect(head.stdout).toContain("[USER] Show limits");
    expect(head.stdout).toContain("[ASSISTANT] Working on it.");
    expect(head.stdout).not.toContain("Assistant first reply.");

    expect(tail.stdout).toContain("[USER] Second user message");
    expect(tail.stdout).toContain("[ASSISTANT] Assistant final reply.");
    expect(tail.stdout).not.toContain("[ASSISTANT] Working on it.");
  });

  it("status renders discovered titles on one line", async () => {
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", "33333333-3333-3333-3333-333333333333.jsonl"),
      "Agent report:\n\n1. First item\n2. Second item",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout } = await run(["status"]);
    expect(stdout).toContain("Agent report: 1. First item 2. Second item");
    expect(stdout).not.toContain("Agent report:\n\n1. First item");
  });

  it("explicit publish works from discovered state", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Publish from discovered",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["publish", id.slice(0, 7)]);

    const { stdout } = await run(["show", id.slice(0, 7)]);
    expect(stdout).toContain("State:   published");
    expect(stdout).toContain("Publish from discovered");
  });

  it("unpublish rejects conversations that are not published", async () => {
    const id = "23232323-2323-2323-2323-232323232323";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Unpublish wrong state",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);

    await expect(run(["unpublish", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining("is not published"),
    });
  });

  it("diff uses newer source content for published conversations before add", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Diff source growth");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

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

    const { stdout } = await run(["diff", id.slice(0, 7)]);
    expect(stdout).toContain("New source-only message.");
    expect(stdout).toContain("since v1");
  });

  it("diff --staged shows staged conversations and uses truncation notes", async () => {
    const id = "18181818-1818-1818-1818-181818181818";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Diff staged preview",
      [
        {
          type: "assistant",
          timestamp: "2026-02-01T10:00:02.000Z",
          message: {
            id: "msg_2",
            role: "assistant",
            content: [{ type: "text", text: "Assistant extra one." }],
          },
        },
        {
          type: "user",
          timestamp: "2026-02-01T10:00:03.000Z",
          message: {
            role: "user",
            content: "User extra two.",
          },
        },
      ],
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);

    const { stdout } = await run(["diff", "--staged", "--head", "2"]);
    expect(stdout).toContain("since v0, showing 2 of 4 new messages");
    expect(stdout).toContain("[USER] Diff staged preview");
    expect(stdout).toContain("[ASSISTANT] Working on it.");
    expect(stdout).not.toContain("Assistant extra one.");
  });

  it("diff rejects staged conversations in default mode", async () => {
    const id = "19191919-1919-1919-1919-191919191919";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Diff wrong state",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);

    await expect(run(["diff", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining("is not published"),
    });
  });

  it("diff --staged rejects published conversations", async () => {
    const id = "20202020-2020-2020-2020-202020202020";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Diff staged wrong state",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

    await expect(run(["diff", "--staged", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining("is not staged"),
    });
  });

  it("add refreshes a published raw copy without changing state", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Refresh published raw copy");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

    await writeClaudeConversation(filePath, "Refresh published raw copy", [
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

    await run(["add", id.slice(0, 7)]);
    const { stdout } = await run(["show", id.slice(0, 7)]);
    expect(stdout).toContain("State:   published");
    expect(stdout).toContain("Refreshed into raw.");
  });

  it("targeted add fails clearly when the stored source path is missing", async () => {
    const id = "24242424-2424-2424-2424-242424242424";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);
    await writeClaudeConversation(filePath, "Targeted add missing source");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await fs.rm(filePath);

    await expect(run(["add", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining('Source file is missing for 24242424-2424-2424-2424-242424242424. Run "clog status" to refresh discovery.'),
    });
  });

  it("reset moves a staged conversation back to discovered", async () => {
    const id = "88888888-8888-8888-8888-888888888888";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Reset staged conversation",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["reset", id.slice(0, 7)]);

    const { stdout } = await run(["list", "--state", "discovered"]);
    expect(stdout).toContain("8888888");
    expect(stdout).toContain("discovered");
  });

  it("reset rejects conversations that are not staged", async () => {
    const id = "25252525-2525-2525-2525-252525252525";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Reset wrong state",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);

    await expect(run(["reset", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining("is not staged"),
    });
  });

  it("unpublish preserves the conversation as staged", async () => {
    const id = "99999999-9999-9999-9999-999999999999";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Unpublish conversation",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);
    await run(["unpublish", id.slice(0, 7)]);

    const { stdout } = await run(["show", id.slice(0, 7)]);
    expect(stdout).toContain("State:   staged");
  });

  it("exclude removes a conversation and unexclude allows rediscovery", async () => {
    const id = "aaaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Exclude and unexclude",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["exclude", id.slice(0, 7)]);

    const afterExclude = await run(["list", "--state", "discovered"]);
    expect(afterExclude.stdout).not.toContain("Exclude and unexclude");

    await run(["unexclude", id.slice(0, 7)]);
    const afterUnexclude = await run(["list", "--state", "discovered"]);
    expect(afterUnexclude.stdout).toContain("Exclude and unexclude");
  });

  it("list --all shows excluded conversations that are still discoverable", async () => {
    const id = "dddddddd-dddd-dddd-dddd-dddddddddddd";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Excluded but still on disk",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["exclude", id.slice(0, 7)]);

    const { stdout } = await run(["list", "--all"]);
    expect(stdout).toContain("excluded");
    expect(stdout).toContain("Excluded but still on disk");
  });

  it("exclude fails when the excluded file has invalid lines", async () => {
    const id = "eeeeeeee-eeee-eeee-eeee-eeeeeeeeeeee";
    await writeClaudeConversation(
      path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`),
      "Broken excluded file",
    );

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(path.join(clogHome, "excluded"), "not-valid\n", "utf8");

    await expect(run(["exclude", id.slice(0, 7)])).rejects.toMatchObject({
      stderr: expect.stringContaining("Excluded file is invalid."),
    });
  });

  it("unexclude fails when the excluded file has duplicate entries", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(
      path.join(clogHome, "excluded"),
      [
        "ffffffff-ffff-ffff-ffff-ffffffffffff@claude-code",
        "ffffffff-ffff-ffff-ffff-ffffffffffff@claude-code",
      ].join("\n"),
      "utf8",
    );

    await expect(run(["unexclude", "fffffff"])).rejects.toMatchObject({
      stderr: expect.stringContaining("Excluded file is invalid."),
    });
  });

  it("status reports published source changes as changes not staged for publishing", async () => {
    const id = "bbbbbbbb-bbbb-bbbb-bbbb-bbbbbbbbbbbb";
    const filePath = path.join(claudeRoot, "-Users-alice-api-service", `${id}.jsonl`);

    await writeClaudeConversation(filePath, "Status modified published");

    await run(["config", "set", "sources.claude-code.paths", JSON.stringify([claudeRoot])]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);
    await run(["status"]);
    await run(["add", id.slice(0, 7)]);
    await run(["publish"]);

    await writeClaudeConversation(filePath, "Status modified published", [
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          id: "msg_2",
          role: "assistant",
          content: [{ type: "text", text: "Changed after publish." }],
        },
      },
    ]);

    const { stdout } = await run(["status"]);
    expect(stdout).toContain("Changes not staged for publishing:");
    expect(stdout).toContain(
      'use "clog add <id>" to refresh the curated copy, or "clog publish <id>" to publish directly',
    );
    expect(stdout).toContain("bbbbbbb");
  });

  it("status warns about invalid excluded entries but still succeeds", async () => {
    await fs.mkdir(clogHome, { recursive: true });
    await fs.writeFile(path.join(clogHome, "excluded"), "not-valid\n", "utf8");
    await run(["config", "set", "sources.claude-code.enabled", "false"]);
    await run(["config", "set", "sources.codex-cli.enabled", "false"]);

    const { stdout, stderr } = await run(["status"]);

    expect(stdout).toContain("No conversations pending publication.");
    expect(stderr).toContain("warning: Invalid excluded-file entry at line 1.");
    expect(stderr).toContain('guidance=Expected "sourceId@source".');
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
    expect(summary.stdout).toContain('run "clog status --undiscoverable" for details');

    const detailed = await run(["status", "--undiscoverable"]);
    expect(detailed.stdout).toContain("Undiscoverable conversations:");
    expect(detailed.stdout).toContain("claude-code");
    expect(detailed.stdout).not.toContain('run "clog status --undiscoverable" for details');
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
    expect(summary.stdout).toContain("1 undiscoverable");
    expect(summary.stdout).toContain('run "clog status --undiscoverable" for details');
    expect(summary.stderr).not.toContain("project path missing");

    const detailed = await run(["status", "--undiscoverable"]);
    expect(detailed.stdout).toContain("1 undiscoverable");
    expect(detailed.stdout).toContain("Undiscoverable conversations:");
    expect(detailed.stdout).toContain("codex-cli");
    expect(detailed.stdout).not.toContain('run "clog status --undiscoverable" for details');
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

    const { stderr } = await run(["list"]);
    expect(stderr).toContain(
      "warning: Skipped 2 conversation(s): project path missing: these conversation files have no cwd metadata.",
    );
    expect(stderr).toContain('guidance=Run "clog status --undiscoverable" for details.');
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

    const { stdout } = await run(["list", "--state", "discovered"], {
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
