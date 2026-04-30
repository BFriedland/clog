import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import type { ConversationMeta } from "../src/models/conversation.js";
import {
  conversationToRemoteMeta,
  parseRemoteMeta,
  readRemoteMeta,
  serializeRemoteMeta,
  writeRemoteMeta,
} from "../src/sync/meta.js";

describe("sync meta", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-sync-meta-"));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("serializes a saved conversation, stripping local-only fields", () => {
    const meta = conversationToRemoteMeta(makeConversation());

    expect(meta).toEqual({
      id: "abc12345-1234-1234-1234-123456789012",
      title: "Fix auth",
      summary: "JWT expiration",
      tags: ["auth", "debugging"],
      author: "alice",
      projectName: "api-service",
      savedAt: "2026-02-20T10:00:00.000Z",
      modifiedAt: "2026-02-21T15:00:00.000Z",
      source: "claude-code",
      createdAt: "2026-02-19T09:15:00.000Z",
      slug: "fix-auth",
    });

    const serialized = serializeRemoteMeta(meta);
    expect(serialized.endsWith("\n")).toBe(true);

    const parsed = JSON.parse(serialized);
    expect(parsed).not.toHaveProperty("projectPath");
    expect(parsed).not.toHaveProperty("origin");
    expect(parsed).not.toHaveProperty("savedMessageCount");
    expect(parsed).not.toHaveProperty("state");
    expect(parsed).not.toHaveProperty("filePath");
    expect(parsed).not.toHaveProperty("sourcePath");
    expect(parsed).not.toHaveProperty("indexedAt");
  });

  it("round-trips a written meta file", async () => {
    const meta = conversationToRemoteMeta(makeConversation());
    const metaPath = path.join(tempDir, "abc12345.meta.json");

    await writeRemoteMeta(metaPath, meta);

    const result = await readRemoteMeta(metaPath);
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta).toEqual(meta);
    }
  });

  it("rejects meta with invalid JSON", () => {
    const result = parseRemoteMeta("not json");
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/invalid JSON/);
    }
  });

  it("rejects meta missing required fields", () => {
    const result = parseRemoteMeta(JSON.stringify({ id: "abc" }));
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/title|author|source/);
    }
  });

  it("rejects meta with non-ISO timestamps", () => {
    const baseline = conversationToRemoteMeta(makeConversation());
    const result = parseRemoteMeta(
      JSON.stringify({ ...baseline, savedAt: "not-a-date" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/savedAt/);
    }
  });

  it("rejects meta with loose date-like strings (date-only, year-only)", () => {
    const baseline = conversationToRemoteMeta(makeConversation());

    const dateOnly = parseRemoteMeta(
      JSON.stringify({ ...baseline, savedAt: "2026-02-20" }),
    );
    expect(dateOnly.ok).toBe(false);

    const yearOnly = parseRemoteMeta(
      JSON.stringify({ ...baseline, createdAt: "2026" }),
    );
    expect(yearOnly.ok).toBe(false);
  });

  it("rejects meta with an unsupported source key", () => {
    const baseline = conversationToRemoteMeta(makeConversation());
    const result = parseRemoteMeta(
      JSON.stringify({ ...baseline, source: "not-a-real-source" }),
    );
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.reason).toMatch(/source/);
    }
  });

  it("refuses to serialize a not-yet-saved conversation", () => {
    const notSaved = { ...makeConversation(), savedAt: null };
    expect(() => conversationToRemoteMeta(notSaved)).toThrow(
      /savedAt is null/,
    );
  });
});

function makeConversation(): ConversationMeta {
  return {
    id: "abc12345-1234-1234-1234-123456789012",
    sourceId: "abc12345-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Fix auth",
    summary: "JWT expiration",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: ["auth", "debugging"],
    slug: "fix-auth",
    createdAt: "2026-02-19T09:15:00.000Z",
    discoveredAt: "2026-02-19T09:20:00.000Z",
    modifiedAt: "2026-02-21T15:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-20T10:00:00.000Z",
    savedMessageCount: 42,
    saveVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/raw.jsonl",
    sourceMtime: null,
    indexedAt: "2026-02-20T10:00:05.000Z",
    origin: null,
  };
}
