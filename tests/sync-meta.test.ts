import path from "node:path";
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import {
  MetaJsonSchema,
  readMetaJson,
  writeMetaJson,
  metaToConversation,
} from "../src/sync/meta.js";
import type { ConversationMeta } from "../src/models/conversation.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = new Date().toISOString();
  return {
    id: "aaaaaaaa-1111-2222-3333-444444444444",
    sourceId: "aaaaaaaa-1111-2222-3333-444444444444",
    source: "claude-code",
    title: "Fix auth bug",
    summary: "Debugged JWT token expiration",
    author: "alice",
    project: "myapp",
    tags: ["auth", "debugging"],
    slug: "fix-auth-bug",
    createdAt: "2026-02-19T09:15:00Z",
    discoveredAt: now,
    modifiedAt: "2026-02-21T15:00:00Z",
    state: "published",
    publishedAt: "2026-02-20T10:00:00Z",
    publishVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/file.jsonl",
    sourceMtime: now,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}

describe("MetaJsonSchema", () => {
  it("validates a complete meta.json", () => {
    const result = MetaJsonSchema.safeParse({
      id: "abc123",
      title: "Fix auth bug",
      summary: "Debugged JWT",
      tags: ["auth"],
      author: "alice",
      project: "myapp",
      publishedAt: "2026-02-20T10:00:00Z",
      modifiedAt: "2026-02-21T15:00:00Z",
      source: "claude-code",
      createdAt: "2026-02-19T09:15:00Z",
      slug: "fix-auth-bug",
    });
    expect(result.success).toBe(true);
  });

  it("applies defaults for optional fields", () => {
    const result = MetaJsonSchema.safeParse({
      id: "abc123",
      title: "Test",
      author: "bob",
      publishedAt: "2026-02-20T10:00:00Z",
      modifiedAt: "2026-02-21T15:00:00Z",
      source: "claude-code",
      createdAt: "2026-02-19T09:15:00Z",
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.summary).toBe("");
      expect(result.data.tags).toEqual([]);
      expect(result.data.project).toBeNull();
      expect(result.data.slug).toBeNull();
    }
  });

  it("rejects missing required fields", () => {
    const result = MetaJsonSchema.safeParse({ id: "abc123" });
    expect(result.success).toBe(false);
  });
});

describe("readMetaJson", () => {
  it("reads and parses a valid file", async () => {
    const metaPath = path.join(env.clogHome, "test.meta.json");
    await mkdir(env.clogHome, { recursive: true });
    await writeFile(
      metaPath,
      JSON.stringify({
        id: "abc123",
        title: "Test",
        author: "alice",
        publishedAt: "2026-02-20T10:00:00Z",
        modifiedAt: "2026-02-21T15:00:00Z",
        source: "claude-code",
        createdAt: "2026-02-19T09:15:00Z",
      }),
      "utf-8"
    );

    const result = await readMetaJson(metaPath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe("abc123");
    expect(result!.title).toBe("Test");
  });

  it("returns null for missing file", async () => {
    const result = await readMetaJson("/nonexistent/path.meta.json");
    expect(result).toBeNull();
  });

  it("returns null for invalid JSON", async () => {
    const metaPath = path.join(env.clogHome, "bad.meta.json");
    await mkdir(env.clogHome, { recursive: true });
    await writeFile(metaPath, "not json", "utf-8");

    const result = await readMetaJson(metaPath);
    expect(result).toBeNull();
  });

  it("returns null for invalid schema", async () => {
    const metaPath = path.join(env.clogHome, "bad-schema.meta.json");
    await mkdir(env.clogHome, { recursive: true });
    await writeFile(metaPath, JSON.stringify({ id: 42 }), "utf-8");

    const result = await readMetaJson(metaPath);
    expect(result).toBeNull();
  });
});

describe("writeMetaJson + readMetaJson round-trip", () => {
  it("writes and reads back correctly", async () => {
    const conv = makeConversation();
    const metaPath = path.join(env.clogHome, "test.meta.json");

    await writeMetaJson(metaPath, conv);

    const result = await readMetaJson(metaPath);
    expect(result).not.toBeNull();
    expect(result!.id).toBe(conv.id);
    expect(result!.title).toBe(conv.title);
    expect(result!.summary).toBe(conv.summary);
    expect(result!.tags).toEqual(conv.tags);
    expect(result!.author).toBe(conv.author);
    expect(result!.project).toBe(conv.project);
    expect(result!.source).toBe(conv.source);
    expect(result!.slug).toBe(conv.slug);
  });

  it("does not include origin or indexedAt in output", async () => {
    const conv = makeConversation({ origin: "git@github.com:org/repo.git" });
    const metaPath = path.join(env.clogHome, "test.meta.json");

    await writeMetaJson(metaPath, conv);

    const raw = await readFile(metaPath, "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.origin).toBeUndefined();
    expect(parsed.indexedAt).toBeUndefined();
    expect(parsed.sourcePath).toBeUndefined();
    expect(parsed.filePath).toBeUndefined();
  });
});

describe("metaToConversation", () => {
  it("converts meta to ConversationMeta with correct defaults", () => {
    const meta = MetaJsonSchema.parse({
      id: "abc123",
      title: "Test",
      author: "alice",
      publishedAt: "2026-02-20T10:00:00Z",
      modifiedAt: "2026-02-21T15:00:00Z",
      source: "claude-code",
      createdAt: "2026-02-19T09:15:00Z",
    });

    const conv = metaToConversation(meta, {
      origin: "git@github.com:org/repo.git",
      sourcePath: "/home/user/.clog/remote/alice/abc123.jsonl",
      filePath: "/home/user/.clog/remote/alice/abc123.jsonl",
    });

    expect(conv.id).toBe("abc123");
    expect(conv.sourceId).toBe("abc123");
    expect(conv.state).toBe("published");
    expect(conv.origin).toBe("git@github.com:org/repo.git");
    expect(conv.publishVersion).toBe(0);
    expect(conv.indexedAt).toBeNull();
  });
});
