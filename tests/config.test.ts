import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ensureClogHomeDirs,
  getDefaultConfig,
  loadConfig,
  saveConfig,
} from "../src/config/index.js";
import { getClogHome } from "../src/utils/paths.js";

describe("config", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-config-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds default config with built-in source defaults", () => {
    const config = getDefaultConfig("alice");

    expect(config.author).toBe("alice");
    expect(config.sources["claude-code"].paths).toEqual(["~/.claude/projects/"]);
    expect(config.sources["codex-cli"].paths).toEqual(["~/.codex/sessions/"]);
  });

  it("creates base clog directories and excluded file", async () => {
    await ensureClogHomeDirs();

    await expect(fs.stat(getClogHome())).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(tempDir, "excluded"), "utf8")).resolves.toBe("");
  });

  it("round-trips a saved config", async () => {
    const config = getDefaultConfig("alice");
    await saveConfig(config);

    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });
});
