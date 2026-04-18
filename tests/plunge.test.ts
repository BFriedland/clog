import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlungeCommand, generatePlungeReport } from "../src/cli/plunge.js";
import { ensureClogHome } from "../src/config/init.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import * as dbModule from "../src/db/index.js";
import { insertConversation } from "../src/db/index.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { getClogDbPath, getClogIgnorePath, getConfigPath, getExcludedPath, getRawConversationPath } from "../src/utils/paths.js";
import { writeJsonl } from "./helpers/fixtures.js";

describe("plunge", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-plunge-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
    vi.restoreAllMocks();
    process.exitCode = undefined;
  });

  it("returns exit 0 on a clean initialized install and does not create a db file", async () => {
    await ensureClogHome({ interactive: false });

    const report = await generatePlungeReport();

    expect(report.exitCode).toBe(0);
    expect(report.findings).toEqual([]);
    await expect(fs.stat(getConfigPath())).resolves.toBeTruthy();
    await expect(fs.stat(getClogDbPath())).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(path.join(tempDir, "clog.db.lock"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a simulated non-ok integrity_check result as fatal", async () => {
    await ensureClogHome({ interactive: false });

    vi.spyOn(dbModule, "withDb").mockImplementationOnce(async (callback) => {
      const fakeDb = {
        exec(sql: string) {
          if (sql === "PRAGMA integrity_check") {
            return [{ columns: ["integrity_check"], values: [["not ok"]] }];
          }

          if (sql.includes("sqlite_master")) {
            return [];
          }

          return [];
        },
      };

      return callback(fakeDb as never);
    });

    const report = await generatePlungeReport();

    expect(report.exitCode).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 1,
          severity: "fatal",
          subsystem: "database",
        }),
      ]),
    );
  });

  it("reports invalid config as fatal", async () => {
    await fs.mkdir(tempDir, { recursive: true });
    await fs.writeFile(getConfigPath(), "{\n", "utf8");

    const report = await generatePlungeReport();

    expect(report.exitCode).toBe(1);
    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 17,
          severity: "fatal",
          subsystem: "config",
        }),
      ]),
    );
  });

  it("reports a missing curated raw file on a local staged row", async () => {
    await seedConfig();
    await insertConversation(
      makeConversation({
        id: "11111111-1111-1111-1111-111111111111",
        sourceId: "11111111-1111-1111-1111-111111111111",
        state: "staged",
        filePath: getRawConversationPath("claude-code", "11111111-1111-1111-1111-111111111111"),
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 7)?.message).toContain("raw file is missing");
  });

  it("reports an unexpected raw file path on a local staged row", async () => {
    await seedConfig();
    const wrongPath = path.join(tempDir, "wrong.jsonl");
    await fs.writeFile(wrongPath, "", "utf8");
    await insertConversation(
      makeConversation({
        id: "22222222-2222-2222-2222-222222222222",
        sourceId: "22222222-2222-2222-2222-222222222222",
        state: "staged",
        filePath: wrongPath,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 7)?.message).toContain("outside the expected raw location");
  });

  it("reports raw parse failure on a local staged row", async () => {
    await seedConfig();
    const id = "33333333-3333-3333-3333-333333333333";
    const rawPath = getRawConversationPath("claude-code", id);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, "{not json}\n", "utf8");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "staged",
        filePath: rawPath,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 8)?.message).toContain("could not be parsed");
  });

  it("reports publish checkpoint drift as informational when parsed messages are below published_message_count", async () => {
    await seedConfig();
    const id = "44444444-4444-4444-4444-444444444444";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Checkpoint");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "published",
        filePath: rawPath,
        publishedAt: "2026-02-01T10:00:00.000Z",
        publishedMessageCount: 3,
        publishVersion: 1,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 9)?.message).toContain("below published_message_count");
    expect(findCheck(report, 9)?.severity).toBe("info");
    expect(findCheck(report, 9)?.recovery).toContain("refresh the stored message-count checkpoint");
    expect(report.exitCode).toBe(0);
  });

  it("reports missing publish metadata without synthesizing it", async () => {
    await seedConfig();
    const id = "55555555-5555-5555-5555-555555555555";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Published");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "published",
        filePath: rawPath,
        publishedAt: null,
        publishedMessageCount: null,
        publishVersion: 0,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 11)?.message).toContain("published_at is null");
  });

  it("reports invalid timestamps", async () => {
    await seedConfig();
    await insertConversation(
      makeConversation({
        id: "66666666-6666-6666-6666-666666666666",
        sourceId: "66666666-6666-6666-6666-666666666666",
        modifiedAt: "not-a-time",
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 12)?.message).toContain("invalid timestamp");
  });

  it("reports empty config.author as informational only", async () => {
    const config = getDefaultConfig("");
    await fs.mkdir(tempDir, { recursive: true });
    await saveConfig(config);

    const report = await generatePlungeReport();

    expect(report.exitCode).toBe(0);
    expect(findCheck(report, 18)?.severity).toBe("info");
  });

  it("reports malformed excluded entries", async () => {
    await seedConfig();
    await fs.writeFile(getExcludedPath(), "not-valid\n", "utf8");

    const report = await generatePlungeReport();

    expect(findCheck(report, 13)?.message).toContain("Invalid excluded entry");
  });

  it("reports malformed clogignore rules and dates", async () => {
    await seedConfig();
    await fs.writeFile(getClogIgnorePath(), "wat\nbefore:not-a-date\n", "utf8");

    const report = await generatePlungeReport();

    expect(findCheck(report, 15)?.message).toContain("Unrecognized clogignore rule");
    expect(findCheck(report, 16)).toBeUndefined();
  });

  it("reports unreadable excluded as a read error instead of a fake line number", async () => {
    await seedConfig();
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementation(async (filePath, ...args) => {
      if (String(filePath) === getExcludedPath()) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }

      return originalReadFile(filePath, ...args) as ReturnType<typeof fs.readFile>;
    });

    const report = await generatePlungeReport();

    expect(findCheck(report, 13)?.message).toContain("excluded could not be read");
    expect(findCheck(report, 13)?.message).not.toContain("line 0");
  });

  it("is deterministic apart from ranAt", async () => {
    await seedConfig();
    await fs.writeFile(getExcludedPath(), "not-valid\n", "utf8");

    const first = await generatePlungeReport();
    const second = await generatePlungeReport();

    expect({ ...first, ranAt: "<redacted>" }).toEqual({ ...second, ranAt: "<redacted>" });
  });

  it("emits a human clean report for the CLI command", async () => {
    await ensureClogHome({ interactive: false });

    const { stdout } = await runBuiltCommand(buildPlungeCommand, []);

    expect(stdout).toContain("Found 0 fatal/corruption finding(s) and 0 info finding(s).");
  });

  it("shows source, project, author, and origin on separate lines with --verbose", async () => {
    await seedConfig();
    const id = "77777777-7777-7777-7777-777777777777";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Checkpoint");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        source: "claude-code",
        author: "alice",
        projectName: "webapp",
        state: "published",
        filePath: rawPath,
        publishedAt: "2026-02-01T10:00:00.000Z",
        publishedMessageCount: 3,
        publishVersion: 1,
      }),
    );

    const { stdout } = await runBuiltCommand(buildPlungeCommand, ["--verbose"]);

    expect(stdout).toContain(`Conversation ID: ${id}`);
    expect(stdout).toContain("Source: claude-code");
    expect(stdout).toContain("Project: webapp");
    expect(stdout).toContain("Author: alice");
    expect(stdout).toContain("Origin: local");
  });
});

