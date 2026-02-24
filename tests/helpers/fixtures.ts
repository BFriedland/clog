import path from "node:path";
import { fileURLToPath } from "node:url";
import { cp, mkdir, writeFile } from "node:fs/promises";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export function fixturesDir(): string {
  return path.join(__dirname, "..", "fixtures", "claude-code");
}

export async function copyFixturesToSources(destDir: string): Promise<void> {
  await cp(fixturesDir(), destDir, { recursive: true });
}

export interface MinimalJsonlOptions {
  sessionId: string;
  userMessage?: string;
  hasThinking?: boolean;
  hasSummary?: boolean;
  hasToolUse?: boolean;
  slug?: string;
  timestamp?: string;
  emptyFile?: boolean;
  fileHistoryOnly?: boolean;
  duplicateAssistantId?: boolean;
}

export function createMinimalJsonl(opts: MinimalJsonlOptions): string {
  const {
    sessionId,
    userMessage = "Hello, help me debug this",
    hasThinking = false,
    hasSummary = false,
    hasToolUse = false,
    slug,
    timestamp = "2026-02-10T10:00:00.000Z",
    emptyFile = false,
    fileHistoryOnly = false,
    duplicateAssistantId = false,
  } = opts;

  if (emptyFile) return "";

  const lines: string[] = [];

  if (fileHistoryOnly) {
    lines.push(
      JSON.stringify({
        type: "file-history-snapshot",
        messageId: "fhs-1",
        snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp },
      })
    );
    return lines.join("\n") + "\n";
  }

  // file-history-snapshot line (should be filtered)
  lines.push(
    JSON.stringify({
      type: "file-history-snapshot",
      messageId: "fhs-1",
      snapshot: { messageId: "fhs-1", trackedFileBackups: {}, timestamp },
    })
  );

  // User message
  lines.push(
    JSON.stringify({
      type: "user",
      message: { role: "user", content: userMessage },
      uuid: "user-1",
      timestamp,
      sessionId,
      ...(slug ? { slug } : {}),
    })
  );

  // Assistant message with possible thinking
  const assistantMsgId = "msg_01TestAssistant";
  const assistantTimestamp = new Date(
    new Date(timestamp).getTime() + 1000
  ).toISOString();

  if (hasThinking) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: assistantMsgId,
          type: "message",
          role: "assistant",
          content: [{ type: "thinking", thinking: "Let me think about this" }],
          stop_reason: null,
        },
        timestamp: assistantTimestamp,
        sessionId,
      })
    );
  }

  if (hasToolUse) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: assistantMsgId,
          type: "message",
          role: "assistant",
          content: [
            {
              type: "tool_use",
              id: "toolu_01TestTool",
              name: "Read",
              input: { file_path: "/tmp/test.ts" },
            },
          ],
          stop_reason: "tool_use",
        },
        timestamp: assistantTimestamp,
        sessionId,
      })
    );

    // Progress line (should be filtered)
    lines.push(
      JSON.stringify({
        type: "progress",
        data: { type: "tool_start" },
        timestamp: assistantTimestamp,
      })
    );

    // Tool result
    lines.push(
      JSON.stringify({
        type: "user",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "toolu_01TestTool",
              content: "file contents here",
            },
          ],
        },
        uuid: "user-2",
        timestamp: new Date(
          new Date(timestamp).getTime() + 2000
        ).toISOString(),
        sessionId,
      })
    );

    // Second assistant response after tool
    const assistantMsgId2 = "msg_01TestAssistant2";
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: assistantMsgId2,
          type: "message",
          role: "assistant",
          content: [
            { type: "text", text: "I've read the file. Here's what I found." },
          ],
          stop_reason: "end_turn",
        },
        timestamp: new Date(
          new Date(timestamp).getTime() + 3000
        ).toISOString(),
        sessionId,
      })
    );
  } else {
    // Simple text response
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: assistantMsgId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: "I can help you debug that." }],
          stop_reason: "end_turn",
        },
        timestamp: assistantTimestamp,
        sessionId,
      })
    );
  }

  // Duplicate assistant message (same message.id, additional content block)
  if (duplicateAssistantId) {
    lines.push(
      JSON.stringify({
        type: "assistant",
        message: {
          model: "claude-opus-4-6",
          id: assistantMsgId,
          type: "message",
          role: "assistant",
          content: [{ type: "text", text: " And here is more info." }],
          stop_reason: "end_turn",
        },
        timestamp: new Date(
          new Date(timestamp).getTime() + 500
        ).toISOString(),
        sessionId,
      })
    );
  }

  if (hasSummary) {
    lines.push(
      JSON.stringify({
        type: "summary",
        summary: "Debugging session for test project",
        leafUuid: "user-1",
      })
    );
  }

  return lines.join("\n") + "\n";
}

