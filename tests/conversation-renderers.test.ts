import { describe, expect, it } from "vitest";

import { renderConversationMarkdown } from "../src/cli/conversation-renderers.js";
import {
  renderDisplayTable,
  renderWarnings,
  type DisplayRow,
} from "../src/cli/common.js";
import type { ConversationMeta } from "../src/models/conversation.js";

describe("renderConversationMarkdown", () => {
  it("renders tool-use messages with a named heading and canonicalized JSON input", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      {
        role: "tool_use",
        content: "",
        timestamp: null,
        toolName: "Bash",
        toolInput: { description: "List files", command: "ls -la" },
      },
    ]);

    expect(markdown).toContain(
      "## Tool Use: Bash\n\n```json\n{\n  \"command\": \"ls -la\",\n  \"description\": \"List files\"\n}\n```",
    );
  });

  it("renders string tool input in a text fence", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      {
        role: "tool_use",
        content: "",
        timestamp: null,
        toolName: "Write",
        toolInput: "raw string input",
      },
    ]);

    expect(markdown).toContain("## Tool Use: Write\n\n```text\nraw string input\n```");
  });

  it("renders a tool-use message without input as a bare heading", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      { role: "tool_use", content: "", timestamp: null },
    ]);

    expect(markdown.endsWith("## Tool Use\n")).toBe(true);
    expect(markdown).not.toContain("```");
  });

  it("renders tool-result messages with and without a tool name", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      {
        role: "tool_result",
        content: "file1\nfile2",
        timestamp: null,
        toolName: "Bash",
      },
      { role: "tool_result", content: "done", timestamp: null },
    ]);

    expect(markdown).toContain("## Tool Result: Bash\n\n```text\nfile1\nfile2\n```");
    expect(markdown).toContain("## Tool Result\n\n```text\ndone\n```");
  });

  it("lengthens the code fence past the longest backtick run in message content", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      {
        role: "assistant",
        content: "Use ```js\ncode\n``` blocks",
        timestamp: null,
      },
      {
        role: "assistant",
        content: "a `````five````` run",
        timestamp: null,
      },
    ]);

    expect(markdown).toContain("````text\nUse ```js\ncode\n``` blocks\n````");
    expect(markdown).toContain("``````text\na `````five````` run\n``````");
  });

  it("lengthens the fence when serialized tool input contains backtick runs", () => {
    const markdown = renderConversationMarkdown(makeConversation(), [
      {
        role: "tool_use",
        content: "",
        timestamp: null,
        toolName: "Edit",
        toolInput: { snippet: "````" },
      },
    ]);

    expect(markdown).toContain(
      "## Tool Use: Edit\n\n`````json\n{\n  \"snippet\": \"````\"\n}\n`````",
    );
  });
});

describe("renderDisplayTable title notes", () => {
  it("keeps the branch note visible when a long title is truncated", () => {
    const output = renderTitleColumn(
      [displayRow({ title: "x".repeat(80), titleSuffix: "[3 branches]" })],
      60,
    );

    expect(output).toContain("...  [3 branches]");
    expect(output).not.toContain("x".repeat(80));
  });

  it("joins a short title and its note with a single space", () => {
    const output = renderTitleColumn(
      [displayRow({ title: "Second child", titleSuffix: "[2 branches]" })],
      80,
    );

    expect(output).toContain("Second child [2 branches]");
  });
});

describe("renderWarnings conversation identity", () => {
  it("shows a short source-qualified conversation ID and guidance", () => {
    const originalWrite = process.stderr.write.bind(process.stderr);
    let output = "";
    process.stderr.write = ((chunk: unknown) => {
      output += String(chunk);
      return true;
    }) as typeof process.stderr.write;
    try {
      renderWarnings([{
        code: "conversation_relationship_self_parent",
        message: "A conversation identifies itself as its branch parent.",
        conversation: {
          id: "bbbbbbbb-1111-2222-3333-444444444444",
          source: "claude-code",
        },
        guidance: "Inspect the conversation's branch metadata.",
      }]);
    } finally {
      process.stderr.write = originalWrite;
    }

    expect(output).toContain("conversation=bbbbbbbb@claude-code");
    expect(output).toContain(
      "hint: Inspect the conversation's branch metadata.",
    );
  });
});

function renderTitleColumn(rows: DisplayRow[], columns: number): string {
  const originalColumns = process.env.COLUMNS;
  const originalWrite = process.stdout.write.bind(process.stdout);
  let output = "";
  process.env.COLUMNS = String(columns);
  process.stdout.write = ((chunk: unknown) => {
    output += String(chunk);
    return true;
  }) as typeof process.stdout.write;
  try {
    renderDisplayTable(rows, { columns: ["title"] });
  } finally {
    process.stdout.write = originalWrite;
    if (originalColumns === undefined) {
      delete process.env.COLUMNS;
    } else {
      process.env.COLUMNS = originalColumns;
    }
  }
  return output;
}

function displayRow(overrides: Partial<DisplayRow> = {}): DisplayRow {
  return {
    id: "bbbbbbbb-1111-2222-3333-444444444444",
    createdAt: "2026-02-01T10:00:00.000Z",
    state: "saved",
    source: "claude-code",
    projectName: "clog",
    author: "alice",
    title: "Title",
    ...overrides,
  };
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = "2026-02-01T10:00:00.000Z";
  const id = "bbbbbbbb-1111-2222-3333-444444444444";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Renderer test",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "testuser",
    projectName: "webapp",
    projectPath: "/Users/testuser/projects/webapp",
    tags: [],
    slug: null,
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "unsaved",
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
