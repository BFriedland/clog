import { execSync } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultConfig, loadConfig, saveConfig } from "../src/config/index.js";
import {
  getConversationById,
  insertConversation,
  listConversations,
} from "../src/db/index.js";
import { runSyncPull, runSyncPush } from "../src/cli/sync.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { gitRevParseHead } from "../src/sync/git.js";
import { getRemoteRoot } from "../src/sync/paths.js";
import {
  getRawConversationPath,
  getRawSourceDir,
} from "../src/utils/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutput } from "./helpers/output.js";

const hasGit = checkGit();

const describeIfGit = hasGit ? describe : describe.skip;

describeIfGit("sync integration (requires git)", () => {
  let tempDir: string;
  let bareRepo: string;
  let externalCheckout: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-sync-int-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    await fs.mkdir(process.env.CLOG_HOME, { recursive: true });

    bareRepo = path.join(tempDir, "bare.git");
    externalCheckout = path.join(tempDir, "external-checkout");

    execSync(`git init -b main --bare "${bareRepo}"`, { stdio: "ignore" });

    // Seed the bare repo with an initial empty commit so pull works.
    execSync(`git clone "${bareRepo}" "${externalCheckout}"`, { stdio: "ignore" });
    runInCheckout(externalCheckout, `git checkout -B main`);
    await fs.writeFile(path.join(externalCheckout, "README.md"), "clog team\n");
    runInCheckout(externalCheckout, `git add README.md`);
    runInCheckout(externalCheckout, `git -c user.email=t@t.t -c user.name=t commit -m init`);
    runInCheckout(externalCheckout, `git push -u origin main`);

    // Configure an author + point remote at the bare repo.
    const config = getDefaultConfig("alice");
    config.remote = {
      url: bareRepo,
      allowPublicRemote: false,
      visibilityConfirmed: true,
      lastSyncHead: null,
    };
    await saveConfig(config);
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("clones the remote on first pull", async () => {
    await captureOutput(async () => {
      await runSyncPull();
    });
    await expect(
      fs.stat(path.join(getRemoteRoot(), ".git")),
    ).resolves.toBeTruthy();
  });

  it("pushes a local conversation and pulls it back on another machine", async () => {
    await captureOutput(async () => {
      await runSyncPull();
    });

    await insertLocalSaved({
      id: "a1111111-1111-1111-1111-111111111111",
      title: "Fix auth",
      author: "alice",
    });

    // Configure git identity just for the checkout so commit works
    // without requiring a system-wide git config in CI.
    runInCheckout(
      getRemoteRoot(),
      `git config user.email integration@test.local && git config user.name integration`,
    );

    await captureOutput(async () => {
      await runSyncPush();
    });

    // Pull in the external checkout and verify the file is there.
    runInCheckout(externalCheckout, `git pull --rebase`);
    await expect(
      fs.stat(
        path.join(
          externalCheckout,
          "alice",
          "claude-code",
          "a1111111-1111-1111-1111-111111111111.meta.json",
        ),
      ),
    ).resolves.toBeTruthy();
  });

  it("pulls a conversation saved by a teammate", async () => {
    // Teammate savees via the external checkout directly.
    const bobDir = path.join(externalCheckout, "bob", "claude-code");
    await fs.mkdir(bobDir, { recursive: true });
    const id = "a2222222-2222-2222-2222-222222222222";
    await fs.writeFile(
      path.join(bobDir, `${id}.meta.json`),
      `${JSON.stringify(
        {
          id,
          title: "Bob's fix",
          summary: "",
          tags: [],
          author: "bob",
          projectName: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          modifiedAt: "2026-02-01T10:00:00.000Z",
          source: "claude-code",
          createdAt: "2026-02-01T10:00:00.000Z",
          slug: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeJsonl(path.join(bobDir, `${id}.jsonl`), [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/tmp/repo",
        message: { role: "user", content: "Hi" },
      },
    ]);

    runInCheckout(externalCheckout, `git add -A`);
    runInCheckout(
      externalCheckout,
      `git -c user.email=b@b.b -c user.name=bob commit -m "bob's save"`,
    );
    runInCheckout(externalCheckout, `git push origin main`);

    const output = await captureOutput(async () => {
      await runSyncPull();
    });

    const row = await getConversationById(id);
    expect(row).not.toBeNull();
    expect(row?.title).toBe("Bob's fix");
    expect(row?.originKind).toBe("git");
    expect(row?.originRef).toBe(bareRepo);
    expect(row?.author).toBe("bob");

    // Search isn't configured in this test setup, so the index nudge
    // (which would point users at `clog index`, a command that requires
    // search) must not appear.
    expect(output.stdout).not.toContain("Search index needs attention");
  });

  it("retracts a conversation when the local DB no longer has it", async () => {
    await captureOutput(async () => {
      await runSyncPull();
    });

    const id = "a3333333-3333-3333-3333-333333333333";
    await insertLocalSaved({ id, title: "To be retracted", author: "alice" });

    runInCheckout(
      getRemoteRoot(),
      `git config user.email integration@test.local && git config user.name integration`,
    );

    await captureOutput(async () => {
      await runSyncPush();
    });

    // Now delete the local row and push again — retraction expected.
    const { deleteConversation } = await import("../src/db/index.js");
    await deleteConversation(id);

    await captureOutput(async () => {
      await runSyncPush();
    });

    runInCheckout(externalCheckout, `git pull --rebase`);
    await expect(
      fs.stat(
        path.join(
          externalCheckout,
          "alice",
          "claude-code",
          `${id}.meta.json`,
        ),
      ),
    ).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses to push when visibilityConfirmed is false", async () => {
    const config = getDefaultConfig("alice");
    config.remote = {
      url: bareRepo,
      allowPublicRemote: false,
      visibilityConfirmed: false,
      lastSyncHead: null,
    };
    await saveConfig(config);

    await expect(
      captureOutput(async () => {
        await runSyncPush();
      }),
    ).rejects.toThrow(/visibility was never confirmed/);
  });

  it("push reports 'Nothing to push' when the checkout matches the DB", async () => {
    await captureOutput(async () => {
      await runSyncPull();
    });

    runInCheckout(
      getRemoteRoot(),
      `git config user.email integration@test.local && git config user.name integration`,
    );

    const output = await captureOutput(async () => {
      await runSyncPush();
    });

    expect(output.stdout).toContain("Nothing to push");
  });

  it("records lastSyncHead when push has nothing local but pulled teammate changes", async () => {
    await captureOutput(async () => {
      await runSyncPull();
    });

    // Teammate pushes a conversation directly, advancing the remote HEAD.
    const bobDir = path.join(externalCheckout, "bob", "claude-code");
    await fs.mkdir(bobDir, { recursive: true });
    const id = "a5555555-5555-5555-5555-555555555555";
    await fs.writeFile(
      path.join(bobDir, `${id}.meta.json`),
      `${JSON.stringify(
        {
          id,
          title: "Bob's other fix",
          summary: "",
          tags: [],
          author: "bob",
          projectName: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          modifiedAt: "2026-02-01T10:00:00.000Z",
          source: "claude-code",
          createdAt: "2026-02-01T10:00:00.000Z",
          slug: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeJsonl(path.join(bobDir, `${id}.jsonl`), [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/tmp/repo",
        message: { role: "user", content: "Hi" },
      },
    ]);
    runInCheckout(externalCheckout, `git add -A`);
    runInCheckout(
      externalCheckout,
      `git -c user.email=b@b.b -c user.name=bob commit -m "bob's save"`,
    );
    runInCheckout(externalCheckout, `git push origin main`);

    runInCheckout(
      getRemoteRoot(),
      `git config user.email integration@test.local && git config user.name integration`,
    );

    const output = await captureOutput(async () => {
      await runSyncPush();
    });

    expect(output.stdout).toContain("Nothing to push");

    const head = await gitRevParseHead(getRemoteRoot());
    const config = await loadConfig();
    expect(config.remote.lastSyncHead).toBe(head);
  });

  it("does not import conversations ignored by clogignore on pull", async () => {
    const id = "a4444444-4444-4444-4444-444444444444";
    const bobDir = path.join(externalCheckout, "bob", "claude-code");
    await fs.mkdir(bobDir, { recursive: true });
    await fs.writeFile(
      path.join(bobDir, `${id}.meta.json`),
      `${JSON.stringify(
        {
          id,
          title: "Excluded",
          summary: "",
          tags: [],
          author: "bob",
          projectName: null,
          savedAt: "2026-02-01T10:00:00.000Z",
          modifiedAt: "2026-02-01T10:00:00.000Z",
          source: "claude-code",
          createdAt: "2026-02-01T10:00:00.000Z",
          slug: null,
        },
        null,
        2,
      )}\n`,
      "utf8",
    );
    await writeJsonl(path.join(bobDir, `${id}.jsonl`), [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/tmp/repo",
        message: { role: "user", content: "Hi" },
      },
    ]);

    runInCheckout(externalCheckout, `git add -A`);
    runInCheckout(
      externalCheckout,
      `git -c user.email=b@b.b -c user.name=bob commit -m "save"`,
    );
    runInCheckout(externalCheckout, `git push origin main`);

    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${id}\n`,
      "utf8",
    );

    await captureOutput(async () => {
      await runSyncPull();
    });

    const rows = await listConversations({ origin: "remote" });
    expect(rows).toHaveLength(0);
  });
});

function checkGit(): boolean {
  try {
    execSync("git --version", { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

function runInCheckout(cwd: string, command: string): void {
  execSync(command, { cwd, stdio: "ignore" });
}

async function insertLocalSaved(options: {
  id: string;
  title: string;
  author: string;
}): Promise<ConversationMeta> {
  const rawPath = getRawConversationPath("claude-code", options.id);
  await fs.mkdir(getRawSourceDir("claude-code"), { recursive: true });
  await writeJsonl(rawPath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/tmp/repo",
      message: { role: "user", content: "Hello" },
    },
  ]);

  const timestamp = "2026-02-01T10:00:00.000Z";
  const conversation: ConversationMeta = {
    id: options.id,
    sourceId: options.id,
    source: "claude-code",
    title: options.title,
    summary: "",
    author: options.author,
    projectName: "repo",
    projectPath: "/tmp/repo",
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved",
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: rawPath,
    filePath: rawPath,
    sourceMtime: null,
    indexedAt: null,
    originKind: "local",
    originRef: null,
  };

  await insertConversation(conversation);
  return conversation;
}
