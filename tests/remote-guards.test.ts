import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { insertConversation } from "../src/db/index.js";
import { assertNotRemote } from "../src/cli/common.js";
import type { ConversationMeta } from "../src/models/conversation.js";

describe("assertNotRemote", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-remote-guards-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("is a no-op for local conversations", () => {
    expect(() => assertNotRemote(makeConversation({ origin: null }), "clog edit")).not.toThrow();
  });

  it("throws for remote conversations with a read-only message", () => {
    expect(() =>
      assertNotRemote(
        makeConversation({ origin: "git@github.com:myorg/repo.git" }),
        "clog edit",
      ),
    ).toThrow(/read-only/);
  });

  it("names the invoking command in the error", () => {
    expect(() =>
      assertNotRemote(
        makeConversation({ origin: "git@github.com:myorg/repo.git" }),
        "clog tag",
      ),
    ).toThrow(/clog tag/);
  });

  it("round-trips a remote row through DB insertion (smoke test)", async () => {
    const remote = makeConversation({
      origin: "git@github.com:myorg/repo.git",
      state: "saved",
    });
    await insertConversation(remote);
    expect(() => assertNotRemote(remote, "clog edit")).toThrow();
  });
});

function makeConversation(
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  const timestamp = "2026-02-01T10:00:00.000Z";
  return {
    id: "a1234567-1234-1234-1234-123456789012",
    sourceId: "a1234567-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Test",
    summary: "",
    author: "alice",
    projectName: null,
    projectPath: null,
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved",
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: "/tmp/raw.jsonl",
    sourceMtime: null,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}
