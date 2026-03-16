import path from "node:path";
import { mkdir, writeFile, unlink, rename } from "node:fs/promises";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createFixtureDir } from "./helpers/fixtures.js";
import { scanSources } from "../src/cli/scan.js";
import { withDb } from "../src/db/index.js";
import { saveConfig, defaultConfig } from "../src/config/schema.js";
import { addExcluded } from "../src/cli/excluded.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

async function setupScanEnv(): Promise<string> {
  const sourceDir = path.join(env.clogHome, "sources");
  await createFixtureDir(sourceDir);

  // Write config pointing to our fixture source dir
  await mkdir(env.clogHome, { recursive: true });
  const cfg = defaultConfig();
  cfg.sources["claude-code"].paths = [sourceDir];
  await saveConfig(cfg);

  return sourceDir;
}

describe("Scan fixture dir", () => {
  it("discovers correct count of conversations", async () => {
    await setupScanEnv();

    const counts = await scanSources();
    // 4 conversations with content (eeeeeeee is file-history-only, skipped)
    expect(counts.discovered).toBe(4);
    expect(counts.excluded).toBe(0);
    expect(counts.ignored).toBe(0);
  });

  it("second scan with no changes discovers nothing new", async () => {
    await setupScanEnv();

    // First scan
    await scanSources();

    // Second scan: same source files, same mtimes
    const counts2 = await scanSources();
    expect(counts2.discovered).toBe(0);
    expect(counts2.updated).toBe(0);
  });
});

describe("Excluded conversations are skipped", () => {
  it("skips excluded source IDs", async () => {
    await setupScanEnv();

    // Exclude one conversation by source ID
    await addExcluded("claude-code", "aaaaaaaa-1111-2222-3333-444444444444");

    const counts = await scanSources();
    expect(counts.excluded).toBe(1);
    expect(counts.discovered).toBe(3); // 4 - 1 excluded
  });
});

describe("Pruning stale entries", () => {
  it("prunes discovered entries when source file is deleted", async () => {
    const sourceDir = await setupScanEnv();

    // First scan discovers 4
    const counts1 = await scanSources();
    expect(counts1.discovered).toBe(4);
    expect(counts1.pruned).toBe(0);

    // Delete one source file
    const deletedId = "aaaaaaaa-1111-2222-3333-444444444444";
    await unlink(
      path.join(
        sourceDir,
        "-Users-testuser-projects-webapp",
        `${deletedId}.jsonl`
      )
    );

    // Second scan should prune the deleted entry
    const counts2 = await scanSources();
    expect(counts2.pruned).toBe(1);

    // Verify it's gone from the DB
    const conv = await withDb((ctx) => ctx.getConversation(deletedId));
    expect(conv).toBeNull();
  });

  it("does not prune staged entries when source file is deleted", async () => {
    const sourceDir = await setupScanEnv();
    await scanSources();

    // Stage a conversation
    const stagedId = "aaaaaaaa-1111-2222-3333-444444444444";
    await withDb((ctx) =>
      ctx.updateConversation(stagedId, { state: "staged" })
    );

    // Delete its source file
    await unlink(
      path.join(
        sourceDir,
        "-Users-testuser-projects-webapp",
        `${stagedId}.jsonl`
      )
    );

    // Scan should NOT prune staged entries
    const counts = await scanSources();
    expect(counts.pruned).toBe(0);

    const conv = await withDb((ctx) => ctx.getConversation(stagedId));
    expect(conv).not.toBeNull();
    expect(conv!.state).toBe("staged");
  });

  it("updates sourcePath and project when a file is moved between project dirs", async () => {
    const sourceDir = await setupScanEnv();
    await scanSources();

    const movedId = "aaaaaaaa-1111-2222-3333-444444444444";
    const oldDir = path.join(sourceDir, "-Users-testuser-projects-webapp");
    const newDir = path.join(sourceDir, "-Users-testuser-projects-newproject");
    await mkdir(newDir, { recursive: true });

    // Move the file to a different project dir
    await rename(
      path.join(oldDir, `${movedId}.jsonl`),
      path.join(newDir, `${movedId}.jsonl`)
    );

    const counts = await scanSources();
    expect(counts.pruned).toBe(0);
    expect(counts.updated).toBe(1);

    const conv = await withDb((ctx) => ctx.getConversation(movedId));
    expect(conv).not.toBeNull();
    expect(conv!.project).toBe("/Users/testuser/projects/newproject");
    expect(conv!.sourcePath).toContain("-Users-testuser-projects-newproject");
  });
});

describe("Clogignore rules filter conversations", () => {
  it("filters conversations by project rule", async () => {
    await setupScanEnv();

    // Write a clogignore file that filters out project webapp
    const clogignorePath = path.join(env.clogHome, "clogignore");
    await writeFile(
      clogignorePath,
      "# Ignore webapp project\nproject:/Users/testuser/projects/webapp\n",
      "utf-8"
    );

    const counts = await scanSources();
    // webapp project has 2 conversations, so 2 should be ignored
    expect(counts.ignored).toBe(2);
    expect(counts.discovered).toBe(2); // 4 - 2 ignored
  });

  it("filters conversations by before rule", async () => {
    await setupScanEnv();

    // The fixture cccccccc has timestamp 2026-01-15T08:00:00.000Z
    // Set "before:2026-01-20" to ignore conversations created before that date
    const clogignorePath = path.join(env.clogHome, "clogignore");
    await writeFile(
      clogignorePath,
      "before:2026-01-20T00:00:00.000Z\n",
      "utf-8"
    );

    const counts = await scanSources();
    // cccccccc (2026-01-15) should be ignored
    expect(counts.ignored).toBe(1);
  });
});
