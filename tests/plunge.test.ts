import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildPlungeCommand, generatePlungeReport } from "../src/cli/plunge.js";
import { ensureClogHome } from "../src/config/init.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import * as dbModule from "../src/db/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import * as atomicWrite from "../src/utils/atomic-write.js";
import { getClogDbPath, getClogIgnorePath, getConfigPath, getRawConversationPath } from "../src/utils/paths.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutput } from "./helpers/output.js";

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

  it("reports an incompatible schema without migrating or rewriting the database", async () => {
    await ensureClogHome({ interactive: false });
    await dbModule.withDb(
      (db) => {
        db.exec(`
          DROP TABLE conversations;
          DROP TABLE schema_version;
          CREATE TABLE schema_version (version INTEGER NOT NULL);
          INSERT INTO schema_version (version) VALUES (${CURRENT_SCHEMA_VERSION - 1});
        `);
      },
      { mode: "write" },
    );
    const before = await fs.readFile(getClogDbPath());
    const writeSpy = vi.spyOn(atomicWrite, "writeFileAtomic");

    const report = await generatePlungeReport();

    expect(report.exitCode).toBe(1);
    expect(findCheck(report, 2)).toMatchObject({
      severity: "fatal",
      message: `schema_version is ${CURRENT_SCHEMA_VERSION - 1} but clog expects ${CURRENT_SCHEMA_VERSION}.`,
    });
    expect(writeSpy).not.toHaveBeenCalled();
    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(before);
  });

  it("identifies the saved checkpoint that blocks migration from schema version 8", async () => {
    await seedConfig();
    const id = "5aaaaaaa-aaaa-aaaa-aaaa-aaaaaaaaaaaa";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Migration blocker");
    await insertConversation(makeConversation({
      id,
      sourceId: id,
      filePath: rawPath,
      sourcePath: rawPath,
    }));
    await dbModule.withDb((db) => {
      db.exec(`
        CREATE TABLE conversations_v8_corrupt AS
          SELECT *, 'saved' AS state FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_v8_corrupt RENAME TO conversations;
        UPDATE conversations
        SET saved_at = NULL, saved_message_count = NULL, save_version = 0
        WHERE id = '${id}';
        UPDATE schema_version SET version = 8;
      `);
    }, { mode: "write" });
    const before = await fs.readFile(getClogDbPath());

    const report = await generatePlungeReport();

    expect(findCheck(report, 2)?.recovery).toContain("checkpoint corruption reported below");
    expect(findCheck(report, 11)).toMatchObject({
      severity: "corruption",
      conversation: { id, source: "claude-code" },
    });
    expect(findCheck(report, 11)?.message).toContain("saved_at is null");
    expect(findCheck(report, 11)?.message).toContain("saved_message_count is null");
    expect(findCheck(report, 11)?.message).toContain("save_version is 0");
    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(before);
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
          check: 15,
          severity: "fatal",
          subsystem: "config",
        }),
      ]),
    );
  });

  it("reports a missing curated raw file on a local saved row", async () => {
    await seedConfig();
    await insertConversation(
      makeConversation({
        id: "11111111-1111-1111-1111-111111111111",
        sourceId: "11111111-1111-1111-1111-111111111111",
        state: "saved",
        filePath: getRawConversationPath("claude-code", "11111111-1111-1111-1111-111111111111"),
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 7)?.message).toContain("raw file is missing");
  });

  it("does not report a syntactically valid unknown source as corruption", async () => {
    await seedConfig();
    const id = "10101010-1010-1010-1010-101010101010";
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        source: "future.agent",
        state: "saved",
        savedAt: "2026-02-01T10:00:00.000Z",
        savedMessageCount: 1,
        saveVersion: 1,
        filePath: path.join(tempDir, "missing-future-source.jsonl"),
        sourcePath: path.join(tempDir, "missing-future-source.jsonl"),
      }),
    );

    const report = await generatePlungeReport();

    expect(report.findings.find((finding) => finding.conversation?.id === id)).toBeUndefined();
  });

  it("reports syntactically invalid stored source keys as corruption", async () => {
    await seedConfig();
    const id = "10101010-2020-2020-2020-101010101010";
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        source: "Future.Agent",
      }),
    );

    const report = await generatePlungeReport();

    expect(report.findings).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          check: 3,
          severity: "corruption",
          conversation: { id, source: "Future.Agent" },
          message: expect.stringContaining("invalid source key"),
        }),
      ]),
    );
  });

  it("reports an unexpected raw file path on a local saved row", async () => {
    await seedConfig();
    const wrongPath = path.join(tempDir, "wrong.jsonl");
    await fs.writeFile(wrongPath, "", "utf8");
    await insertConversation(
      makeConversation({
        id: "22222222-2222-2222-2222-222222222222",
        sourceId: "22222222-2222-2222-2222-222222222222",
        state: "saved",
        filePath: wrongPath,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 7)?.message).toContain("outside the expected raw location");
  });

  it("reports raw parse failure on a local saved row", async () => {
    await seedConfig();
    const id = "33333333-3333-3333-3333-333333333333";
    const rawPath = getRawConversationPath("claude-code", id);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, "{not json}\n", "utf8");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "saved",
        filePath: rawPath,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 8)?.message).toContain("could not be parsed");
  });

  it("skips parse-based checks for a transcript stamped by a newer adapter", async () => {
    await seedConfig();
    const id = "34343434-3434-3434-3434-343434343434";
    const rawPath = getRawConversationPath("claude-code", id);
    await fs.mkdir(path.dirname(rawPath), { recursive: true });
    await fs.writeFile(rawPath, "{not json}\n", "utf8");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "saved",
        filePath: rawPath,
        transcriptProjectionVersion: 3,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 8)).toBeUndefined();
    expect(findCheck(report, 9)).toBeUndefined();
    expect(findCheck(report, 18)).toMatchObject({
      severity: "info",
      conversation: { id, source: "claude-code" },
      message: expect.stringContaining("parse-based raw and checkpoint checks were skipped"),
    });
  });

  it("reports save checkpoint drift as informational when parsed messages are below saved_message_count", async () => {
    await seedConfig();
    const id = "44444444-4444-4444-4444-444444444444";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Checkpoint");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "saved",
        filePath: rawPath,
        savedAt: "2026-02-01T10:00:00.000Z",
        savedMessageCount: 3,
        saveVersion: 1,
      }),
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 9)?.message).toContain("below saved_message_count");
    expect(findCheck(report, 9)?.severity).toBe("info");
    expect(findCheck(report, 9)?.recovery).toContain("refresh the stored message-count checkpoint");
    expect(report.exitCode).toBe(0);
  });

  it("reports missing save metadata without synthesizing it", async () => {
    await seedConfig();
    const id = "55555555-5555-5555-5555-555555555555";
    const rawPath = getRawConversationPath("claude-code", id);
    await writeMinimalClaudeJsonl(rawPath, "Saved");
    await insertConversation(
      makeConversation({
        id,
        sourceId: id,
        state: "saved",
        filePath: rawPath,
      }),
    );
    await dbModule.withDb((db) => {
      db.exec(`
        CREATE TABLE conversations_without_constraints AS
          SELECT * FROM conversations;
        DROP TABLE conversations;
        ALTER TABLE conversations_without_constraints RENAME TO conversations;
      `);
      db.run(
        "UPDATE conversations SET saved_at = NULL, saved_message_count = NULL, save_version = 0 WHERE id = ?",
        [id],
      );
    }, { mode: "write" });

    const report = await generatePlungeReport();

    expect(findCheck(report, 11)?.message).toContain("saved_message_count is null");
    expect(findCheck(report, 11)?.message).toContain("save_version is 0");
    expect(findCheck(report, 12)?.message).toContain("saved_at");
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
    expect(findCheck(report, 16)?.severity).toBe("info");
  });

  it("accepts supported literal clogignore rules", async () => {
    await seedConfig();
    await fs.writeFile(
      getClogIgnorePath(),
      ["myapp", "12345678-1234-1234-1234-123456789abc.jsonl", "~/personal/"].join("\n"),
      "utf8",
    );

    const report = await generatePlungeReport();

    expect(findCheck(report, 13)).toBeUndefined();
    expect(findCheck(report, 14)).toBeUndefined();
  });

  it("reports unsupported clogignore rule syntax", async () => {
    await seedConfig();
    await fs.writeFile(getClogIgnorePath(), "before:not-a-date\n", "utf8");

    const report = await generatePlungeReport();

    expect(findCheck(report, 14)?.message).toContain("Unsupported clogignore rule");
  });

  it("reports unreadable clogignore as a read error instead of a fake line number", async () => {
    await seedConfig();
    const originalReadFile = fs.readFile.bind(fs);
    const readFileSpy = vi.spyOn(fs, "readFile");
    readFileSpy.mockImplementation(async (filePath, ...args) => {
      if (String(filePath) === getClogIgnorePath()) {
        const error = new Error("permission denied") as NodeJS.ErrnoException;
        error.code = "EACCES";
        throw error;
      }

      return originalReadFile(filePath, ...args) as ReturnType<typeof fs.readFile>;
    });

    const report = await generatePlungeReport();

    expect(findCheck(report, 13)?.message).toContain("clogignore could not be read");
    expect(findCheck(report, 13)?.message).not.toContain("line 0");
  });

  it("is deterministic apart from ranAt", async () => {
    await seedConfig();
    await fs.writeFile(getClogIgnorePath(), "project:myapp\n", "utf8");

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
        state: "saved",
        filePath: rawPath,
        savedAt: "2026-02-01T10:00:00.000Z",
        savedMessageCount: 3,
        saveVersion: 1,
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
  return captureOutput(async () => {
    const cmd = builder();
    cmd.exitOverride();
    await cmd.parseAsync(args, { from: "user" });
  });
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
    state: "saved",
    savedAt: now,
    savedMessageCount: 0,
    saveVersion: 1,
    sourcePath: "/tmp/source.jsonl",
    filePath: null,
    sourceMtime: now,
    indexedAt: null,
    originKind: "local",
    originRef: null,
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
