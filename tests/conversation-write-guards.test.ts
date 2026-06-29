import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  requireLocalConversation,
  throwImportedReadOnlyError,
} from "../src/conversations/write-guards.js";
import {
  getConversationById,
  removeConversationCopies,
  updateLocalConversation,
} from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  guardedLocalUpdateConversation,
  insertConversation,
  updateConversation,
} from "./helpers/db.js";

describe("conversation write guards", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-write-guards-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("treats only local rows with null originRef as locally writable", () => {
    const local = makeConversation({ originKind: "local", originRef: null });
    expect(requireLocalConversation(local, "clog edit")).toBe(local);

    expect(() =>
      requireLocalConversation(
        makeConversation({
          originKind: "local",
          originRef: "git@example.com:repo.git",
        }),
        "clog edit",
      ),
    ).toThrow(/read-only/);
  });

  it("rejects git and file rows through the local update API", async () => {
    const git = makeConversation({
      originKind: "git",
      originRef: "git@example.com:repo.git",
    });
    const file = makeConversation({
      id: "b1234567-1234-1234-1234-123456789012",
      sourceId: "b1234567-1234-1234-1234-123456789012",
      originKind: "file",
      originRef: null,
    });
    await insertConversation(git);
    await insertConversation(file);

    await expect(
      updateLocalConversation({ ...git, title: "Nope" }, { command: "clog edit" }),
    ).rejects.toThrow(/read-only/);
    await expect(
      updateLocalConversation({ ...file, title: "Nope" }, { command: "clog edit" }),
    ).rejects.toThrow(/read-only/);
  });

  it("re-checks that the row is local inside the database write", async () => {
    const conversation = makeConversation();
    await insertConversation(conversation);
    const loaded = await getConversationById(conversation.id);
    const local = requireLocalConversation(loaded!, "clog edit");

    await updateConversation({
      ...local,
      originKind: "git",
      originRef: "git@example.com:repo.git",
    });

    await expect(
      updateLocalConversation(
        {
          ...local,
          title: "Stale local write",
        },
        { command: "clog edit" },
      ),
    ).rejects.toThrow(/read-only/);
  });

  it("guards local updates with a SQL provenance predicate", async () => {
    const git = makeConversation({
      originKind: "git",
      originRef: "git@example.com:repo.git",
    });
    await insertConversation(git);

    const changedRows = await guardedLocalUpdateConversation({
      ...git,
      title: "Should not update",
      originKind: "local",
      originRef: null,
    });

    expect(changedRows).toBe(0);
    const reloaded = await getConversationById(git.id);
    expect(reloaded?.title).toBe(git.title);
    expect(reloaded?.originKind).toBe("git");
    expect(reloaded?.originRef).toBe("git@example.com:repo.git");
  });

  it("reports one changed row when the SQL guard updates a local row", async () => {
    const local = makeConversation();
    await insertConversation(local);

    const changedRows = await guardedLocalUpdateConversation({
      ...local,
      title: "Updated locally",
    });

    expect(changedRows).toBe(1);
    const reloaded = await getConversationById(local.id);
    expect(reloaded?.title).toBe("Updated locally");
  });

  it("uses the same imported-read-only message shape for write-guard failures", () => {
    expect(() =>
      throwImportedReadOnlyError(
        { id: "a1234567-1234-1234-1234-123456789012" },
        "clog tag",
      ),
    ).toThrow(
      "clog tag cannot modify conversation a1234567 - imported conversations are read-only. Edit it on the original author's machine or remove the imported copy.",
    );
  });

  it("fails a batch removal before deleting rows when a previewed row changed", async () => {
    const first = makeConversation();
    const second = makeConversation({
      id: "b1234567-1234-1234-1234-123456789012",
      sourceId: "b1234567-1234-1234-1234-123456789012",
    });
    await insertConversation(first);
    await insertConversation(second);

    await updateConversation({
      ...second,
      originKind: "git",
      originRef: "git@example.com:repo.git",
    });

    await expect(
      removeConversationCopies([first, second], { command: "clog remove" }),
    ).rejects.toThrow(/changed after preview/);

    await expect(getConversationById(first.id)).resolves.not.toBeNull();
    const changed = await getConversationById(second.id);
    expect(changed?.originKind).toBe("git");
    expect(changed?.originRef).toBe("git@example.com:repo.git");
  });

  it("fails a batch removal before deleting rows when previewed metadata changed", async () => {
    const first = makeConversation();
    const second = makeConversation({
      id: "b1234567-1234-1234-1234-123456789012",
      sourceId: "b1234567-1234-1234-1234-123456789012",
    });
    await insertConversation(first);
    await insertConversation(second);

    await updateConversation({
      ...second,
      summary: "Changed after preview",
      tags: ["changed-after-preview"],
      modifiedAt: "2026-02-01T11:00:00.000Z",
    });

    await expect(
      removeConversationCopies([first, second], { command: "clog remove" }),
    ).rejects.toThrow(/changed after preview/);

    await expect(getConversationById(first.id)).resolves.not.toBeNull();
    const changed = await getConversationById(second.id);
    expect(changed?.summary).toBe("Changed after preview");
    expect(changed?.tags).toEqual(["changed-after-preview"]);
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
    summaryKind: "none",
    summaryExtraction: null,
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
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}
