import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ClaudeCodeAdapter } from "../src/adapters/claude-code.js";
import { CodexCliAdapter } from "../src/adapters/codex-cli.js";
import { getDefaultConfig } from "../src/config/index.js";
import type { ClogWarning } from "../src/models/warnings.js";
import { writeJsonl } from "./helpers/fixtures.js";

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

  it("Codex discovery fails closed when project path is missing", async () => {
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

    expect(discovered).toEqual([]);
    expect(warnings.some((warning) => warning.code === "path_filter_without_project")).toBe(true);
  });
});

async function collect<T>(iterable: AsyncIterable<T>): Promise<T[]> {
  const values: T[] = [];

  for await (const value of iterable) {
    values.push(value);
  }

  return values;
}
