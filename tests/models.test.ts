import { describe, it, expect } from "vitest";
import {
  MessageSchema,
  ConversationStateSchema,
  ConversationMetaSchema,
  DiscoveredConversationSchema,
} from "../src/models/conversation.js";

describe("MessageSchema", () => {
  it("parses a valid user message", () => {
    const result = MessageSchema.parse({
      role: "user",
      content: "Hello",
      timestamp: "2026-01-01T00:00:00Z",
    });
    expect(result.role).toBe("user");
    expect(result.content).toBe("Hello");
  });

  it("parses a tool_use message with optional fields", () => {
    const result = MessageSchema.parse({
      role: "tool_use",
      content: "Read file",
      timestamp: null,
      toolName: "Read",
      toolInput: { file_path: "/tmp/test.ts" },
    });
    expect(result.toolName).toBe("Read");
    expect(result.timestamp).toBeNull();
  });

  it("rejects invalid role", () => {
    expect(() =>
      MessageSchema.parse({
        role: "system",
        content: "test",
        timestamp: null,
      })
    ).toThrow();
  });

  it("rejects missing content", () => {
    expect(() =>
      MessageSchema.parse({
        role: "user",
        timestamp: null,
      })
    ).toThrow();
  });
});

describe("ConversationStateSchema", () => {
  it("accepts valid states", () => {
    expect(ConversationStateSchema.parse("discovered")).toBe("discovered");
    expect(ConversationStateSchema.parse("staged")).toBe("staged");
    expect(ConversationStateSchema.parse("published")).toBe("published");
  });

  it("rejects invalid state", () => {
    expect(() => ConversationStateSchema.parse("archived")).toThrow();
  });
});

describe("ConversationMetaSchema", () => {
  const validMeta = {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    sourceId: "source-1",
    source: "claude-code",
    title: "Test",
    summary: "A test",
    author: "testuser",
    project: null,
    tags: ["debug"],
    slug: "test-slug",
    createdAt: "2026-01-01T00:00:00Z",
    discoveredAt: "2026-01-01T00:00:00Z",
    modifiedAt: "2026-01-01T00:00:00Z",
    state: "discovered",
    publishedAt: null,
    publishVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: null,
    indexedAt: null,
  };

  it("parses valid conversation metadata", () => {
    const result = ConversationMetaSchema.parse(validMeta);
    expect(result.id).toBe("aaaaaaaa-1111-2222-3333-444444444444");
    expect(result.origin).toBeNull(); // default
  });

  it("accepts origin field", () => {
    const result = ConversationMetaSchema.parse({
      ...validMeta,
      origin: "team-remote",
    });
    expect(result.origin).toBe("team-remote");
  });

  it("rejects invalid state in metadata", () => {
    expect(() =>
      ConversationMetaSchema.parse({ ...validMeta, state: "invalid" })
    ).toThrow();
  });

  it("rejects missing required fields", () => {
    expect(() =>
      ConversationMetaSchema.parse({ id: "test" })
    ).toThrow();
  });
});

describe("DiscoveredConversationSchema", () => {
  it("parses valid discovered conversation", () => {
    const result = DiscoveredConversationSchema.parse({
      sourceId: "test-id",
      sourcePath: "/tmp/test.jsonl",
      metadata: {
        title: "Test",
        summary: "A test",
        project: "/Users/test/project",
        slug: "test-slug",
        createdAt: "2026-01-01T00:00:00Z",
      },
    });
    expect(result.sourceId).toBe("test-id");
    expect(result.metadata.title).toBe("Test");
  });

  it("rejects missing metadata fields", () => {
    expect(() =>
      DiscoveredConversationSchema.parse({
        sourceId: "test",
        sourcePath: "/tmp/test.jsonl",
        metadata: { title: "Test" },
      })
    ).toThrow();
  });
});
