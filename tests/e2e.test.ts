import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { createFixtureDir } from "./helpers/fixtures.js";
import { mkdir, readFile } from "node:fs/promises";
import path from "node:path";

const exec = promisify(execFile);

const cli = path.resolve("src/index.ts");

function run(args: string[], env: TestEnv, sourcesDir?: string) {
  return exec("node", ["--import", "tsx", cli, ...args], {
    env: {
      ...process.env,
      CLOG_HOME: env.clogHome,
      ...(sourcesDir ? { CLOG_SOURCES: sourcesDir } : {}),
    },
    timeout: 15000,
  });
}

describe("e2e", () => {
  let env: TestEnv;
  let sourcesDir: string;

  beforeEach(async () => {
    env = await createTestEnv();
    sourcesDir = path.join(env.clogHome, "sources");
    await mkdir(sourcesDir, { recursive: true });
    await createFixtureDir(sourcesDir);
  });

  afterEach(async () => {
    await env.cleanup();
  });

  it("status discovers conversations", async () => {
    const { stdout } = await run(["status"], env, sourcesDir);
    expect(stdout).toContain("Conversations not staged for publishing:");
    expect(stdout).toContain("discovered:");
  });

  it("list defaults to empty when nothing curated", async () => {
    // First trigger a scan
    await run(["status"], env, sourcesDir);
    const { stdout } = await run(["list"], env);
    expect(stdout).toContain("No conversations found.");
  });

  it("list --all shows discovered", async () => {
    await run(["status"], env, sourcesDir);
    const { stdout } = await run(["list", "--all"], env, sourcesDir);
    expect(stdout).toContain("discovered");
    expect(stdout).toContain("STATE");
  });

  it("full workflow: add → edit → tag → publish → show → log", async () => {
    // Scan
    await run(["status"], env, sourcesDir);

    // Add
    const addResult = await run(["add", "aaaa"], env);
    expect(addResult.stdout).toContain("Added 1");

    // Edit
    const editResult = await run(
      ["edit", "aaaa", "--title", "Fixed login CSS"],
      env
    );
    expect(editResult.stdout).toContain("Updated title");

    // Tag
    const tagResult = await run(["tag", "aaaa", "css", "bugfix"], env);
    expect(tagResult.stdout).toContain("css");

    // List should now show the staged conversation
    const listResult = await run(["list"], env);
    expect(listResult.stdout).toContain("Fixed login CSS");

    // Publish
    const pubResult = await run(
      ["publish", "-m", "First batch"],
      env
    );
    expect(pubResult.stdout).toContain("Published");
    expect(pubResult.stdout).toContain("v1");

    // Show
    const showResult = await run(["show", "aaaa"], env);
    expect(showResult.stdout).toContain("Fixed login CSS");
    expect(showResult.stdout).toContain("published");

    // Path
    const pathResult = await run(["path", "aaaa"], env);
    expect(pathResult.stdout.trim()).toContain(".jsonl");

    // Log
    const logResult = await run(["log"], env);
    expect(logResult.stdout).toContain("First batch");
    expect(logResult.stdout).toContain("v1");
  });

  it("exclude blocks rediscovery", async () => {
    await run(["status"], env, sourcesDir);
    await run(["exclude", "aaaa"], env);

    // Re-scan — excluded conversation should not appear
    const { stdout } = await run(["status"], env, sourcesDir);
    expect(stdout).toContain("discovered:");
    // aaaa should not appear (it's excluded)
    expect(stdout).not.toContain("aaaa");
  });

  it("list --all shows excluded conversations", async () => {
    await run(["status"], env, sourcesDir);
    await run(["exclude", "aaaa"], env);

    const { stdout } = await run(["list", "--all"], env, sourcesDir);
    // Should still show the excluded conversation
    expect(stdout).toContain("excluded");
  });

  it("config get/set round-trips", async () => {
    await run(["config", "set", "author", "testuser"], env);
    const { stdout } = await run(["config", "get", "author"], env);
    expect(stdout.trim()).toBe("testuser");
  });

  it("init sets author to OS username in non-TTY", async () => {
    // Fresh env with no pre-existing config
    const freshEnv = await createTestEnv();
    try {
      const { stdout } = await run(["init"], freshEnv);
      expect(stdout).toContain("Initialized clog at");

      const config = JSON.parse(
        await readFile(path.join(freshEnv.clogHome, "config.json"), "utf-8")
      );
      expect(config.author).toBeTruthy();
      expect(config.author.length).toBeGreaterThan(0);
    } finally {
      await freshEnv.cleanup();
    }
  });
});
