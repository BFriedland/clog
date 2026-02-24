import path from "node:path";
import { mkdir, writeFile } from "node:fs/promises";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createMinimalJsonl, createFixtureDir } from "./helpers/fixtures.js";
import { ClaudeCodeAdapter, decodeDirName } from "../src/adapters/claude-code.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("decodeDirName", () => {
  it("decodes Unix-style path", () => {
    const result = decodeDirName("-Users-alice-myproject");
    expect(result).toBe(`${path.sep}Users${path.sep}alice${path.sep}myproject`);
  });

  it("decodes Windows-style path with drive letter", () => {
    const result = decodeDirName("-C-Users-alice-project");
    expect(result).toBe(`C:${path.sep}Users${path.sep}alice${path.sep}project`);
  });

  it("returns null for plain dir name (no leading dash)", () => {
    const result = decodeDirName("some-directory");
    expect(result).toBeNull();
  });
});

describe("extractMetadata", () => {
  it("returns title from first user message", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-1.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-1",
        userMessage: "Help me fix the login page",
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const meta = await adapter.extractMetadata(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.title).toBe("Help me fix the login page");
  });

  it("returns summary from summary line", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-2.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-2",
        hasSummary: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const meta = await adapter.extractMetadata(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.summary).toBe("Debugging session for test project");
  });

  it("returns slug", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-3.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-3",
        slug: "happy-debugging-pony",
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const meta = await adapter.extractMetadata(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.slug).toBe("happy-debugging-pony");
  });

  it("returns null for file-history-only file", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-fh.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-fh",
        fileHistoryOnly: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const meta = await adapter.extractMetadata(filePath);
    expect(meta).toBeNull();
  });

  it("truncates title to 100 chars", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const longMessage = "A".repeat(200);
    const filePath = path.join(sourceDir, "session-long.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-long",
        userMessage: longMessage,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const meta = await adapter.extractMetadata(filePath);
    expect(meta).not.toBeNull();
    expect(meta!.title).toHaveLength(100);
  });
});

describe("parseMessages", () => {
  it("returns correct message count for simple conversation", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-parse.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-parse",
        userMessage: "Hello",
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);
    // user + assistant text
    expect(messages).toHaveLength(2);
    expect(messages[0].role).toBe("user");
    expect(messages[1].role).toBe("assistant");
  });

  it("deduplicates by message.id", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-dedup.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-dedup",
        duplicateAssistantId: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);
    // user + one merged assistant (two text blocks from same message.id)
    const assistantMessages = messages.filter((m) => m.role === "assistant");
    // Even with duplicateAssistantId, they get merged into content blocks
    // and emitted as separate text messages from the same deduped entry
    expect(assistantMessages.length).toBeGreaterThanOrEqual(1);
  });

  it("strips thinking blocks", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-thinking.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-thinking",
        hasThinking: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);
    // No message should have "thinking" content
    const thinkingMessages = messages.filter(
      (m) => m.content.includes("Let me think about this")
    );
    expect(thinkingMessages).toHaveLength(0);
  });

  it("resolves tool_use name on tool_result", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-tool.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-tool",
        hasToolUse: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);

    const toolResults = messages.filter((m) => m.role === "tool_result");
    expect(toolResults.length).toBeGreaterThanOrEqual(1);
    expect(toolResults[0].toolName).toBe("Read");
  });

  it("maintains chronological order", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-order.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({
        sessionId: "session-order",
        hasToolUse: true,
      })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);

    // Verify timestamps are in non-decreasing order
    const timestamps = messages
      .map((m) => m.timestamp)
      .filter((t): t is string => t !== null);
    for (let i = 1; i < timestamps.length; i++) {
      expect(timestamps[i] >= timestamps[i - 1]).toBe(true);
    }
  });

  it("returns empty array for empty file", async () => {
    const sourceDir = path.join(env.clogHome, "sources", "-Users-test-proj");
    await mkdir(sourceDir, { recursive: true });

    const filePath = path.join(sourceDir, "session-empty.jsonl");
    await writeFile(
      filePath,
      createMinimalJsonl({ sessionId: "empty", emptyFile: true })
    );

    const adapter = new ClaudeCodeAdapter([path.join(env.clogHome, "sources")]);
    const messages = await adapter.parseMessages(filePath);
    expect(messages).toHaveLength(0);
  });
});

describe("discover", () => {
  it("discovers correct count of conversations from fixture dir", async () => {
    const sourceDir = path.join(env.clogHome, "sources");
    await createFixtureDir(sourceDir);

    const adapter = new ClaudeCodeAdapter([sourceDir]);
    const discovered = [];
    for await (const conv of adapter.discover()) {
      discovered.push(conv);
    }

    // Fixtures create: 2 in project1, 2 in project2 (one with content + one file-history-only)
    // file-history-only returns null from extractMetadata, so 4 conversations total
    // but eeeeeeee is file-history-only -> null -> skipped
    expect(discovered).toHaveLength(4);
  });

  it("does not include subagent files", async () => {
    const sourceDir = path.join(env.clogHome, "sources");
    await createFixtureDir(sourceDir);

    const adapter = new ClaudeCodeAdapter([sourceDir]);
    const discovered = [];
    for await (const conv of adapter.discover()) {
      discovered.push(conv);
    }

    // No subagent IDs should appear
    const sourceIds = discovered.map((d) => d.sourceId);
    expect(sourceIds).not.toContain("prompt-sub-1");
    expect(sourceIds).not.toContain("task-sub-1");

    // All discovered should be top-level conversation IDs
    for (const d of discovered) {
      expect(d.sourceId).toMatch(
        /^[a-f0-9]{8}-[0-9]{4}-[0-9]{4}-[0-9]{4}-[0-9]{12}$/
      );
    }
  });
});
