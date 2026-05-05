import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAddCommand } from "../src/cli/add.js";
import { buildEditCommand } from "../src/cli/edit.js";
import { buildExcludeCommand } from "../src/cli/exclude.js";
import { buildSaveCommand } from "../src/cli/save.js";
import { buildRemoveCommand } from "../src/cli/remove.js";
import { buildResetCommand } from "../src/cli/reset.js";
import { buildStatusCommand } from "../src/cli/status.js";
import { buildTagCommand } from "../src/cli/tag.js";
import { buildUnexcludeCommand } from "../src/cli/unexclude.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import { getConversationById, insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { getClogIgnorePath, getRawConversationPath } from "../src/utils/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutput } from "./helpers/output.js";

describe("workflow", () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-workflow-"));
    process.env.CLOG_HOME = tempDir;
    sourceDir = path.join(tempDir, "claude-sources");
    await fs.mkdir(sourceDir, { recursive: true });

    await ensureClogHome({ interactive: false });

    const config = getDefaultConfig("testuser");
    config.sources["claude-code"].paths = [sourceDir];
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
  });

  it("progresses through add → edit → tag → save (SPEC §5.2)", async () => {
    const convId = "aaaaaaaa-1111-2222-3333-444444444444";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Help me debug this");

    await insertConversation(makeDiscoveredConversation({ sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    let conv = await getConversationById(convId);
    expect(conv?.state).toBe("staged");
    expect(conv?.filePath).toBeTruthy();
    expect(conv?.filePath).toBe(getRawConversationPath("claude-code", convId));

    await runBuiltCommand(buildEditCommand, [convId, "--title", "Debug JWT refresh"]);
    conv = await getConversationById(convId);
    expect(conv?.title).toBe("Debug JWT refresh");

    await runBuiltCommand(buildTagCommand, [convId, "auth", "debugging"]);
    conv = await getConversationById(convId);
    expect(new Set(conv?.tags)).toEqual(new Set(["auth", "debugging"]));

    await runBuiltCommand(buildSaveCommand, [convId]);
    conv = await getConversationById(convId);
    expect(conv?.state).toBe("saved");
    expect(conv?.saveVersion).toBe(1);
    expect(conv?.savedAt).toBeTruthy();
    // The fixture has 1 user + 1 assistant message.
    expect(conv?.savedMessageCount).toBe(2);
  });

  it("add copies the source file into ~/.clog/raw/<source>/<id>.jsonl (SPEC §5.5)", async () => {
    const convId = "bbbbbbbb-2222-3333-4444-555555555555";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Copy me");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);

    const expectedRawPath = getRawConversationPath("claude-code", convId);
    await expect(fs.access(expectedRawPath)).resolves.toBeUndefined();

    const sourceContent = await fs.readFile(sourcePath, "utf8");
    const rawContent = await fs.readFile(expectedRawPath, "utf8");
    expect(rawContent).toBe(sourceContent);
  });

  it("reset clears active save fields and deletes the raw copy (SPEC §5.2.1)", async () => {
    const convId = "cccccccc-3333-4444-5555-666666666666";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Reset me");

    // Seed a staged conversation that had previously been saved and then unsaved —
    // savedAt/savedMessageCount/saveVersion remain as the last-save checkpoint.
    const rawPath = getRawConversationPath("claude-code", convId);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.copyFile(sourcePath, rawPath);

    await insertConversation(
      makeDiscoveredConversation({
        id: convId,
        sourceId: convId,
        sourcePath,
        state: "staged",
        filePath: rawPath,
        savedAt: "2026-02-01T12:00:00.000Z",
        savedMessageCount: 2,
        saveVersion: 1,
      }),
    );

    await runBuiltCommand(buildResetCommand, [convId]);

    const conv = await getConversationById(convId);
    expect(conv?.state).toBe("discovered");
    expect(conv?.filePath).toBeNull();
    expect(conv?.savedAt).toBeNull();
    expect(conv?.savedMessageCount).toBeNull();
    expect(conv?.saveVersion).toBe(0);
    await expect(fs.access(rawPath)).rejects.toThrow();
  });

  it("reset refuses a saved conversation (SPEC §5.2.1)", async () => {
    const convId = "dddddddd-4444-5555-6666-777777777777";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Cannot reset saved");

    const rawPath = getRawConversationPath("claude-code", convId);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.copyFile(sourcePath, rawPath);

    await insertConversation(
      makeDiscoveredConversation({
        id: convId,
        sourceId: convId,
        sourcePath,
        state: "saved",
        filePath: rawPath,
        savedAt: "2026-02-01T12:00:00.000Z",
        savedMessageCount: 2,
        saveVersion: 1,
      }),
    );

    await expect(runBuiltCommand(buildResetCommand, [convId])).rejects.toThrow(/unsave/i);

    // State must be preserved after the failed reset.
    const conv = await getConversationById(convId);
    expect(conv?.state).toBe("saved");
  });

  it("save increments saveVersion on resave (SPEC §5.6)", async () => {
    const convId = "eeeeeeee-5555-6666-7777-888888888888";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "v1");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    let conv = await getConversationById(convId);
    expect(conv?.saveVersion).toBe(1);

    await runBuiltCommand(buildEditCommand, [convId, "--title", "v2 title"]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    conv = await getConversationById(convId);
    expect(conv?.saveVersion).toBe(2);
    expect(conv?.title).toBe("v2 title");
  });

  it("add refreshes a saved raw copy while preserving state=saved (SPEC §5.5)", async () => {
    const convId = "11111111-2222-3333-4444-555555555555";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    const saved = await getConversationById(convId);
    expect(saved?.state).toBe("saved");
    const firstSavedAt = saved?.savedAt;
    const firstSaveVersion = saved?.saveVersion;
    const firstSavedMessageCount = saved?.savedMessageCount;
    expect(firstSavedAt).toBeTruthy();
    expect(firstSaveVersion).toBe(1);

    // Grow the source: adds a second user+assistant turn.
    await writeJsonl(sourcePath, [
      userMessageLine("Initial prompt"),
      assistantTextLine("Let me look", "msg_01"),
      userMessageLine("Follow-up", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Here you go", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    await runBuiltCommand(buildAddCommand, [convId]);

    const refreshed = await getConversationById(convId);
    expect(refreshed?.state).toBe("saved");
    // Save fields are preserved until the next save.
    expect(refreshed?.savedAt).toBe(firstSavedAt);
    expect(refreshed?.saveVersion).toBe(firstSaveVersion);
    expect(refreshed?.savedMessageCount).toBe(firstSavedMessageCount);
    // modifiedAt advanced because content changed.
    expect(refreshed?.modifiedAt).not.toBe(saved?.modifiedAt);

    // The raw copy is now byte-identical to the updated source.
    const rawContent = await fs.readFile(refreshed!.filePath!, "utf8");
    const sourceContent = await fs.readFile(sourcePath, "utf8");
    expect(rawContent).toBe(sourceContent);
  });

  it("bare save resaves a ready saved conversation after clog add (SPEC §5.4)", async () => {
    const convId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    const firstSave = await getConversationById(convId);
    const firstSavedAt = firstSave?.savedAt;
    expect(firstSave?.saveVersion).toBe(1);
    expect(firstSave?.savedMessageCount).toBe(2);

    await writeJsonl(sourcePath, [
      userMessageLine("Initial prompt"),
      assistantTextLine("Let me look", "msg_01"),
      userMessageLine("Follow-up", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Here you go", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, []);

    const resaved = await getConversationById(convId);
    expect(resaved?.state).toBe("saved");
    expect(resaved?.saveVersion).toBe(2);
    expect(resaved?.savedMessageCount).toBe(4);
    expect(resaved?.savedAt).not.toBe(firstSavedAt);
  });

  it("status and bare save agree on metadata-only resave readiness", async () => {
    const convId = "abababab-1234-5678-9abc-def012345678";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    const firstSave = await getConversationById(convId);
    const firstSavedAt = firstSave?.savedAt;
    expect(firstSave?.saveVersion).toBe(1);

    await runBuiltCommand(buildEditCommand, [convId, "--title", "Metadata-only resave"]);

    const status = await runBuiltCommand(buildStatusCommand, []);
    expect(status.stdout).toContain("Conversations to be saved:");
    expect(status.stdout).toContain("webapp");
    expect(status.stdout).toContain("1 modified");

    await runBuiltCommand(buildSaveCommand, []);

    const resaved = await getConversationById(convId);
    expect(resaved?.state).toBe("saved");
    expect(resaved?.title).toBe("Metadata-only resave");
    expect(resaved?.saveVersion).toBe(2);
    expect(resaved?.savedAt).not.toBe(firstSavedAt);
    expect(resaved?.modifiedAt).toBe(resaved?.savedAt);
  });

  it("add on an unchanged saved raw copy is a content no-op (SPEC §5.5)", async () => {
    const convId = "22222222-3333-4444-5555-666666666666";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Unchanged");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    const saved = await getConversationById(convId);
    expect(saved?.state).toBe("saved");
    const frozen = {
      savedAt: saved?.savedAt,
      saveVersion: saved?.saveVersion,
      savedMessageCount: saved?.savedMessageCount,
      modifiedAt: saved?.modifiedAt,
    };

    // Run add again without changing the source.
    await runBuiltCommand(buildAddCommand, [convId]);

    const after = await getConversationById(convId);
    expect(after?.state).toBe("saved");
    expect(after?.savedAt).toBe(frozen.savedAt);
    expect(after?.saveVersion).toBe(frozen.saveVersion);
    expect(after?.savedMessageCount).toBe(frozen.savedMessageCount);
    // Content unchanged → modifiedAt NOT advanced.
    expect(after?.modifiedAt).toBe(frozen.modifiedAt);
  });

  it("explicit save <id> pushthrough on a modified saved source (SPEC §5.6)", async () => {
    const convId = "33333333-4444-5555-6666-777777777777";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildSaveCommand, [convId]);

    const firstSave = await getConversationById(convId);
    expect(firstSave?.savedMessageCount).toBe(2);

    // Grow the source after save.
    await writeJsonl(sourcePath, [
      userMessageLine("Initial"),
      assistantTextLine("Step one", "msg_01"),
      userMessageLine("Continue", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Step two", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    // Save directly (no separate add).
    await runBuiltCommand(buildSaveCommand, [convId]);

    const resaved = await getConversationById(convId);
    expect(resaved?.saveVersion).toBe(2);
    expect(resaved?.savedMessageCount).toBe(4);
    expect(resaved?.savedAt).not.toBe(firstSave?.savedAt);
  });

  it("exclude → unexclude round-trip updates clogignore without removing current DB rows", async () => {
    const convId = "44444444-5555-6666-7777-888888888888";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Exclude me");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildExcludeCommand, [convId]);

    const afterExclude = await getConversationById(convId);
    expect(afterExclude).not.toBeNull();

    const clogIgnoreContent = await fs.readFile(getClogIgnorePath(), "utf8");
    expect(clogIgnoreContent).toContain(convId);

    await runBuiltCommand(buildUnexcludeCommand, [convId]);

    const afterUnexclude = await fs.readFile(getClogIgnorePath(), "utf8");
    expect(afterUnexclude).not.toContain(convId);
  });

  it("exclude suggests rerunning remove with the same literal rule text", async () => {
    const convId = "44444444-5555-6666-7777-999999999999";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Exclude guidance");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    const { stdout } = await runBuiltCommand(buildExcludeCommand, [convId]);

    expect(stdout).toContain("currently in clog's database match this rule");
    expect(stdout).toContain(`Use 'clog remove ${convId}'`);
  });

  it("exclude rejects project selector syntax", async () => {
    const convId = "55555555-6666-7777-8888-999999999999";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Exclude rejects project selector");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await expect(runBuiltCommand(buildExcludeCommand, ["project:myapp"])).rejects.toThrow(
      /does not accept project selectors/i,
    );
  });

  it("exclude rejects unsupported date-rule syntax", async () => {
    await expect(runBuiltCommand(buildExcludeCommand, ["before:2025-06-01"])).rejects.toThrow(
      /does not accept unsupported ignore-rule syntax/i,
    );
  });

  it("remove rejects blank rules", async () => {
    await expect(runBuiltCommand(buildRemoveCommand, [""])).rejects.toThrow(
      /Ignore rules cannot be blank\./,
    );
  });

  it("remove rejects unsupported date-rule syntax", async () => {
    await expect(runBuiltCommand(buildRemoveCommand, ["after:2025-06-01"])).rejects.toThrow(
      /does not accept unsupported ignore-rule syntax/i,
    );
  });

  it("unexclude removes all exact matching lines", async () => {
    const clogIgnoreContent = ["myapp", "other", "myapp"].join("\n");
    await fs.writeFile(getClogIgnorePath(), `${clogIgnoreContent}\n`, "utf8");

    await runBuiltCommand(buildUnexcludeCommand, ["myapp"]);

    await expect(fs.readFile(getClogIgnorePath(), "utf8")).resolves.toBe("other\n");
  });

  it("unexclude leaves clogignore absent when no exact rule matches", async () => {
    await fs.rm(getClogIgnorePath(), { force: true });

    await runBuiltCommand(buildUnexcludeCommand, ["myapp"]);

    await expect(fs.readFile(getClogIgnorePath(), "utf8")).rejects.toMatchObject({
      code: "ENOENT",
    });
  });

  it("remove deletes current DB rows without editing clogignore", async () => {
    const convId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Remove current match");
    await insertConversation(
      makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }),
    );
    await fs.writeFile(getClogIgnorePath(), "myapp\n", "utf8");

    await runBuiltCommand(buildRemoveCommand, [convId]);

    await expect(getConversationById(convId)).resolves.toBeNull();
    await expect(fs.readFile(getClogIgnorePath(), "utf8")).resolves.toBe("myapp\n");
  });
});

async function runBuiltCommand(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  return captureOutput(async () => {
    const cmd = builder();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: "user" });
  });
}

function makeDiscoveredConversation(
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  const id = overrides.id ?? "aaaaaaaa-1111-2222-3333-444444444444";
  const now = "2026-02-01T10:00:00.000Z";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Hello world",
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
    origin: null,
    ...overrides,
  };
}

async function writeClaudeJsonl(filePath: string, userMessage: string): Promise<void> {
  await writeJsonl(filePath, [
    userMessageLine(userMessage, "2026-02-01T10:00:00.000Z", deriveClaudeCwd(filePath)),
    assistantTextLine("I can help with that", "msg_01"),
  ]);
}

function userMessageLine(
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

function assistantTextLine(
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