export async function createFixtureDir(baseDir: string): Promise<void> {
  // Project 1: -Users-testuser-projects-webapp
  const project1Dir = path.join(baseDir, "-Users-testuser-projects-webapp");
  await mkdir(project1Dir, { recursive: true });

  // Normal conversation
  const normalId = "aaaaaaaa-1111-2222-3333-444444444444";
  await writeFile(
    path.join(project1Dir, `${normalId}.jsonl`),
    createMinimalJsonl({
      sessionId: normalId,
      userMessage: "Help me fix the login page CSS",
      slug: "breezy-coalescing-pony",
      hasSummary: true,
    })
  );

  // Tool-heavy conversation
  const toolId = "bbbbbbbb-1111-2222-3333-444444444444";
  await writeFile(
    path.join(project1Dir, `${toolId}.jsonl`),
    createMinimalJsonl({
      sessionId: toolId,
      userMessage: "Read all the config files and summarize them",
      hasToolUse: true,
      hasThinking: true,
      duplicateAssistantId: true,
    })
  );

  // Subagent dir (these should not be discovered as main conversations)
  const subagentDir = path.join(project1Dir, `${normalId}`, "subagents");
  await mkdir(subagentDir, { recursive: true });
  await writeFile(
    path.join(subagentDir, "agent-aprompt_suggestion-abc123.jsonl"),
    createMinimalJsonl({
      sessionId: "prompt-sub-1",
      userMessage: "suggestion prompt",
    })
  );
  await writeFile(
    path.join(subagentDir, "agent-a1234ef.jsonl"),
    createMinimalJsonl({
      sessionId: "task-sub-1",
      userMessage: "Task agent working on something",
    })
  );

  // Project 2: -Users-testuser-projects-api
  const project2Dir = path.join(baseDir, "-Users-testuser-projects-api");
  await mkdir(project2Dir, { recursive: true });

  // Short conversation
  const shortId = "cccccccc-1111-2222-3333-444444444444";
  await writeFile(
    path.join(project2Dir, `${shortId}.jsonl`),
    createMinimalJsonl({
      sessionId: shortId,
      userMessage: "What does this API endpoint do?",
      timestamp: "2026-01-15T08:00:00.000Z",
    })
  );

  // Conversation with summary
  const summaryId = "dddddddd-1111-2222-3333-444444444444";
  await writeFile(
    path.join(project2Dir, `${summaryId}.jsonl`),
    createMinimalJsonl({
      sessionId: summaryId,
      userMessage:
        "Debug the authentication middleware for the REST API - tokens are not being refreshed properly",
      hasSummary: true,
      slug: "happy-debugging-lion",
      timestamp: "2026-02-01T14:30:00.000Z",
    })
  );

  // Empty conversation (only file-history-snapshots)
  const emptyId = "eeeeeeee-1111-2222-3333-444444444444";
  await writeFile(
    path.join(project2Dir, `${emptyId}.jsonl`),
    createMinimalJsonl({
      sessionId: emptyId,
      fileHistoryOnly: true,
    })
  );
}
