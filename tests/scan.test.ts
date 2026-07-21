import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import * as adapterRegistry from "../src/adapters/registry.js";
import type { SourceAdapter } from "../src/adapters/adapter.js";
import { buildDrainCommand } from "../src/cli/drain.js";
import { buildListCommand } from "../src/cli/list.js";
import { buildSaveCommand } from "../src/cli/save.js";
import { scanLocalSources } from "../src/cli/scan.js";
import { buildShowCommand } from "../src/cli/show.js";
import { buildStatusCommand } from "../src/cli/status.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import {
  buildDiscoveredConversation,
  listConversationView,
  resolveConversationView,
} from "../src/conversations/view.js";
import { conversationStateSchema, unsavedConversationViewSchema } from "../src/models/conversation.js";
import { getConversationById } from "../src/db/index.js";
import { handleList } from "../src/mcp/handlers.js";
import { getClogDbPath } from "../src/utils/paths.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";
import { captureOutput } from "./helpers/output.js";

describe("ephemeral local source scans", () => {
  let tempDir: string;
  let sourceRoot: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-scan-"));
    process.env.CLOG_HOME = path.join(tempDir, ".clog");
    sourceRoot = path.join(tempDir, "claude");
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("returns unsaved candidates without creating or writing the database", async () => {
    const id = "11111111-1111-1111-1111-111111111111";
    await writeClaudeConversation(id, "/Users/alice/work/app", "Investigate auth");
    const config = scanConfig();

    const snapshot = await scanLocalSources(config);

    expect(snapshot.candidates.map((candidate) => candidate.sourceId)).toEqual([id]);
    expect(snapshot.sourceStatuses).toEqual([{ source: "claude-code", complete: true }]);
    await expect(fs.stat(getClogDbPath())).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("marks real adapters incomplete when configured source roots are unavailable", async () => {
    const claudeConfig = scanConfig();
    claudeConfig.sources["claude-code"].paths = [path.join(tempDir, "missing-claude")];
    const claudeSnapshot = await scanLocalSources(claudeConfig);

    expect(claudeSnapshot.sourceStatuses).toEqual([
      { source: "claude-code", complete: false },
    ]);
    expect(claudeSnapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_discovery_incomplete",
        source: "claude-code",
      }),
    ]));
    await expect(
      resolveConversationView("aaaa@claude-code", { scanSnapshot: claudeSnapshot }),
    ).rejects.toThrow(/could not determine/i);

    const codexConfig = getDefaultConfig("alice");
    codexConfig.sources["claude-code"].enabled = false;
    codexConfig.sources["codex-cli"].paths = [path.join(tempDir, "missing-codex")];
    const codexSnapshot = await scanLocalSources(codexConfig);

    expect(codexSnapshot.sourceStatuses).toEqual([
      { source: "codex-cli", complete: false },
    ]);
    expect(codexSnapshot.warnings).toEqual(expect.arrayContaining([
      expect.objectContaining({
        code: "source_discovery_incomplete",
        source: "codex-cli",
      }),
    ]));
  });

  it("marks real adapter discovery incomplete when directory traversal is denied", async () => {
    if (process.platform === "win32" || process.getuid?.() === 0) {
      return;
    }

    const unreadableRoot = path.join(tempDir, "unreadable-claude-root");
    await fs.mkdir(unreadableRoot, { recursive: true });
    await fs.chmod(unreadableRoot, 0o000);

    try {
      await expect(fs.stat(unreadableRoot)).resolves.toMatchObject({});
      await expect(fs.readdir(unreadableRoot)).rejects.toMatchObject({ code: "EACCES" });

      const config = scanConfig();
      config.sources["claude-code"].paths = [unreadableRoot];
      const snapshot = await scanLocalSources(config);

      expect(snapshot.sourceStatuses).toEqual([
        { source: "claude-code", complete: false },
      ]);
      expect(snapshot.warnings).toEqual(expect.arrayContaining([
        expect.objectContaining({
          code: "source_discovery_incomplete",
          source: "claude-code",
        }),
      ]));
    } finally {
      await fs.chmod(unreadableRoot, 0o700);
    }

    const readableRoot = path.join(tempDir, "claude-with-unreadable-project");
    const unreadableProject = path.join(readableRoot, "project");
    await fs.mkdir(unreadableProject, { recursive: true });
    await fs.chmod(unreadableProject, 0o000);

    try {
      const config = scanConfig();
      config.sources["claude-code"].paths = [readableRoot];
      const snapshot = await scanLocalSources(config);

      expect(snapshot.sourceStatuses).toEqual([
        { source: "claude-code", complete: false },
      ]);
    } finally {
      await fs.chmod(unreadableProject, 0o700);
    }
  });

  it("applies clogignore before config filtering and retains ignored display candidates", async () => {
    const ignoredId = "22222222-2222-2222-2222-222222222222";
    const filteredId = "33333333-3333-3333-3333-333333333333";
    const includedId = "44444444-4444-4444-4444-444444444444";
    await writeClaudeConversation(ignoredId, "/Users/alice/work/ignored");
    await writeClaudeConversation(filteredId, "/Users/alice/private/app");
    await writeClaudeConversation(includedId, "/Users/alice/work/public");
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), `${ignoredId}\n`);
    const config = scanConfig();
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];

    const snapshot = await scanLocalSources(config);

    expect(snapshot.counts).toMatchObject({ discovered: 1, filtered: 1, ignored: 1 });
    expect(snapshot.candidates[0]?.sourceId).toBe(includedId);
    expect(snapshot.ignoredCandidates[0]?.sourceId).toBe(ignoredId);
  });

  it("keeps ignored display candidates inside the configured project-path scope", async () => {
    const includedId = "24444444-4444-4444-4444-444444444444";
    const excludedId = "25555555-5555-5555-5555-555555555555";
    const unknownPathId = "26666666-6666-6666-6666-666666666666";
    await writeClaudeConversation(includedId, "/Users/alice/work/included");
    await writeClaudeConversation(excludedId, "/Users/alice/private/excluded");
    await writeJsonl(path.join(sourceRoot, "project", `${unknownPathId}.jsonl`), [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      message: { role: "user", content: "No project path" },
    }]);
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      `${includedId}\n${excludedId}\n${unknownPathId}\n`,
    );
    const config = scanConfig();
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];

    const snapshot = await scanLocalSources(config);

    expect(snapshot.counts.ignored).toBe(3);
    expect(snapshot.ignoredCandidates.map((candidate) => candidate.sourceId)).toEqual([
      includedId,
    ]);
  });

  it("sorts conversation views by timestamp instant and puts invalid timestamps last", async () => {
    const laterId = "27777777-7777-7777-7777-777777777777";
    const earlierId = "28888888-8888-8888-8888-888888888888";
    const invalidId = "29999999-9999-9999-9999-999999999999";
    await insertConversation(savedConversation(laterId, "/tmp/later.jsonl", {
      createdAt: "2025-12-31T23:00:00.000Z",
    }));
    await insertConversation(savedConversation(invalidId, "/tmp/invalid.jsonl", {
      createdAt: "not-a-timestamp",
    }));
    const snapshot = {
      scanTime: "2026-02-01T10:00:00.000Z",
      author: "alice",
      candidates: [{
        source: "claude-code",
        sourceId: earlierId,
        sourcePath: "/tmp/earlier.jsonl",
        sourceMtime: "2026-02-01T10:00:00.000Z",
        metadata: {
          title: "Earlier despite its date spelling",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-01-01T00:30:00.000+02:00",
        },
      }],
      ignoredCandidates: [],
      sourceStatuses: [{ source: "claude-code", complete: true }],
    };

    const conversations = await listConversationView(
      { states: ["saved", "unsaved"] },
      snapshot,
    );

    expect(conversations.map((conversation) => conversation.id)).toEqual([
      laterId,
      earlierId,
      invalidId,
    ]);
  });

  it("builds prospective unsaved metadata from current config and source mtime", async () => {
    const id = "55555555-5555-5555-5555-555555555555";
    await writeClaudeConversation(id, "/Users/alice/work/app");
    const config = scanConfig();
    config.author = "current-author";
    config.defaultTags = ["should-not-appear"];
    const snapshot = await scanLocalSources(config);

    const [conversation] = await listConversationView(
      { states: ["unsaved"] },
      snapshot,
    );

    expect(conversation).toMatchObject({
      id,
      state: "unsaved",
      author: "current-author",
      tags: [],
      savedAt: null,
      savedMessageCount: null,
      saveVersion: 0,
    });
    expect(conversation?.modifiedAt).toBe(conversation?.sourceMtime);
    expect(unsavedConversationViewSchema.parse(conversation)).toEqual(conversation);
    expect(conversationStateSchema.options).toEqual(["unsaved", "saved"]);
    expect(buildDiscoveredConversation(
      snapshot.candidates[0]!,
      snapshot.author,
      snapshot.scanTime,
    )).toEqual(conversation);
  });

  it("lets a saved database row suppress the matching scan identity", async () => {
    const id = "66666666-6666-6666-6666-666666666666";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    await insertConversation(savedConversation(id, sourcePath));
    const snapshot = await scanLocalSources(scanConfig());

    const all = await listConversationView(
      { states: ["saved", "unsaved"] },
      snapshot,
    );

    expect(all).toHaveLength(1);
    expect(all[0]?.state).toBe("saved");
    await expect(resolveConversationView(id, { scanSnapshot: snapshot })).resolves.toMatchObject({
      state: "saved",
    });
  });

  it("reports ambiguity when a saved row and a distinct scan conversation share a prefix", async () => {
    const savedId = "c0de1111-1111-1111-1111-111111111111";
    const unsavedId = "c0de2222-2222-2222-2222-222222222222";
    await insertConversation(savedConversation(savedId, "/managed/saved.jsonl"));
    await writeClaudeConversation(unsavedId, "/Users/alice/work/app");
    const snapshot = await scanLocalSources(scanConfig());

    await expect(
      resolveConversationView("c0de", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/ambiguous/i);
  });

  it("drops a deleted or disabled source conversation from the next unsaved view", async () => {
    const id = "77777777-7777-7777-7777-777777777777";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const config = scanConfig();
    expect((await scanLocalSources(config)).candidates).toHaveLength(1);

    await fs.unlink(sourcePath);
    expect((await scanLocalSources(config)).candidates).toHaveLength(0);

    await writeClaudeConversation(id, "/Users/alice/work/app");
    config.sources["claude-code"].enabled = false;
    expect((await scanLocalSources(config)).candidates).toHaveLength(0);
  });

  it("retains yielded candidates and marks an adapter incomplete when discovery throws", async () => {
    const adapter: SourceAdapter = {
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        const sourcePath = await writeClaudeConversation(
          "88888888-8888-8888-8888-888888888888",
          "/Users/alice/work/app",
        );
        yield {
          sourceId: "88888888-8888-8888-8888-888888888888",
          sourcePath,
          metadata: {
            title: "Retained",
            summary: "",
            projectName: "app",
            projectPath: "/Users/alice/work/app",
            slug: null,
            createdAt: "2026-02-01T10:00:00.000Z",
          },
        };
        throw new Error("source unavailable");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([adapter]);

    const snapshot = await scanLocalSources(scanConfig());

    expect(snapshot.candidates).toHaveLength(1);
    expect(snapshot.sourceStatuses).toEqual([{ source: "claude-code", complete: false }]);
    expect(snapshot.warnings).toContainEqual(expect.objectContaining({
      code: "source_discovery_incomplete",
      source: "claude-code",
    }));
    await expect(
      resolveConversationView("9999@claude-code", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
    await expect(
      resolveConversationView("88888888@claude-code", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
  });

  it("keeps broad partial results but only exempts exact identities from completed sources", async () => {
    const healthyId = "a1111111-1111-1111-1111-111111111111";
    const partialId = "b2222222-2222-2222-2222-222222222222";
    const healthyPath = await writeClaudeConversation(healthyId, "/Users/alice/work/healthy");
    const partialPath = await writeClaudeConversation(partialId, "/Users/alice/work/partial");
    const metadata = (title: string, projectPath: string) => ({
      title,
      summary: "",
      projectName: path.basename(projectPath),
      projectPath,
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
    });
    const healthy: SourceAdapter = {
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        yield {
          sourceId: healthyId,
          sourcePath: healthyPath,
          metadata: metadata("Healthy", "/Users/alice/work/healthy"),
        };
      },
    };
    const incomplete: SourceAdapter = {
      name: "codex-cli",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        yield {
          sourceId: partialId,
          sourcePath: partialPath,
          metadata: metadata("Partial", "/Users/alice/work/partial"),
        };
        throw new Error("partial failure");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([healthy, incomplete]);

    const snapshot = await scanLocalSources(scanConfig());
    const broad = await listConversationView({ states: ["unsaved"] }, snapshot);

    expect(broad.map((conversation) => conversation.id)).toEqual([healthyId, partialId]);
    await expect(
      resolveConversationView(`${healthyId}@claude-code`, { scanSnapshot: snapshot }),
    ).resolves.toMatchObject({ id: healthyId });
    await expect(
      resolveConversationView(healthyId, { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
    await expect(
      resolveConversationView("a111", { scanSnapshot: snapshot }),
    ).rejects.toThrow(/could not determine/i);
  });

  it("keeps partial results and incomplete-source warnings in broad CLI and MCP views", async () => {
    const healthyId = "b3111111-1111-1111-1111-111111111111";
    const partialId = "b3222222-2222-2222-2222-222222222222";
    const healthyPath = await writeClaudeConversation(healthyId, "/Users/alice/work/healthy");
    const partialPath = await writeClaudeConversation(partialId, "/Users/alice/work/partial");
    const discovered = (sourceId: string, sourcePath: string, projectName: string) => ({
      sourceId,
      sourcePath,
      metadata: {
        title: `${projectName} conversation`,
        summary: "",
        projectName,
        projectPath: `/Users/alice/work/${projectName}`,
        slug: null,
        createdAt: "2026-02-01T10:00:00.000Z",
      },
    });
    const healthy: SourceAdapter = {
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        yield discovered(healthyId, healthyPath, "healthy");
      },
    };
    const incomplete: SourceAdapter = {
      name: "codex-cli",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        yield discovered(partialId, partialPath, "partial");
        throw new Error("partial failure");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([healthy, incomplete]);
    await saveConfig(scanConfig());

    const cli = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });
    expect(cli.stdout).toContain(healthyId.slice(0, 8));
    expect(cli.stdout).toContain(partialId.slice(0, 8));
    expect(cli.stderr).toContain("Discovery did not complete for codex-cli");

    const mcp = await handleList({ state: "all", limit: 100 });
    expect(mcp.conversations.map((conversation) => conversation.id)).toEqual(
      expect.arrayContaining([healthyId, partialId]),
    );
    expect(mcp.warnings).toContainEqual(expect.objectContaining({
      code: "source_discovery_incomplete",
      source: "codex-cli",
    }));
  });

  it("runs each adapter discovery once when list --all also renders ignored rows", async () => {
    const includedId = "c3333333-3333-3333-3333-333333333333";
    const ignoredId = "d4444444-4444-4444-4444-444444444444";
    const includedPath = await writeClaudeConversation(includedId, "/Users/alice/work/app");
    const ignoredPath = await writeClaudeConversation(ignoredId, "/Users/alice/work/app");
    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(path.join(process.env.CLOG_HOME!, "clogignore"), `${ignoredId}\n`);
    const discover = vi.fn(async function* () {
      for (const [sourceId, sourcePath] of [
        [includedId, includedPath],
        [ignoredId, ignoredPath],
      ] as const) {
        yield {
          sourceId,
          sourcePath,
          metadata: {
            title: sourceId === includedId ? "Included" : "Ignored",
            summary: "",
            projectName: "app",
            projectPath: "/Users/alice/work/app",
            slug: null,
            createdAt: "2026-02-01T10:00:00.000Z",
          },
        };
      }
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      discover,
    }]);
    await saveConfig(scanConfig());

    const output = await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });

    expect(discover).toHaveBeenCalledOnce();
    expect(output.stdout).toContain("Included");
    expect(output.stdout).toContain("Ignored");
  });

  it("does not discover local sources for the default saved-only list", async () => {
    const discover = vi.fn(async function* () {
      throw new Error("saved-only list must not scan");
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      discover,
    }]);
    await saveConfig(scanConfig());
    await insertConversation(savedConversation(
      "e5555555-5555-5555-5555-555555555555",
      "/managed/conversation.jsonl",
    ));

    await captureOutput(async () => {
      const command = buildListCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(discover).not.toHaveBeenCalled();
  });

  it("leaves the current-schema database byte-identical after scan-backed reads", async () => {
    const id = "f6666666-6666-6666-6666-666666666666";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    await saveConfig(scanConfig());
    await insertConversation(savedConversation(id, sourcePath));
    const before = await fs.readFile(getClogDbPath());

    for (const [build, args] of [
      [buildListCommand, ["--all"]],
      [buildStatusCommand, []],
      [buildShowCommand, [id]],
      [buildDrainCommand, [id, "--output", path.join(tempDir, "read-only.zip")]],
    ] as const) {
      await captureOutput(async () => {
        const command = build();
        command.exitOverride();
        await command.parseAsync([...args], { from: "user" });
      });
    }
    await handleList({ state: "all" });

    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(before);
  });

  it("uses a moved live source for status and persists the repaired path only when saving", async () => {
    const id = "f6777777-7777-7777-7777-777777777777";
    const currentSourcePath = await writeClaudeConversation(
      id,
      "/Users/alice/work/app",
      "Current live content",
    );
    const rawPath = path.join(process.env.CLOG_HOME!, "raw", "claude-code", `${id}.jsonl`);
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Older saved content" },
    }]);
    const staleSourcePath = path.join(tempDir, "old-location", `${id}.jsonl`);
    await insertConversation({
      ...savedConversation(id, staleSourcePath),
      filePath: rawPath,
    });
    await saveConfig(scanConfig());

    const status = await captureOutput(async () => {
      const command = buildStatusCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });
    expect(status.stdout).toContain("Saved conversations whose source files changed:");
    await expect(getConversationById(id)).resolves.toMatchObject({
      sourcePath: staleSourcePath,
      saveVersion: 1,
    });

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([id], { from: "user" });
    });

    await expect(getConversationById(id)).resolves.toMatchObject({
      sourcePath: currentSourcePath,
      saveVersion: 2,
    });
    await expect(fs.readFile(rawPath)).resolves.toEqual(await fs.readFile(currentSourcePath));
  });

  it("leaves a direct saved target unchanged when its source adapter is incomplete", async () => {
    const id = "f6888888-8888-8888-8888-888888888888";
    const rawPath = path.join(process.env.CLOG_HOME!, "raw", "claude-code", `${id}.jsonl`);
    await writeJsonl(rawPath, [{
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: "/Users/alice/work/app",
      message: { role: "user", content: "Saved content" },
    }]);
    await insertConversation({
      ...savedConversation(id, path.join(tempDir, "missing-source.jsonl")),
      filePath: rawPath,
    });
    const incomplete: SourceAdapter = {
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      async *discover() {
        throw new Error("adapter unavailable");
      },
    };
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([incomplete]);
    await saveConfig(scanConfig());
    const beforeRow = await getConversationById(id);
    const beforeRaw = await fs.readFile(rawPath);
    const beforeDb = await fs.readFile(getClogDbPath());

    await expect(captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([id], { from: "user" });
    })).rejects.toThrow(/could not determine/i);

    await expect(getConversationById(id)).resolves.toEqual(beforeRow);
    await expect(fs.readFile(rawPath)).resolves.toEqual(beforeRaw);
    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(beforeDb);
  });

  it("shares one adapter discovery pass across save --all", async () => {
    const id = "a7777777-7777-7777-7777-777777777777";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const discover = vi.fn(async function* () {
      yield {
        sourceId: id,
        sourcePath,
        metadata: {
          title: "Save once",
          summary: "",
          projectName: "app",
          projectPath: "/Users/alice/work/app",
          slug: null,
          createdAt: "2026-02-01T10:00:00.000Z",
        },
      };
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      discover,
    }]);
    const config = scanConfig();
    config.author = "current-save-author";
    config.defaultTags = [" Current ", "current", "Release"];
    await saveConfig(config);

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync(["--all"], { from: "user" });
    });

    expect(discover).toHaveBeenCalledOnce();
    await expect(getConversationById(id)).resolves.toMatchObject({
      state: "saved",
      author: "current-save-author",
      tags: ["current", "release"],
    });
  });

  it("does not discover local sources for bare save", async () => {
    const discover = vi.fn(async function* () {
      throw new Error("bare save must not scan");
    });
    vi.spyOn(adapterRegistry, "getEnabledAdapters").mockReturnValue([{
      name: "claude-code",
      watchPaths: () => [],
      parseMessages: async () => [],
      discover,
    }]);
    await saveConfig(scanConfig());

    await captureOutput(async () => {
      const command = buildSaveCommand();
      command.exitOverride();
      await command.parseAsync([], { from: "user" });
    });

    expect(discover).not.toHaveBeenCalled();
  });

  it("never changes an existing saved row while scanning", async () => {
    const id = "99999999-9999-9999-9999-999999999999";
    const sourcePath = await writeClaudeConversation(id, "/Users/alice/work/app");
    const saved = savedConversation(id, sourcePath);
    await insertConversation(saved);
    await writeClaudeConversation(id, "/Users/alice/work/app", "Changed source title");

    await scanLocalSources(scanConfig());

    await expect(getConversationById(id)).resolves.toEqual(saved);
  });

  function scanConfig() {
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [sourceRoot];
    config.sources["codex-cli"].enabled = false;
    return config;
  }

  async function writeClaudeConversation(
    id: string,
    cwd: string,
    title = "Test conversation",
  ): Promise<string> {
    const filePath = path.join(sourceRoot, "project", `${id}.jsonl`);
    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        cwd,
        message: { role: "user", content: title },
      },
    ]);
    return filePath;
  }
});

function savedConversation(
  id: string,
  sourcePath: string,
  overrides: Partial<ReturnType<typeof savedConversationBase>> = {},
) {
  return { ...savedConversationBase(id, sourcePath), ...overrides };
}

function savedConversationBase(id: string, sourcePath: string) {
  const timestamp = "2026-02-01T10:00:00.000Z";
  return {
    id,
    sourceId: id,
    source: "claude-code",
    title: "Saved title",
    summary: "",
    summaryKind: "none" as const,
    summaryExtraction: null,
    author: "alice",
    projectName: "app",
    projectPath: "/Users/alice/work/app",
    tags: [],
    slug: null,
    createdAt: timestamp,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "saved" as const,
    savedAt: timestamp,
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath,
    filePath: sourcePath,
    sourceMtime: timestamp,
    indexedAt: null,
    originKind: "local" as const,
    originRef: null,
  };
}
