import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { getConversationById, listConversations } from "../src/db/index.js";
import { scanLocalSources } from "../src/cli/scan.js";
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

  it("applies excluded, config, and clogignore filtering in order", async () => {
    const claudeRoot = path.join(tempDir, "claude");
    const config = getDefaultConfig("alice");
    config.sources["claude-code"].paths = [claudeRoot];
    config.sources["codex-cli"].enabled = false;
    config.sources["claude-code"].includePaths = ["/Users/alice/work"];
    config.sources["claude-code"].excludePaths = ["/Users/alice/work/private"];
    await saveConfig(config);

    await fs.mkdir(process.env.CLOG_HOME!, { recursive: true });
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "excluded"),
      "11111111-1111-1111-1111-111111111111@claude-code\n",
      "utf8",
    );
    await fs.writeFile(
      path.join(process.env.CLOG_HOME!, "clogignore"),
      "project:/Users/alice/work/ignored/*\n",
      "utf8",
    );

    await writeClaudeConversation(claudeRoot, "11111111-1111-1111-1111-111111111111", "/Users/alice/work/app");
    await writeClaudeConversation(claudeRoot, "22222222-2222-2222-2222-222222222222", "/Users/alice/work/private");
    await writeClaudeConversation(claudeRoot, "33333333-3333-3333-3333-333333333333", "/Users/alice/work/ignored/repo");
    await writeClaudeConversation(claudeRoot, "44444444-4444-4444-4444-444444444444", "/Users/alice/work/public");

    const result = await scanLocalSources(config);
    const conversations = await listConversations();

    expect(result.counts.excluded).toBe(1);
    expect(result.counts.filtered).toBe(1);
    expect(result.counts.ignored).toBe(1);
    expect(conversations).toHaveLength(1);
    expect(conversations[0]?.id).toBe("44444444-4444-4444-4444-444444444444");
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
});

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
