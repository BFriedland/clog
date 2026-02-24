import { describe, it, expect } from "vitest";
import {
  chunkConversation,
  groupIntoTurns,
  renderTurn,
  splitLongText,
} from "../src/search/chunker.js";
import type { Message } from "../src/models/conversation.js";

function msg(
  role: Message["role"],
  content: string,
  toolName?: string,
): Message {
  return {
    role,
    content,
    timestamp: "2026-02-20T10:00:00Z",
    ...(toolName ? { toolName } : {}),
  };
}

// ---------------------------------------------------------------------------
// groupIntoTurns
// ---------------------------------------------------------------------------

describe("groupIntoTurns", () => {
  it("groups a simple user-assistant exchange into one turn", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi there")];
    const turns = groupIntoTurns(messages);

    expect(turns).toHaveLength(1);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[0].endIndex).toBe(2);
    expect(turns[0].messages).toHaveLength(2);
  });

  it("splits at each user message", () => {
    const messages = [
      msg("user", "first question"),
      msg("assistant", "first answer"),
      msg("user", "second question"),
      msg("assistant", "second answer"),
    ];
    const turns = groupIntoTurns(messages);

    expect(turns).toHaveLength(2);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[0].endIndex).toBe(2);
    expect(turns[1].startIndex).toBe(2);
    expect(turns[1].endIndex).toBe(4);
  });

  it("includes tool_use and tool_result in the same turn as their assistant", () => {
    const messages = [
      msg("user", "read the file"),
      msg("assistant", "Let me read that"),
      msg("tool_use", "Read: src/index.ts", "Read"),
      msg("tool_result", "Read: ok", "Read"),
      msg("assistant", "Here's what I found"),
    ];
    const turns = groupIntoTurns(messages);

    expect(turns).toHaveLength(1);
    expect(turns[0].messages).toHaveLength(5);
  });

  it("handles conversation starting with assistant message", () => {
    const messages = [
      msg("assistant", "Welcome!"),
      msg("user", "thanks"),
      msg("assistant", "How can I help?"),
    ];
    const turns = groupIntoTurns(messages);

    expect(turns).toHaveLength(2);
    expect(turns[0].messages).toEqual([msg("assistant", "Welcome!")]);
    expect(turns[0].startIndex).toBe(0);
    expect(turns[0].endIndex).toBe(1);
    expect(turns[1].startIndex).toBe(1);
    expect(turns[1].endIndex).toBe(3);
  });

  it("returns empty array for empty messages", () => {
    expect(groupIntoTurns([])).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// renderTurn
// ---------------------------------------------------------------------------

describe("renderTurn", () => {
  it("renders user and assistant messages", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi there")];
    const text = renderTurn(messages);

    expect(text).toBe("Human: hello\nAssistant: hi there");
  });

  it("includes tool_use names but excludes tool_result output", () => {
    const messages = [
      msg("user", "read the file"),
      msg("assistant", "Sure"),
      msg("tool_use", "Read: src/index.ts", "Read"),
      msg("tool_result", "Read: ok", "Read"),
      msg("assistant", "Done"),
    ];
    const text = renderTurn(messages);

    expect(text).toBe(
      "Human: read the file\nAssistant: Sure\nTool: Read\nAssistant: Done",
    );
    expect(text).not.toContain("Read: ok");
  });

  it("renders tool_use without toolName as empty", () => {
    const messages = [
      msg("tool_use", "some content"),
      msg("tool_result", "some output", "Read"),
    ];
    // tool_use without toolName is skipped, tool_result always skipped
    expect(renderTurn(messages)).toBe("");
  });

  it("skips empty assistant messages", () => {
    const messages = [
      msg("user", "hello"),
      msg("assistant", ""),
      msg("assistant", "  \n  "),
      msg("assistant", "actual response"),
    ];
    const text = renderTurn(messages);

    expect(text).toBe("Human: hello\nAssistant: actual response");
  });
});

// ---------------------------------------------------------------------------
// splitLongText
// ---------------------------------------------------------------------------

describe("splitLongText", () => {
  it("returns text unchanged when under limit", () => {
    const text = "short text";
    expect(splitLongText(text)).toEqual(["short text"]);
  });

  it("splits at 3200 chars and returns text unchanged at exactly 3200", () => {
    const text = "a".repeat(3200);
    expect(splitLongText(text)).toEqual([text]);
  });

  it("splits long text with overlap", () => {
    const text = "a".repeat(5000);
    const segments = splitLongText(text);

    expect(segments.length).toBe(2);
    // First segment: 3200 chars
    expect(segments[0].length).toBe(3200);
    // Second segment starts at offset 3200 - 400 = 2800
    expect(segments[1].length).toBe(5000 - 2800);
    // Overlap: last 400 of first == first 400 of second
    expect(segments[0].slice(-400)).toBe(segments[1].slice(0, 400));
  });

  it("handles text requiring three segments", () => {
    const text = "a".repeat(8000);
    const segments = splitLongText(text);

    expect(segments.length).toBe(3);
    // Verify overlap between adjacent segments
    expect(segments[0].slice(-400)).toBe(segments[1].slice(0, 400));
    expect(segments[1].slice(-400)).toBe(segments[2].slice(0, 400));
  });
});

// ---------------------------------------------------------------------------
// chunkConversation
// ---------------------------------------------------------------------------

describe("chunkConversation", () => {
  const conv = {
    id: "test-conv-id",
    title: "Debug JWT refresh",
    summary: "Walked through a race condition in token refresh",
  };

  it("creates a metadata chunk at index 0", () => {
    const chunks = chunkConversation(conv, []);

    expect(chunks).toHaveLength(1);
    expect(chunks[0].chunkIndex).toBe(0);
    expect(chunks[0].messageStartIndex).toBe(-1);
    expect(chunks[0].messageEndIndex).toBe(-1);
    expect(chunks[0].text).toContain("Title: Debug JWT refresh");
    expect(chunks[0].text).toContain("Summary: Walked through");
    expect(chunks[0].conversationId).toBe("test-conv-id");
  });

  it("skips metadata chunk when title and summary are empty", () => {
    const emptyConv = { id: "test", title: "", summary: "" };
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const chunks = chunkConversation(emptyConv, messages);

    expect(chunks[0].messageStartIndex).not.toBe(-1);
  });

  it("creates turn-based content chunks after metadata", () => {
    const messages = [
      msg("user", "first question"),
      msg("assistant", "first answer"),
      msg("user", "second question"),
      msg("assistant", "second answer"),
    ];
    const chunks = chunkConversation(conv, messages);

    // metadata + 2 turns
    expect(chunks).toHaveLength(3);
    expect(chunks[0].messageStartIndex).toBe(-1); // metadata
    expect(chunks[1].messageStartIndex).toBe(0);
    expect(chunks[1].messageEndIndex).toBe(2);
    expect(chunks[2].messageStartIndex).toBe(2);
    expect(chunks[2].messageEndIndex).toBe(4);
  });

  it("assigns sequential chunkIndex values", () => {
    const messages = [
      msg("user", "q1"),
      msg("assistant", "a1"),
      msg("user", "q2"),
      msg("assistant", "a2"),
    ];
    const chunks = chunkConversation(conv, messages);
    const indices = chunks.map((c) => c.chunkIndex);

    expect(indices).toEqual([0, 1, 2]);
  });

  it("splits long turns into multiple chunks", () => {
    const longContent = "x".repeat(5000);
    const messages = [msg("user", longContent), msg("assistant", "ok")];
    const chunks = chunkConversation(conv, messages);

    // metadata + 2 segments from the long turn
    expect(chunks).toHaveLength(3);
    expect(chunks[1].messageStartIndex).toBe(0);
    expect(chunks[2].messageStartIndex).toBe(0); // same turn, different segment
  });

  it("includes tool names but excludes tool_result from chunk text", () => {
    const messages = [
      msg("user", "read it"),
      msg("assistant", "reading"),
      msg("tool_use", "Read: src/foo.ts", "Read"),
      msg("tool_result", "file contents here...", "Read"),
      msg("assistant", "found it"),
    ];
    const chunks = chunkConversation(conv, messages);

    const contentChunk = chunks.find((c) => c.messageStartIndex === 0)!;
    expect(contentChunk.text).toContain("Human: read it");
    expect(contentChunk.text).toContain("Assistant: reading");
    expect(contentChunk.text).toContain("Tool: Read");
    expect(contentChunk.text).toContain("Assistant: found it");
    expect(contentChunk.text).not.toContain("file contents here");
  });

  it("skips turns that render to empty text", () => {
    const messages = [msg("tool_result", "some output", "Bash")];
    const chunks = chunkConversation(conv, messages);

    // Only metadata chunk, the tool_result-only turn is skipped
    expect(chunks).toHaveLength(1);
    expect(chunks[0].messageStartIndex).toBe(-1);
  });

  it("handles single-turn conversation", () => {
    const messages = [msg("user", "hello"), msg("assistant", "hi")];
    const chunks = chunkConversation(conv, messages);

    expect(chunks).toHaveLength(2); // metadata + 1 turn
  });

  it("sets all conversationId fields correctly", () => {
    const messages = [msg("user", "q"), msg("assistant", "a")];
    const chunks = chunkConversation(conv, messages);

    for (const chunk of chunks) {
      expect(chunk.conversationId).toBe("test-conv-id");
    }
  });
});