async function runBuiltCommand(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string }> {
  const stdoutChunks: string[] = [];
  const stderrChunks: string[] = [];

  const stdoutSpy = vi
    .spyOn(process.stdout, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      stdoutChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as typeof process.stdout.write);

  const stderrSpy = vi
    .spyOn(process.stderr, "write")
    .mockImplementation(((chunk: unknown): boolean => {
      stderrChunks.push(
        typeof chunk === "string" ? chunk : Buffer.from(chunk as Uint8Array).toString("utf8"),
      );
      return true;
    }) as typeof process.stderr.write);

  try {
    const cmd = builder();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: "user" });
  } finally {
    stdoutSpy.mockRestore();
    stderrSpy.mockRestore();
  }

  return { stdout: stdoutChunks.join(""), stderr: stderrChunks.join("") };
}

async function seedConfig(): Promise<void> {
  await ensureClogHome({ interactive: false });
  const config = getDefaultConfig("alice");
  config.sources["claude-code"].paths = [path.join(tempDirForConfig(), "claude")];
  config.sources["codex-cli"].enabled = false;
  await saveConfig(config);
}

function tempDirForConfig(): string {
  if (!process.env.CLOG_HOME) {
    throw new Error("CLOG_HOME is not set");
  }

  return process.env.CLOG_HOME;
}

function makeConversation(overrides: Partial<ConversationMeta> = {}): ConversationMeta {
  const now = "2026-02-01T10:00:00.000Z";
  const id = overrides.id ?? "aaaaaaaa-1111-2222-3333-444444444444";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Test conversation",
    summary: "",
    author: "alice",
    projectName: "webapp",
    projectPath: "/Users/alice/projects/webapp",
    tags: [],
    slug: null,
    createdAt: now,
    discoveredAt: now,
    modifiedAt: now,
    state: "discovered",
    publishedAt: null,
    publishedMessageCount: null,
    publishVersion: 0,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    origin: null,
    ...overrides,
  };
}

async function writeMinimalClaudeJsonl(filePath: string, userText: string): Promise<void> {
  await writeJsonl(filePath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/webapp",
      message: {
        role: "user",
        content: userText,
      },
    },
    {
      type: "assistant",
      timestamp: "2026-02-01T10:00:01.000Z",
      message: {
        id: "msg_1",
        role: "assistant",
        content: [{ type: "text", text: "Working on it." }],
      },
    },
  ]);
}

function findCheck(report: Awaited<ReturnType<typeof generatePlungeReport>>, check: number) {
  return report.findings.find((finding) => finding.check === check);
}
