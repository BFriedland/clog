import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildAddCommand } from "../src/cli/add.js";
import { buildEditCommand } from "../src/cli/edit.js";
import { buildExcludeCommand } from "../src/cli/exclude.js";
import { buildPublishCommand } from "../src/cli/publish.js";
import { buildResetCommand } from "../src/cli/reset.js";
import { buildStatusCommand } from "../src/cli/status.js";
import { buildTagCommand } from "../src/cli/tag.js";
import { buildUnexcludeCommand } from "../src/cli/unexclude.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import { getConversationById, insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { getExcludedPath, getRawConversationPath } from "../src/utils/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";

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

  it("progresses through add → edit → tag → publish (SPEC §5.2)", async () => {
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

    await runBuiltCommand(buildPublishCommand, [convId]);
    conv = await getConversationById(convId);
    expect(conv?.state).toBe("published");
    expect(conv?.publishVersion).toBe(1);
    expect(conv?.publishedAt).toBeTruthy();
    // The fixture has 1 user + 1 assistant message.
    expect(conv?.publishedMessageCount).toBe(2);
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

  it("reset clears active publish fields and deletes the raw copy (SPEC §5.2.1)", async () => {
    const convId = "cccccccc-3333-4444-5555-666666666666";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Reset me");

    // Seed a staged conversation that had previously been published and then unpublished —
    // publishedAt/publishedMessageCount/publishVersion remain as the last-publish checkpoint.
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
        publishedAt: "2026-02-01T12:00:00.000Z",
        publishedMessageCount: 2,
        publishVersion: 1,
      }),
    );

    await runBuiltCommand(buildResetCommand, [convId]);

    const conv = await getConversationById(convId);
    expect(conv?.state).toBe("discovered");
    expect(conv?.filePath).toBeNull();
    expect(conv?.publishedAt).toBeNull();
    expect(conv?.publishedMessageCount).toBeNull();
    expect(conv?.publishVersion).toBe(0);
    await expect(fs.access(rawPath)).rejects.toThrow();
  });

  it("reset refuses a published conversation (SPEC §5.2.1)", async () => {
    const convId = "dddddddd-4444-5555-6666-777777777777";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Cannot reset published");

    const rawPath = getRawConversationPath("claude-code", convId);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.copyFile(sourcePath, rawPath);

    await insertConversation(
      makeDiscoveredConversation({
        id: convId,
        sourceId: convId,
        sourcePath,
        state: "published",
        filePath: rawPath,
        publishedAt: "2026-02-01T12:00:00.000Z",
        publishedMessageCount: 2,
        publishVersion: 1,
      }),
    );

    await expect(runBuiltCommand(buildResetCommand, [convId])).rejects.toThrow(/unpublish/i);

    // State must be preserved after the failed reset.
    const conv = await getConversationById(convId);
    expect(conv?.state).toBe("published");
  });

  it("publish increments publishVersion on republish (SPEC §5.6)", async () => {
    const convId = "eeeeeeee-5555-6666-7777-888888888888";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "v1");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    let conv = await getConversationById(convId);
    expect(conv?.publishVersion).toBe(1);

    await runBuiltCommand(buildEditCommand, [convId, "--title", "v2 title"]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    conv = await getConversationById(convId);
    expect(conv?.publishVersion).toBe(2);
    expect(conv?.title).toBe("v2 title");
  });

  it("add refreshes a published raw copy while preserving state=published (SPEC §5.5)", async () => {
    const convId = "11111111-2222-3333-4444-555555555555";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    const published = await getConversationById(convId);
    expect(published?.state).toBe("published");
    const firstPublishedAt = published?.publishedAt;
    const firstPublishVersion = published?.publishVersion;
    const firstPublishedMessageCount = published?.publishedMessageCount;
    expect(firstPublishedAt).toBeTruthy();
    expect(firstPublishVersion).toBe(1);

    // Grow the source: adds a second user+assistant turn.
    await writeJsonl(sourcePath, [
      userMessageLine("Initial prompt"),
      assistantTextLine("Let me look", "msg_01"),
      userMessageLine("Follow-up", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Here you go", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    await runBuiltCommand(buildAddCommand, [convId]);

    const refreshed = await getConversationById(convId);
    expect(refreshed?.state).toBe("published");
    // Publish fields are preserved until the next publish.
    expect(refreshed?.publishedAt).toBe(firstPublishedAt);
    expect(refreshed?.publishVersion).toBe(firstPublishVersion);
    expect(refreshed?.publishedMessageCount).toBe(firstPublishedMessageCount);
    // modifiedAt advanced because content changed.
    expect(refreshed?.modifiedAt).not.toBe(published?.modifiedAt);

    // The raw copy is now byte-identical to the updated source.
    const rawContent = await fs.readFile(refreshed!.filePath!, "utf8");
    const sourceContent = await fs.readFile(sourcePath, "utf8");
    expect(rawContent).toBe(sourceContent);
  });

  it("bare publish republishes a ready published conversation after clog add (SPEC §5.4)", async () => {
    const convId = "77777777-8888-9999-aaaa-bbbbbbbbbbbb";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    const firstPublish = await getConversationById(convId);
    const firstPublishedAt = firstPublish?.publishedAt;
    expect(firstPublish?.publishVersion).toBe(1);
    expect(firstPublish?.publishedMessageCount).toBe(2);

    await writeJsonl(sourcePath, [
      userMessageLine("Initial prompt"),
      assistantTextLine("Let me look", "msg_01"),
      userMessageLine("Follow-up", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Here you go", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, []);

    const republished = await getConversationById(convId);
    expect(republished?.state).toBe("published");
    expect(republished?.publishVersion).toBe(2);
    expect(republished?.publishedMessageCount).toBe(4);
    expect(republished?.publishedAt).not.toBe(firstPublishedAt);
  });

  it("status and bare publish agree on metadata-only republish readiness", async () => {
    const convId = "abababab-1234-5678-9abc-def012345678";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial prompt");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    const firstPublish = await getConversationById(convId);
    const firstPublishedAt = firstPublish?.publishedAt;
    expect(firstPublish?.publishVersion).toBe(1);

    await runBuiltCommand(buildEditCommand, [convId, "--title", "Metadata-only republish"]);

    const status = await runBuiltCommand(buildStatusCommand, []);
    expect(status.stdout).toContain("Conversations to be published:");
    expect(status.stdout).toContain("Metadata-only republish");
    expect(status.stdout).toContain("modified:");

    await runBuiltCommand(buildPublishCommand, []);

    const republished = await getConversationById(convId);
    expect(republished?.state).toBe("published");
    expect(republished?.title).toBe("Metadata-only republish");
    expect(republished?.publishVersion).toBe(2);
    expect(republished?.publishedAt).not.toBe(firstPublishedAt);
    expect(republished?.modifiedAt).toBe(republished?.publishedAt);
  });

  it("add on an unchanged published raw copy is a content no-op (SPEC §5.5)", async () => {
    const convId = "22222222-3333-4444-5555-666666666666";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Unchanged");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    const published = await getConversationById(convId);
    expect(published?.state).toBe("published");
    const frozen = {
      publishedAt: published?.publishedAt,
      publishVersion: published?.publishVersion,
      publishedMessageCount: published?.publishedMessageCount,
      modifiedAt: published?.modifiedAt,
    };

    // Run add again without changing the source.
    await runBuiltCommand(buildAddCommand, [convId]);

    const after = await getConversationById(convId);
    expect(after?.state).toBe("published");
    expect(after?.publishedAt).toBe(frozen.publishedAt);
    expect(after?.publishVersion).toBe(frozen.publishVersion);
    expect(after?.publishedMessageCount).toBe(frozen.publishedMessageCount);
    // Content unchanged → modifiedAt NOT advanced.
    expect(after?.modifiedAt).toBe(frozen.modifiedAt);
  });

  it("explicit publish <id> pushthrough on a modified published source (SPEC §5.6)", async () => {
    const convId = "33333333-4444-5555-6666-777777777777";
    const sourcePath = claudeDiscoveredSourcePath(sourceDir, "webapp", convId);
    await writeClaudeJsonl(sourcePath, "Initial");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildAddCommand, [convId]);
    await runBuiltCommand(buildPublishCommand, [convId]);

    const firstPublish = await getConversationById(convId);
    expect(firstPublish?.publishedMessageCount).toBe(2);

    // Grow the source after publish.
    await writeJsonl(sourcePath, [
      userMessageLine("Initial"),
      assistantTextLine("Step one", "msg_01"),
      userMessageLine("Continue", "2026-02-01T10:05:00.000Z"),
      assistantTextLine("Step two", "msg_02", "2026-02-01T10:05:01.000Z"),
    ]);

    // Publish directly (no separate add).
    await runBuiltCommand(buildPublishCommand, [convId]);

    const republished = await getConversationById(convId);
    expect(republished?.publishVersion).toBe(2);
    expect(republished?.publishedMessageCount).toBe(4);
    expect(republished?.publishedAt).not.toBe(firstPublish?.publishedAt);
  });

  it("exclude → unexclude round-trip updates the excluded file", async () => {
    const convId = "44444444-5555-6666-7777-888888888888";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Exclude me");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    await runBuiltCommand(buildExcludeCommand, [convId]);

    const afterExclude = await getConversationById(convId);
    expect(afterExclude).toBeNull();

    const excludedContent = await fs.readFile(getExcludedPath(), "utf8");
    expect(excludedContent).toContain(`${convId}@claude-code`);

    await runBuiltCommand(buildUnexcludeCommand, [`${convId}@claude-code`]);

    const afterUnexclude = await fs.readFile(getExcludedPath(), "utf8");
    expect(afterUnexclude).not.toContain(convId);
  });

  it("exclude fails when the excluded file has invalid lines (SPEC §5.10)", async () => {
    const convId = "55555555-6666-7777-8888-999999999999";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Exclude fails on invalid");

    await insertConversation(makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }));

    // Write an invalid line into the excluded file.
    await fs.writeFile(getExcludedPath(), "not-a-valid-entry\n", "utf8");

    await expect(runBuiltCommand(buildExcludeCommand, [convId])).rejects.toThrow(
      /Excluded file is invalid/,
    );

    // The conversation is NOT removed when the mutation fails.
    const still = await getConversationById(convId);
    expect(still).not.toBeNull();
  });

  it("unexclude reports ambiguity with copy-pasteable candidates (SPEC §5.10)", async () => {
    // Two excluded entries that share a prefix.
    const excludedContent = [
      "abcd1111-1111-1111-1111-111111111111@claude-code",
      "abcd2222-2222-2222-2222-222222222222@claude-code",
    ].join("\n");
    await fs.writeFile(getExcludedPath(), `${excludedContent}\n`, "utf8");

    await expect(runBuiltCommand(buildUnexcludeCommand, ["abcd"])).rejects.toThrow(
      /ambiguous/i,
    );
  });

  it("exclude rejects a file that contains duplicate entries (SPEC §5.10)", async () => {
    // Mutation commands (exclude/unexclude) fail without changing the file when any
    // invalid or duplicate line is present. Blanks and comments are still tolerated.
    const existing = [
      "# existing exclusions",
      "",
      "abcd1111-1111-1111-1111-111111111111@claude-code",
      "abcd1111-1111-1111-1111-111111111111@claude-code",
    ].join("\n");
    await fs.writeFile(getExcludedPath(), `${existing}\n`, "utf8");

    const convId = "66666666-7777-8888-9999-aaaaaaaaaaaa";
    const sourcePath = path.join(sourceDir, `${convId}.jsonl`);
    await writeClaudeJsonl(sourcePath, "Added to existing excluded file");
    await insertConversation(
      makeDiscoveredConversation({ id: convId, sourceId: convId, sourcePath }),
    );

    await expect(runBuiltCommand(buildExcludeCommand, [convId])).rejects.toThrow(
      /Excluded file is invalid/,
    );

    // The conversation is NOT removed when the mutation fails.
    const still = await getConversationById(convId);
    expect(still).not.toBeNull();
  });
});

async function runBuiltCommand(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      stdoutChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof process.stdout.write);

  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      stderrChunks.push(typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"));
      return true;
    }) as typeof process.stderr.write);

  try {
    const cmd = builder();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: "user" });
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
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
    publishedAt: null,
    publishedMessageCount: null,
    publishVersion: 0,
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
