import { describe, expect, it } from "vitest";

import { chunkConversationMessages, estimateTokens } from "../src/search/chunker.js";
import type { Message } from "../src/models/conversation.js";

describe("chunkConversationMessages", () => {
  it("creates a metadata chunk and turn chunks", () => {
    const messages: Message[] = [
      { role: "user", content: "How did we fix auth?", timestamp: null },
      { role: "assistant", content: "We refreshed the session token.", timestamp: null },
    ];

    const chunks = chunkConversationMessages(
      {
        conversationId: "abc",
        title: "Debug auth",
        summary: "Session refresh discussion",
      },
      messages,
    );

    expect(chunks).toHaveLength(2);
    expect(chunks[0]?.text).toContain("Title: Debug auth");
    expect(chunks[0]?.text).toContain("Summary: Session refresh discussion");
    expect(chunks[1]?.text).toContain("USER: How did we fix auth?");
    expect(chunks[1]?.text).toContain("ASSISTANT: We refreshed the session token.");
  });

  it("includes tool-use summaries but excludes tool results", () => {
    const messages: Message[] = [
      { role: "user", content: "Check the history", timestamp: null },
      {
        role: "tool_use",
        content: "",
        timestamp: null,
        toolName: "Bash",
        toolInput: { cmd: "git log --oneline -20" },
      },
      {
        role: "tool_result",
        content: "very long command output",
        timestamp: null,
        toolName: "Bash",
      },
    ];

    const chunks = chunkConversationMessages(
      {
        conversationId: "abc",
        title: "",
        summary: "",
      },
      messages,
    );

    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.text).toContain("Bash: git log --oneline -20");
    expect(chunks[0]?.text).not.toContain("very long command output");
  });

  it("splits long turns into overlapping chunks", () => {
    const longText = "a".repeat(7000);
    const messages: Message[] = [
      { role: "user", content: longText, timestamp: null },
    ];

    const chunks = chunkConversationMessages(
      {
        conversationId: "abc",
        title: "",
        summary: "",
      },
      messages,
    );

    expect(chunks.length).toBeGreaterThan(1);
    expect(estimateTokens(chunks[0]?.text ?? "")).toBeGreaterThan(100);
    expect(chunks[0]?.startMessageIndex).toBe(0);
    expect(chunks[1]?.startMessageIndex).toBe(0);
    expect(chunks[0]?.text.slice(-100)).toContain("a");
    expect(chunks[1]?.text.slice(0, 100)).toContain("a");
  });
});
