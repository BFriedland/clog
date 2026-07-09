import { describe, expect, it } from "vitest";

import {
  conversationMetaSchema,
  messageSchema,
} from "../src/models/conversation.js";

describe("messageSchema", () => {
  it("accepts a minimal message", () => {
    const parsed = messageSchema.parse({
      role: "assistant",
      content: "hello",
      timestamp: null,
    });

    expect(parsed.role).toBe("assistant");
  });
});

describe("conversationMetaSchema", () => {
  it("accepts a phase 1 conversation row", () => {
    const parsed = conversationMetaSchema.parse({
      id: "abc",
      sourceId: "abc",
      source: "claude-code",
      title: "Title",
      summary: "",
      author: "alice",
      projectName: "repo",
      projectPath: "/tmp/repo",
      tags: ["tag"],
      slug: null,
      createdAt: "2026-01-01T00:00:00.000Z",
      discoveredAt: "2026-01-01T00:00:00.000Z",
      modifiedAt: "2026-01-01T00:00:00.000Z",
      state: "unsaved",
      savedAt: null,
      savedMessageCount: null,
      saveVersion: 0,
      sourcePath: "/tmp/source.jsonl",
      filePath: null,
      sourceMtime: null,
      indexedAt: null,
      originKind: "local",
      originRef: null,
    });

    expect(parsed.state).toBe("unsaved");
  });
});
