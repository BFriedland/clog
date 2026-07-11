import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { SCAN_METADATA_MAX_LINES } from "../src/adapters/adapter.js";
import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli.js";
import { getDefaultConfig } from "../src/config/index.js";
import type { ClogWarning } from "../src/models/warnings.js";
import { writeJsonl, writeRawJsonlLines } from "./helpers/fixtures.js";

describe("adapters", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-adapter-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("Claude discovery extracts metadata from the first cwd and summary line", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9a.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        slug: "breezy-coalescing-pony",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      },
      {
        type: "user",
        cwd: "/Users/alice/api-service/subdir",
        message: {
          role: "user",
          content: "Another prompt",
        },
      },
      {
        type: "summary",
        summary: "Walked through auth token refresh behavior.",
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata).toEqual({
      title: "Debug auth token refresh logic",
      summary: "Walked through auth token refresh behavior.",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: "breezy-coalescing-pony",
      createdAt: "2026-02-01T10:00:00.000Z",
    });
  });

  it("Claude discovery stops at the metadata line bound when summary and slug are absent", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9d.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      }),
      ...validJsonlPadding(SCAN_METADATA_MAX_LINES - 1),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata).toMatchObject({
      title: "Debug auth token refresh logic",
      summary: "",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
    });
  });

  it("Claude discovery warns and skips when malformed JSONL appears before metadata discovery stops", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9e.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["malformed_jsonl"]);
  });

  it("Claude discovery skips hidden local-command wrapper text when deriving titles", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9b.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          role: "user",
          content: "Debug auth token refresh logic",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Debug auth token refresh logic");
  });

  it("Claude discovery renders visible local-command wrappers into plain title text", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c7044ea5-c019-44d6-a77a-500036740f9c.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/copy</command-name>\n            <command-message>copy</command-message>\n            <command-args></command-args>",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("/copy");
  });

  it("Claude full parsing deduplicates assistant message ids and strips thinking", async () => {
    const filePath = path.join(tempDir, "claude-parse.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Read the config file" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "I will inspect it." }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "thinking", thinking: "internal" }],
        },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "tool_use", id: "tool_1", name: "Read", input: { file_path: "src/config.ts" } }],
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool_1", content: "..." }],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toEqual([
      {
        role: "user",
        content: "Read the config file",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "assistant",
        content: "I will inspect it.",
        timestamp: "2026-02-01T10:00:01.000Z",
      },
      {
        role: "tool_use",
        content: 'Read: {"file_path":"src/config.ts"}',
        timestamp: "2026-02-01T10:00:01.000Z",
        toolName: "Read",
        toolInput: { file_path: "src/config.ts" },
      },
      {
        role: "tool_result",
        content: "Read: ok",
        timestamp: "2026-02-01T10:00:02.000Z",
        toolName: "Read",
      },
    ]);
  });

  it("Claude parsing strips hidden local-command wrapper text from canonical user messages", async () => {
    const filePath = path.join(tempDir, "claude-strip-wrappers.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>\n\nPlease explain the auth flow.",
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toEqual([
      {
        role: "user",
        content: "Please explain the auth flow.",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
    ]);
  });

  it("Claude parsing renders visible local-command wrappers as plain user text", async () => {
    const filePath = path.join(tempDir, "claude-local-command.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-caveat>\nHidden model-only wrapper\n</local-command-caveat>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<command-name>/copy</command-name>\n            <command-message>copy</command-message>\n            <command-args></command-args>",
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content:
            "<local-command-stdout>Copied to clipboard (2983 characters, 35 lines)\nAlso written to /tmp/claude/response.md</local-command-stdout>",
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toEqual([
      {
        role: "user",
        content: "/copy",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "user",
        content: "Copied to clipboard (2983 characters, 35 lines)\nAlso written to /tmp/claude/response.md",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
    ]);
  });

  it("Codex discovery normalizes a codex home path and prefers user_message title text", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-550e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        payload: {
          cwd: "/Users/alice/api-service",
        },
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [
            { type: "input_text", text: "<environment_context>wrapped</environment_context>" },
          ],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Debug the auth race condition",
        },
      },
      {
        type: "session_meta",
        payload: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(adapter.discover({ onWarning: (warning) => warnings.push(warning) }));

    expect(warnings).toEqual([]);
    expect(discovered[0]?.sourceId).toBe("550e8400-e29b-41d4-a716-446655440000");
    expect(discovered[0]?.metadata).toEqual({
      title: "Debug the auth race condition",
      summary: "",
      projectName: "api-service",
      projectPath: "/Users/alice/api-service",
      slug: null,
      createdAt: "2026-02-01T09:59:59.000Z",
    });
  });

  it("Codex discovery ignores malformed JSONL after metadata is complete", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-750e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "session_meta",
        payload: {
          id: "750e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      }),
      jsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Debug the auth race condition",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Debug the auth race condition");
  });

  it("Codex discovery finalizes fallback metadata at the line bound and ignores later malformed JSONL", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const id = "850e8400-e29b-41d4-a716-446655440000";
    const filePath = path.join(
      sessionsDir,
      `rollout-2026-02-01T10-00-00-${id}.jsonl`,
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          cwd: "/Users/alice/api-service",
        },
      }),
      jsonLine({
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Summarize the deployment plan",
        },
      }),
      ...validJsonlPadding(SCAN_METADATA_MAX_LINES - 2),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe(id);
    expect(discovered[0]?.metadata.projectPath).toBe("/Users/alice/api-service");
    expect(discovered[0]?.metadata.createdAt).toBe("2026-02-01T10:00:00.000Z");
    expect(discovered[0]?.metadata.title).toBe("Summarize the deployment plan");
  });

  it("Codex discovery warns and skips when malformed JSONL appears before metadata is complete", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-950e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeRawJsonlLines(filePath, [
      jsonLine({
        type: "session_meta",
        payload: {
          id: "950e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
        },
      }),
      "{not: valid json",
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toEqual([]);
    expect(warnings.map((warning) => warning.code)).toEqual(["malformed_jsonl"]);
  });

  it("Codex discovery uses a nearby duplicate user_message as the title after ignored events", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-a50e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "a50e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Normalize\r\nthis title" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "agent_message",
          message: "Working...",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "user_message",
          message: "Normalize\nthis title",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Normalize\nthis title");
  });

  it("Codex discovery keeps the earliest canonical prompt when a later event message is unrelated", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-b50e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "b50e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "First prompt" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "user_message",
          message: "Second prompt",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("First prompt");
  });

  it("Codex discovery lets in-bound session_meta override filename, timestamp, and turn_context fallbacks", async () => {
    const filenameId = "c50e8400-e29b-41d4-a716-446655440000";
    const embeddedId = "d50e8400-e29b-41d4-a716-446655440000";
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      `rollout-2026-02-01T10-00-00-${filenameId}.jsonl`,
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          cwd: "/Users/alice/fallback-project",
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Use primary metadata",
        },
      },
      {
        type: "session_meta",
        payload: {
          id: embeddedId,
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/primary-project",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe(embeddedId);
    expect(discovered[0]?.metadata).toMatchObject({
      title: "Use primary metadata",
      projectName: "primary-project",
      projectPath: "/Users/alice/primary-project",
      createdAt: "2026-02-01T09:59:59.000Z",
    });
    expect(warnings).toMatchObject([
      {
        code: "source_id_mismatch",
        source: "codex-cli",
        path: filePath,
      },
    ]);
  });

  it("Codex parsing correlates tool calls and suppresses duplicate fallback user messages", async () => {
    const filePath = path.join(tempDir, "codex-parse.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Show me git status" }],
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "user_message",
          message: "Show me git status",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "function_call",
          call_id: "call_1",
          name: "exec_command",
          arguments: "{\"cmd\":\"git status\"}",
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "exec_command_end",
          call_id: "call_1",
          exit_code: 0,
          formatted_output: "On branch main",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_1",
          output: "Command completed.\nOutput:\nOn branch main",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:04.000Z",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "The repo is clean." }],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toEqual([
      {
        role: "user",
        content: "Show me git status",
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        role: "tool_use",
        content: 'exec_command: {"cmd":"git status"}',
        timestamp: "2026-02-01T10:00:01.000Z",
        toolName: "exec_command",
        toolInput: { cmd: "git status" },
      },
      {
        role: "tool_result",
        content: "exec_command: output",
        timestamp: "2026-02-01T10:00:03.000Z",
        toolName: "exec_command",
      },
      {
        role: "assistant",
        content: "The repo is clean.",
        timestamp: "2026-02-01T10:00:04.000Z",
      },
    ]);
  });

  it("Codex parsing strips leading AGENTS and environment wrapper text from canonical user messages", async () => {
    const filePath = path.join(tempDir, "codex-strip-wrappers.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-03-28T15:36:57.521Z",
        payload: {
          type: "message",
          role: "user",
          content: [
            {
              type: "input_text",
              text:
                "# AGENTS.md instructions for /Users/alice/project\n\n<INSTRUCTIONS>\nAgent-only setup\n</INSTRUCTIONS>\n\n<environment_context>\n  <cwd>/Users/alice/project</cwd>\n</environment_context>\n\nPlease explain how go imports work.",
            },
          ],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toEqual([
      {
        role: "user",
        content: "Please explain how go imports work.",
        timestamp: "2026-03-28T15:36:57.521Z",
      },
    ]);
  });

  // ============================================================
  // Additional Claude discovery edge cases (SPEC §4.2.6)
  // ============================================================

  it("Claude discovery stores a clean 100-character title for a very long first user message", async () => {
    const longBody = "A".repeat(250);
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c8000000-0000-0000-0000-000000000001.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: { role: "user", content: longBody },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    const title = discovered[0]?.metadata.title ?? "";
    expect(title).toBe("A".repeat(100));
    expect(title.length).toBe(100);
    expect(title).not.toContain("...");
  });

  it("Codex discovery stores a clean 100-character title for a very long user message", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-650e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        payload: {
          cwd: "/Users/alice/api-service",
        },
        timestamp: "2026-02-01T10:00:00.000Z",
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "B".repeat(250),
        },
      },
      {
        type: "session_meta",
        payload: {
          id: "650e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
          cwd: "/Users/alice/api-service",
        },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];
    const adapter = new CodexCliAdapter(config);

    const discovered = await collect(adapter.discover());
    const title = discovered[0]?.metadata.title ?? "";
    expect(title).toBe("B".repeat(100));
    expect(title.length).toBe(100);
    expect(title).not.toContain("...");
  });

  it("Claude discovery skips a leading file-history-snapshot line and still derives a title", async () => {
    const filePath = path.join(
      tempDir,
      "claude",
      "-Users-alice-api-service",
      "c8000000-0000-0000-0000-000000000002.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "file-history-snapshot",
        messageId: "fhs-1",
        snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:00.000Z" },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/api-service",
        message: { role: "user", content: "Investigate the flaky test" },
      },
    ]);

    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [path.join(tempDir, "claude")];
    const adapter = new ClaudeCodeAdapter(config);

    const discovered = await collect(adapter.discover());
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.metadata.title).toBe("Investigate the flaky test");
    expect(discovered[0]?.metadata.projectPath).toBe("/Users/alice/api-service");
  });

  // ============================================================
  // Additional Claude parsing edge cases (SPEC §4.2.7)
  // ============================================================

  it("Claude parsing renders a tool_result with is_error=true as 'ToolName: error'", async () => {
    const filePath = path.join(tempDir, "claude-tool-error.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Try to run the build" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [
            { type: "tool_use", id: "tool_err", name: "Bash", input: { command: "npm run build" } },
          ],
        },
      },
      {
        type: "user",
        timestamp: "2026-02-01T10:00:02.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "tool_err",
              content: "TypeError: Cannot read property 'x' of undefined",
              is_error: true,
            },
          ],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    const toolResult = messages.find((message) => message.role === "tool_result");
    expect(toolResult).toBeDefined();
    expect(toolResult?.content).toBe("Bash: error");
    expect(toolResult?.toolName).toBe("Bash");
  });

  it("Claude parsing falls back to 'tool: ok' when a tool_result references an unknown tool_use_id", async () => {
    const filePath = path.join(tempDir, "claude-orphan-tool-result.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "never-seen-this-tool",
              content: "Some output",
            },
          ],
        },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({
      role: "tool_result",
      content: "tool: ok",
      toolName: "tool",
    });
  });

  it("Claude parsing returns an empty message list when only file-history-snapshot lines are present", async () => {
    const filePath = path.join(tempDir, "claude-empty.jsonl");

    await writeJsonl(filePath, [
      {
        type: "file-history-snapshot",
        messageId: "fhs-1",
        snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:00.000Z" },
      },
      {
        type: "file-history-snapshot",
        messageId: "fhs-2",
        snapshot: { messageId: "fhs-2", trackedFileBackups: {}, timestamp: "2026-02-01T10:00:01.000Z" },
      },
    ]);

    const adapter = new ClaudeCodeAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);
    expect(messages).toEqual([]);
  });

  // ============================================================
  // Additional Codex discovery edge cases (SPEC §4.3.2)
  // ============================================================

  it("Codex discovery uses the filename-derived source id when session_meta is missing", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-123e4567-e89b-12d3-a456-426614174000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "turn_context",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: { cwd: "/Users/alice/api-service" },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: { type: "user_message", message: "Check the logs" },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(warnings).toEqual([]);
    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe("123e4567-e89b-12d3-a456-426614174000");
    expect(discovered[0]?.metadata.title).toBe("Check the logs");
  });

  it("Codex discovery skips non-rollout JSONL files under the sessions directory", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");

    // Valid rollout.
    await writeJsonl(
      path.join(sessionsDir, "rollout-2026-02-01T10-00-00-22222222-2222-2222-2222-222222222222.jsonl"),
      [
        {
          type: "session_meta",
          payload: {
            id: "22222222-2222-2222-2222-222222222222",
            timestamp: "2026-02-01T10:00:00.000Z",
            cwd: "/Users/alice/api-service",
          },
        },
        {
          type: "event_msg",
          payload: { type: "user_message", message: "Real conversation" },
        },
      ],
    );

    // Non-rollout JSONL under the same directory (log-like file).
    await writeJsonl(path.join(sessionsDir, "debug-trace.jsonl"), [
      { type: "debug", message: "internal" },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(
      adapter.discover({ onWarning: (warning) => warnings.push(warning) }),
    );

    expect(discovered).toHaveLength(1);
    expect(discovered[0]?.sourceId).toBe("22222222-2222-2222-2222-222222222222");
    // No malformed warning for the non-rollout file.
    expect(warnings.filter((warning) => warning.code === "malformed_jsonl")).toEqual([]);
  });

  // ============================================================
  // Additional Codex parsing edge cases (SPEC §4.3.4)
  // ============================================================

  it("Codex parsing renders a failed exec_command as '<tool>: exit N'", async () => {
    const filePath = path.join(tempDir, "codex-exec-exit.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "function_call",
          call_id: "call_fail",
          name: "exec_command",
          arguments: '{"cmd":"npm run build"}',
        },
      },
      {
        type: "event_msg",
        timestamp: "2026-02-01T10:00:02.000Z",
        payload: {
          type: "exec_command_end",
          call_id: "call_fail",
          exit_code: 2,
          formatted_output: "error: build failed",
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:03.000Z",
        payload: {
          type: "function_call_output",
          call_id: "call_fail",
          output: "Command failed.",
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    const toolResult = messages.find((message) => message.role === "tool_result");
    expect(toolResult?.content).toBe("exec_command: exit 2");
    expect(toolResult?.toolName).toBe("exec_command");
  });

  it("Codex parsing drops response_item.message records with role='developer' (SPEC §4.3.3)", async () => {
    const filePath = path.join(tempDir, "codex-developer-drop.jsonl");

    await writeJsonl(filePath, [
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:00.000Z",
        payload: {
          type: "message",
          role: "developer",
          content: [{ type: "input_text", text: "Agent-only configuration block" }],
        },
      },
      {
        type: "response_item",
        timestamp: "2026-02-01T10:00:01.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Please help" }],
        },
      },
    ]);

    const adapter = new CodexCliAdapter(getDefaultConfig("alice"));
    const messages = await adapter.parseMessages(filePath);

    expect(messages).toHaveLength(1);
    expect(messages[0]).toMatchObject({ role: "user", content: "Please help" });
  });

  it("Codex discovery yields metadata with null project path when cwd is missing", async () => {
    const sessionsDir = path.join(tempDir, ".codex", "sessions", "2026", "02", "01");
    const filePath = path.join(
      sessionsDir,
      "rollout-2026-02-01T10-00-00-550e8400-e29b-41d4-a716-446655440000.jsonl",
    );

    await writeJsonl(filePath, [
      {
        type: "session_meta",
        payload: {
          id: "550e8400-e29b-41d4-a716-446655440000",
          timestamp: "2026-02-01T09:59:59.000Z",
        },
      },
    ]);

    const warnings: ClogWarning[] = [];
    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].paths = [path.join(tempDir, ".codex")];

    const adapter = new CodexCliAdapter(config);
    const discovered = await collect(adapter.discover({ onWarning: (warning) => warnings.push(warning) }));

    expect(discovered).toHaveLength(1);
    expect(discovered[0]).toMatchObject({
      sourceId: "550e8400-e29b-41d4-a716-446655440000",
      metadata: {
        projectName: null,
        projectPath: null,
      },
    });
    expect(warnings).toEqual([]);
  });
});

function jsonLine(value: unknown): string {
  return JSON.stringify(value);
}

function validJsonlPadding(count: number): string[] {
  return Array.from({ length: count }, (_entry, index) =>
    jsonLine({ type: "progress", message: `padding ${index}` }),
  );
}

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}
