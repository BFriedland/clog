import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import type { Command } from "commander";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { buildFillCommand } from "../src/cli/fill.js";
import { buildSaveCommand } from "../src/cli/save.js";
import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { ensureClogHome } from "../src/config/init.js";
import { getConversationById } from "../src/db/index.js";
import { writePair, type PairMetadata } from "../src/interchange/pairs.js";
import { getClogDbPath, getRawConversationPath } from "../src/utils/paths.js";
import { captureOutputWithError } from "./helpers/output.js";

describe("clog save: restored-overwrite guard", () => {
  let tempDir: string;
  let sourceDir: string;
  let pairDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-save-restored-"));
    process.env.CLOG_HOME = path.join(tempDir, "clog-home");
    sourceDir = path.join(tempDir, "source");
    pairDir = path.join(tempDir, "pairs");

    await ensureClogHome({ interactive: false });

    const config = getDefaultConfig("alice");
    config.sources["codex-cli"].enabled = false;
    config.sources["claude-code"].paths = [sourceDir];
    await saveConfig(config);
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  // Regression guard for the in-memory source attachment used by `clog save`.
  // A `fill --own` row keeps projectPath null while the command temporarily uses
  // the matching scan candidate's live sourcePath. That combination triggers the
  // overwrite confirmation without persisting the live path during discovery.
  it("does not overwrite a restored row with a diverged live source without confirmation", async () => {
    const id = "cc111111-1111-1111-1111-111111111111";

    await writePair({
      metaPath: path.join(pairDir, `${id}.meta.json`),
      jsonlPath: path.join(pairDir, `${id}.jsonl`),
      meta: makeMeta(id),
      jsonl: makeClaudeJsonl(1),
    });
    await runBuilt(buildFillCommand, [pairDir, "--own"]);
    const beforeRow = await getConversationById(id);
    const beforeRaw = await fs.readFile(getRawConversationPath("claude-code", id));
    const beforeDb = await fs.readFile(getClogDbPath());

    // The original source still exists locally and has since been continued.
    await fs.mkdir(path.join(sourceDir, "proj"), { recursive: true });
    await fs.writeFile(
      path.join(sourceDir, "proj", `${id}.jsonl`),
      makeClaudeJsonl(2),
      "utf8",
    );

    // Non-interactive `clog save <id>` attaches sourcePath in memory and then hits the guard.
    const result = await runBuilt(buildSaveCommand, [id]);

    expect(result.error).toBeNull();
    expect(result.stdout).toContain("restored content was left unchanged");
    expect(result.stdout).toContain("Saved 0 conversation(s).");

    const row = await getConversationById(id);
    expect(row).toEqual(beforeRow);
    await expect(fs.readFile(getRawConversationPath("claude-code", id))).resolves.toEqual(beforeRaw);
    await expect(fs.readFile(getClogDbPath())).resolves.toEqual(beforeDb);
  });
});

async function runBuilt(
  builder: () => Command,
  args: string[],
): Promise<{ stdout: string; stderr: string; error: unknown }> {
  const previousExitCode = process.exitCode;
  process.exitCode = undefined;

  try {
    return await captureOutputWithError(async () => {
      const cmd = builder();
      cmd.exitOverride();
      await cmd.parseAsync(args, { from: "user" });
    });
  } finally {
    process.exitCode = previousExitCode;
  }
}

function makeMeta(id: string): PairMetadata {
  return {
    id,
    title: "Restored",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    tags: [],
    author: "alice",
    projectName: "proj",
    savedAt: "2026-02-20T10:00:00.000Z",
    modifiedAt: "2026-02-20T10:00:00.000Z",
    source: "claude-code",
    createdAt: "2026-02-19T09:15:00.000Z",
    slug: null,
  };
}

function makeClaudeJsonl(messageCount: number): string {
  const lines: unknown[] = [];
  for (let index = 0; index < messageCount; index += 1) {
    lines.push({
      type: "user",
      timestamp: `2026-02-19T09:${String(15 + index).padStart(2, "0")}:00.000Z`,
      cwd: "/tmp/proj",
      message: { role: "user", content: `Message ${index}` },
    });
  }
  return `${lines.map((line) => JSON.stringify(line)).join("\n")}\n`;
}
