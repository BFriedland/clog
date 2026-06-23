import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { getConversationById, insertConversation, listConversations } from "../src/db/index.js";
import { getScanWarningsForCommand } from "../src/cli/common.js";
import { scanLocalSources, type ScanResult } from "../src/cli/scan.js";
import type { ClogWarning } from "../src/models/warnings.js";
import { writeJsonl } from "./helpers/fixtures.js";

describe("scan", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-scan-"));
    process.env.CLOG_HOME = path.join(tempDir, ".clog");
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("applies clogignore and config filtering in order", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];
    config.sources["claude-code"].excludePaths = ["/Users/alice/work/private"];
    await saveConfig(config);

    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      [
        "11111111-1111-1111-1111-111111111111",
        "/Users/alice/work/ignored/*",
      ].join("\n"),
      "utf8",
    );

    await writeClaudeConversation(claudeRoot, "11111111-1111-1111-1111-111111111111", "/Users/alice/work/app");
    await writeClaudeConversation(claudeRoot, "22222222-2222-2222-2222-222222222222", "/Users/alice/work/private");
    await writeClaudeConversation(claudeRoot, "33333333-3333-3333-3333-333333333333", "/Users/alice/work/ignored/repo");
    await writeClaudeConversation(claudeRoot, "44444444-4444-4444-4444-444444444444", "/Users/alice/work/public");

    const result = await scanLocalSources(config);
    const conversations = await listConversations();

    expect(result.counts.filtered).toBe(1);
    expect(result.counts.ignored).toBe(2);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe("44444444-4444-4444-4444-444444444444");
  });

  it("treats ~/ path rules in clogignore as home-expanded project-path matches", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);

    const fakeHome = path.join(tempDir, "home", "alice");
    const originalHome = process.env.HOME;
    process.env.HOME = fakeHome;

    try {
      await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
      await fs.writeFile(
        path.join(process.env.CLOG_HOME!, "clogignore"),
        "~/personal/\n",
        "utf8",
      );

      await writeClaudeConversation(
        claudeRoot,
        "12121212-1212-1212-1212-121212121212",
        path.join(fakeHome, "personal", "app"),
      );
      await writeClaudeConversation(
        claudeRoot,
        "13131313-1313-1313-1313-131313131313",
        path.join(fakeHome, "work", "app"),
      );

      const result = await scanLocalSources(config);
      const conversations = await listConversations();

      expect(result.counts.ignored).toBe(1);
      expect(conversations).toHaveLength(1);
      expect(conversations[0]?.id).toBe("13131313-1313-1313-1313-131313131313");
    } finally {
      if (originalHome === undefined) {
        delete process.env.HOME;
      } else {
        process.env.HOME = originalHome;
      }
    }
  });

  it("updates discovered metadata when source content grows", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "55555555-5555-5555-5555-555555555555";
    await writeClaudeConversation(claudeRoot, id, "/Users/alice/work/app", "Initial title");
    await scanLocalSources(config);

    await writeClaudeConversation(
      claudeRoot,
      id,
      "/Users/alice/work/app",
      "Updated title from source",
      "Updated summary",
    );

    await scanLocalSources(config);

    const updated = await getConversationById(id);
    expect(updated?.title).toBe("Updated title from source");
    expect(updated?.summary).toBe("Updated summary");
  });

  it("does not let local discovery mutate imported rows with the same source identity", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const gitId = "51515151-5151-5151-5151-515151515151";
    const fileId = "52525252-5252-5252-5252-525252525252";
    await insertConversation(makeSavedImportedConversation(gitId, {
      originKind: "git",
      originRef: "git@example.com:team/repo.git",
      sourcePath: "/tmp/remote-checkout/git.jsonl",
      filePath: "/tmp/remote-checkout/git.jsonl",
    }));
    await insertConversation(makeSavedImportedConversation(fileId, {
      originKind: "file",
      originRef: null,
      sourcePath: "/tmp/imports/file.jsonl",
      filePath: "/tmp/imports/file.jsonl",
    }));

    await writeClaudeConversation(claudeRoot, gitId, "/Users/alice/work/app", "Local git collision");
    await writeClaudeConversation(claudeRoot, fileId, "/Users/alice/work/app", "Local file collision");

    const result = await scanLocalSources(config);

    expect(result.counts.discovered).toBe(0);
    expect(result.counts.updated).toBe(0);
    const gitRow = await getConversationById(gitId);
    const fileRow = await getConversationById(fileId);
    expect(gitRow).toMatchObject({
      title: "Imported 51515151",
      sourcePath: "/tmp/remote-checkout/git.jsonl",
      filePath: "/tmp/remote-checkout/git.jsonl",
      originKind: "git",
      originRef: "git@example.com:team/repo.git",
    });
    expect(fileRow).toMatchObject({
      title: "Imported 52525252",
      sourcePath: "/tmp/imports/file.jsonl",
      filePath: "/tmp/imports/file.jsonl",
      originKind: "file",
      originRef: null,
    });
  });

  it("prunes stale discovered entries when source files disappear", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "66666666-6666-6666-6666-666666666666";
    const filePath = await writeClaudeConversation(claudeRoot, id, "/Users/alice/work/app");

    await scanLocalSources(config);
    await fs.rm(filePath);

    const result = await scanLocalSources(config);

    expect(result.counts.pruned).toBe(1);
    await expect(getConversationById(id)).resolves.toBeNull();
  });

  // ============================================================
  // Rescan and cross-source behavior (SPEC §5.5)
  // ============================================================

  it("re-scans report zero work when nothing on disk has changed", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "77777777-7777-7777-7777-777777777777";
    await writeClaudeConversation(claudeRoot, id, "/Users/alice/work/app");

    const firstScan = await scanLocalSources(config);
    expect(firstScan.counts.discovered).toBe(1);

    const firstConversation = await getConversationById(id);
    expect(firstConversation?.modifiedAt).toBeTruthy();

    const secondScan = await scanLocalSources(config);
    expect(secondScan.counts.discovered).toBe(0);
    expect(secondScan.counts.updated).toBe(0);
    expect(secondScan.counts.pruned).toBe(0);

    // The discovered row is untouched, so modifiedAt is preserved byte-for-byte.
    const secondConversation = await getConversationById(id);
    expect(secondConversation?.modifiedAt).toBe(firstConversation?.modifiedAt);
  });

  it("updates sourcePath and projectPath when a discovered file moves to a new project dir", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "88888888-8888-8888-8888-888888888888";
    const originalPath = path.join(claudeRoot, "-Users-alice-project", `${id}.jsonl`);
    await writeJsonl(originalPath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/project",
        message: { role: "user", content: "Start" },
      },
    ]);

    await scanLocalSources(config);
    const beforeMove = await getConversationById(id);
    expect(beforeMove?.projectName).toBe("project");

    // Move the file to a renamed project directory AND update its cwd to match.
    const movedPath = path.join(claudeRoot, "-Users-alice-project-renamed", `${id}.jsonl`);
    await fs.mkdir(path.dirname(movedPath), { recursive: true });
    await writeJsonl(movedPath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/project-renamed",
        message: { role: "user", content: "Start" },
      },
    ]);
    await fs.rm(originalPath);

    await scanLocalSources(config);
    const afterMove = await getConversationById(id);
    expect(afterMove?.sourcePath).toBe(movedPath);
    expect(afterMove?.projectPath).toBe("/Users/alice/project-renamed");
    expect(afterMove?.projectName).toBe("project-renamed");
  });

  it("discovers conversations across both enabled built-in adapters", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const codexRoot = path.join(tempDir, ".codex");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].paths = [codexRoot];

    const claudeId = "aaaa1111-1111-1111-1111-111111111111";
    const codexId = "bbbb2222-2222-2222-2222-222222222222";
    await writeClaudeConversation(claudeRoot, claudeId, "/Users/alice/work/claude-proj");
    await writeCodexConversation(codexRoot, codexId, "/Users/alice/work/codex-proj");

    const result = await scanLocalSources(config);
    expect(result.counts.discovered).toBe(2);

    const claude = await getConversationById(claudeId);
    const codex = await getConversationById(codexId);
    expect(claude?.source).toBe("claude-code");
    expect(codex?.source).toBe("codex-cli");
  });

  it("prunes only conversations whose source directory still matches (per-source isolation)", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const codexRoot = path.join(tempDir, ".codex");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].paths = [codexRoot];

    const claudeId = "cccc3333-3333-3333-3333-333333333333";
    const codexId = "dddd4444-4444-4444-4444-444444444444";
    const claudePath = await writeClaudeConversation(claudeRoot, claudeId, "/Users/alice/work/claude-proj");
    await writeCodexConversation(codexRoot, codexId, "/Users/alice/work/codex-proj");

    await scanLocalSources(config);

    // Remove only the claude source file.
    await fs.rm(claudePath);

    const result = await scanLocalSources(config);

    expect(result.counts.pruned).toBe(1);
    await expect(getConversationById(claudeId)).resolves.toBeNull();
    // Codex conversation survives because its source is a separate watched root.
    await expect(getConversationById(codexId)).resolves.not.toBeNull();
  });

  it("fails closed on a Claude file whose cwd metadata is missing (SPEC §5.5)", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "eeee5555-5555-5555-5555-555555555555";
    const filePath = path.join(claudeRoot, "-Users-alice-project", `${id}.jsonl`);
    // Intentionally no `cwd` anywhere in the file → projectPath cannot be determined.
    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Project unknown" },
      },
    ]);

    const result = await scanLocalSources(config);

    expect(result.counts.discovered).toBe(0);
    expect(result.counts.undiscoverable).toBe(1);
    expect(result.warnings.some((warning) => warning.code === "path_filter_without_project")).toBe(
      false,
    );
    expect(result.undiscoverable).toEqual([
      {
        source: "claude-code",
        path: filePath,
      },
    ]);
    await expect(getConversationById(id)).resolves.toBeNull();
  });

  it("fails closed on a Codex file whose cwd metadata is missing (SPEC §5.5)", async () => {
    const codexRoot = path.join(tempDir, ".codex");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].paths = [codexRoot];

    const id = "ffff6666-6666-6666-6666-666666666666";
    await writeJsonl(
      path.join(
        codexRoot,
        "sessions",
        "2026",
        "02",
        "01",
        `rollout-2026-02-01T10-00-00-${id}.jsonl`,
      ),
      [
        {
          type: "session_meta",
          payload: {
            id,
            timestamp: "2026-02-01T09:59:59.000Z",
          },
        },
      ],
    );

    const result = await scanLocalSources(config);

    expect(result.counts.discovered).toBe(0);
    expect(result.counts.undiscoverable).toBe(1);
    expect(result.warnings.some((warning) => warning.code === "path_filter_without_project")).toBe(
      false,
    );
    expect(result.undiscoverable).toEqual([
      {
        source: "codex-cli",
        path: path.join(
          codexRoot,
          "sessions",
          "2026",
          "02",
          "01",
          `rollout-2026-02-01T10-00-00-${id}.jsonl`,
        ),
      },
    ]);
    await expect(getConversationById(id)).resolves.toBeNull();
  });

  it("counts a previously discovered conversation that loses cwd as undiscoverable, not pruned", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const id = "99999999-9999-9999-9999-999999999999";
    const filePath = path.join(claudeRoot, "-Users-alice-project", `${id}.jsonl`);
    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd: "/Users/alice/project",
        message: { role: "user", content: "Project known" },
      },
    ]);

    const firstScan = await scanLocalSources(config);
    expect(firstScan.counts.discovered).toBe(1);
    await expect(getConversationById(id)).resolves.not.toBeNull();

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Project unknown now" },
      },
    ]);

    const secondScan = await scanLocalSources(config);

    expect(secondScan.counts.undiscoverable).toBe(1);
    expect(secondScan.counts.pruned).toBe(0);
    expect(secondScan.undiscoverable).toEqual([
      {
        source: "claude-code",
        path: filePath,
      },
    ]);
    await expect(getConversationById(id)).resolves.toBeNull();
  });

  it("treats clogignore ID rules as ignored before undiscoverable", async () => {
    const codexRoot = path.join(tempDir, ".codex");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].enabled = false;
    config.sources["codex-cli"].paths = [codexRoot];
    await saveConfig(config);

    const id = "abab7777-7777-7777-7777-777777777777";
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${id}\n`,
      "utf8",
    );

    await writeJsonl(
      path.join(
        codexRoot,
        "sessions",
        "2026",
        "02",
        "01",
        `rollout-2026-02-01T10-00-00-${id}.jsonl`,
      ),
      [
        {
          type: "session_meta",
          payload: {
            id,
            timestamp: "2026-02-01T09:59:59.000Z",
          },
        },
      ],
    );

    const result = await scanLocalSources(config);

    expect(result.counts.ignored).toBe(1);
    expect(result.counts.undiscoverable).toBe(0);
    expect(result.warnings.some((warning) => warning.code === "path_filter_without_project")).toBe(
      false,
    );
    expect(result.undiscoverable).toEqual([]);
    await expect(getConversationById(id)).resolves.toBeNull();
  });

  it("collapses repeated aggregatable warnings via getScanWarningsForCommand", () => {
    const scanResult = buildScanResultWithWarnings([
      {
        code: "source_id_mismatch",
        message: "Codex session ID does not match filename.",
        source: "codex-cli",
        path: "/tmp/rollout-1.jsonl",
      },
      {
        code: "source_id_mismatch",
        message: "Codex session ID does not match filename.",
        source: "codex-cli",
        path: "/tmp/rollout-2.jsonl",
      },
    ]);

    const warnings = getScanWarningsForCommand(scanResult);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("(2 occurrences)");
    expect(warnings[0]?.guidance).toBe(
      'Run "clog status --verbose-warnings" for the full list',
    );
    expect(warnings[0]?.source).toBeUndefined();
    expect(warnings[0]?.path).toBeUndefined();
  });

  it("keeps recovery guidance when repeated aggregatable warnings collapse", () => {
    const scanResult = buildScanResultWithWarnings([
      {
        code: "malformed_jsonl",
        message: "Skipping malformed Codex CLI session file.",
        source: "codex-cli",
        path: "/tmp/broken-1.jsonl",
        guidance: "Fix the JSONL or remove the malformed file.",
      },
      {
        code: "malformed_jsonl",
        message: "Skipping malformed Codex CLI session file.",
        source: "codex-cli",
        path: "/tmp/broken-2.jsonl",
        guidance: "Fix the JSONL or remove the malformed file.",
      },
    ]);

    const warnings = getScanWarningsForCommand(scanResult);

    expect(warnings).toHaveLength(1);
    expect(warnings[0]?.message).toContain("(2 occurrences)");
    expect(warnings[0]?.guidance).toBe(
      'Fix the JSONL or remove the malformed file. Run "clog status --verbose-warnings" for the full list',
    );
    expect(warnings[0]?.path).toBeUndefined();
  });

  it("preserves individual aggregatable warnings when verbose is requested", () => {
    const scanResult = buildScanResultWithWarnings([
      {
        code: "source_id_mismatch",
        message: "Codex session ID does not match filename.",
        source: "codex-cli",
        path: "/tmp/rollout-1.jsonl",
      },
      {
        code: "source_id_mismatch",
        message: "Codex session ID does not match filename.",
        source: "codex-cli",
        path: "/tmp/rollout-2.jsonl",
      },
    ]);

    const warnings = getScanWarningsForCommand(scanResult, { verbose: true });

    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => warning.message === "Codex session ID does not match filename.")).toBe(true);
    expect(warnings.map((warning) => warning.path)).toEqual([
      "/tmp/rollout-1.jsonl",
      "/tmp/rollout-2.jsonl",
    ]);
  });

  it("keeps same-code warnings with different messages separate when collapsing", () => {
    // missing_source_id has two distinct messages from the Codex adapter
    // (payload.id present but not a UUID, vs. payload.id absent). They share
    // a code and source but describe different underlying conditions, so
    // collapsing them into one summary would hide one of the conditions.
    const scanResult = buildScanResultWithWarnings([
      {
        code: "missing_source_id",
        message: "Codex session_meta payload.id is not a valid UUID.",
        source: "codex-cli",
        path: "/tmp/rollout-1.jsonl",
      },
      {
        code: "missing_source_id",
        message: "Codex session_meta payload.id is not a valid UUID.",
        source: "codex-cli",
        path: "/tmp/rollout-2.jsonl",
      },
      {
        code: "missing_source_id",
        message: "Skipping Codex session because no valid UUID-shaped session ID was found.",
        source: "codex-cli",
        path: "/tmp/rollout-3.jsonl",
      },
    ]);

    const warnings = getScanWarningsForCommand(scanResult);

    expect(warnings).toHaveLength(2);
    const invalidUuid = warnings.find((w) =>
      w.message.startsWith("Codex session_meta payload.id is not a valid UUID."),
    );
    const missingUuid = warnings.find((w) =>
      w.message.startsWith("Skipping Codex session because no valid UUID-shaped session ID"),
    );
    expect(invalidUuid?.message).toContain("(2 occurrences)");
    expect(missingUuid?.message).not.toContain("occurrences");
  });

  it("never collapses non-aggregatable codes even when they repeat", () => {
    // Regression guard: if a non-aggregatable warning ever sneaks into a
    // ScanResult, it must pass through unchanged. Collapsing it would point
    // users at a verbose-warnings flag on a command that cannot reproduce it.
    const scanResult = buildScanResultWithWarnings([
      {
        code: "pair_invalid_metadata",
        message: "Remote metadata is invalid.",
        source: "claude-code",
        path: "/remote/a.meta.json",
      },
      {
        code: "pair_invalid_metadata",
        message: "Remote metadata is invalid.",
        source: "claude-code",
        path: "/remote/b.meta.json",
      },
    ]);

    const warnings = getScanWarningsForCommand(scanResult);

    expect(warnings).toHaveLength(2);
    expect(warnings.every((warning) => !warning.message.includes("occurrences"))).toBe(true);
    expect(warnings.every((warning) => warning.guidance === undefined)).toBe(true);
  });

  it("aggregates malformed-file warnings across multiple bad files", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;

    const badDir = path.join(claudeRoot, "-Users-alice-broken");
    await fs.mkdir(badDir, { recursive: true });
    await fs.writeFile(
      path.join(badDir, "ffff6666-6666-6666-6666-666666666666.jsonl"),
      "{not: valid json",
      "utf8",
    );
    await fs.writeFile(
      path.join(badDir, "gggg7777-7777-7777-7777-777777777777.jsonl"),
      "also broken {",
      "utf8",
    );

    // A valid conversation in another project — scan should still include it.
    const goodId = "hhhh8888-8888-8888-8888-888888888888";
    await writeClaudeConversation(claudeRoot, goodId, "/Users/alice/project", "Good one");

    const result = await scanLocalSources(config);

    const malformed = result.warnings.filter((warning) => warning.code === "malformed_jsonl");
    expect(malformed).toHaveLength(2);
    // The good row still gets inserted.
    await expect(getConversationById(goodId)).resolves.not.toBeNull();
  });
});

function buildScanResultWithWarnings(warnings: ClogWarning[]): ScanResult {
  return {
    warnings,
    undiscoverable: [],
    counts: {
      discovered: 0,
      updated: 0,
      pruned: 0,
      filtered: 0,
      ignored: 0,
      undiscoverable: 0,
    },
  };
}

function makeSavedImportedConversation(
  id: string,
  overrides: {
    originKind: "git" | "file";
    originRef: string | null;
    sourcePath: string;
    filePath: string;
  },
) {
  const timestamp = "2026-02-01T10:00:00.000Z";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: `Imported ${id.slice(0, 8)}`,
    summary: "",
    summaryKind: "none" as const,
    summaryExtraction: null,
    author: "bob",
    projectName: null,
    projectPath: null,
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved" as const,
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourceMtime: null,
    indexedAt: null,
    ...overrides,
  };
}

async function writeCodexConversation(
  codexRoot: string,
  id: string,
  cwd: string,
): Promise<string> {
  const filePath = path.join(
    codexRoot,
    "sessions",
    "2026",
    "02",
    "01",
    `rollout-2026-02-01T10-00-00-${id}.jsonl`,
  );

  await writeJsonl(filePath, [
    {
      type: "session_meta",
      payload: {
        id,
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd,
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "user_message",
        message: "Codex conversation",
      },
    },
  ]);

  return filePath;
}

async function writeClaudeConversation(
  root: string,
  id: string,
  cwd: string,
  title = "Title",
  summary?: string,
): Promise<string> {
  const filePath = path.join(root, "-Users-alice-project", `${id}.jsonl`);
  const lines = [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd,
      message: {
        role: "user",
        content: title,
      },
    },
  ];

  if (summary) {
    lines.push({
      type: "summary",
      summary,
    });
  }

  await writeJsonl(filePath, lines);
  return filePath;
}
