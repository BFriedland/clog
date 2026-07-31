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
import { getRegisteredSourceMetadata } from "../src/adapters/registry.js";
import { parseConfig } from "../src/config/schema.js";
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

  it("builds a fresh config with no enabled or approved source paths", () => {
    const config = getDefaultConfig("alice");

    expect(config.author).toBe("alice");
    expect(config.sources["claude-code"]).toMatchObject({
      enabled: false,
      paths: [],
    });
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: false,
      paths: [],
    });
  });

  it("preserves the enabled default when parsing an older source block without the field", () => {
    const config = parseConfig({
      author: "alice",
      sources: {
        "claude-code": {
          paths: ["~/.claude/projects/"],
        },
        "codex-cli": {
          paths: ["~/.codex/sessions/"],
        },
      },
      defaultTags: [],
      search: null,
    });

    expect(config.sources["claude-code"].enabled).toBe(true);
    expect(config.sources["codex-cli"].enabled).toBe(true);
  });

  it("leaves an omitted registered source disabled when parsing an older config", () => {
    const config = parseConfig({
      author: "alice",
      sources: {
        "claude-code": {
          paths: ["~/.claude/projects/"],
        },
      },
      defaultTags: [],
      search: null,
    });

    expect(config.sources["claude-code"].enabled).toBe(true);
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: false,
      paths: [],
    });
  });

  it("registers setup metadata for each supported source", () => {
    expect(getRegisteredSourceMetadata()).toEqual([
      {
        source: "claude-code",
        displayName: "Claude Code",
        standardPaths: ["~/.claude/projects/"],
      },
      {
        source: "codex-cli",
        displayName: "Codex CLI",
        standardPaths: ["~/.codex/sessions/"],
      },
    ]);
  });

  it("creates base clog directories and clogignore", async () => {
    await ensureClogHomeDirs();

    await expect(fs.stat(getClogHome())).resolves.toBeTruthy();
    await expect(fs.readFile(path.join(tempDir, "clogignore"), "utf8")).resolves.toBe("");
  });

  it("round-trips a saved config", async () => {
    const config = getDefaultConfig("alice");
    await saveConfig(config);

    const loaded = await loadConfig();
    expect(loaded).toEqual(config);
  });

  it("defaults the remote block to no-remote state", () => {
    const config = getDefaultConfig("alice");
    expect(config.remote).toEqual({
      url: null,
      allowPublicRemote: false,
      visibilityConfirmed: false,
      lastSyncHead: null,
    });
  });

  it("round-trips a configured remote block", async () => {
    const config = getDefaultConfig("alice");
    config.remote = {
      url: "git@github.com:myorg/clog-team.git",
      allowPublicRemote: false,
      visibilityConfirmed: true,
      lastSyncHead: "a1b2c3d4e5f6",
    };
    await saveConfig(config);

    const loaded = await loadConfig();
    expect(loaded.remote).toEqual(config.remote);
  });

  it("preserves the opt-in setting that indexes superseded branches", async () => {
    const config = getDefaultConfig("alice");
    config.search = {
      embedding: {
        type: "transformers",
        model: "Xenova/all-MiniLM-L6-v2",
      },
      vectorStore: { type: "vectra" },
      indexAllBranches: true,
    };
    await saveConfig(config);

    const loaded = await loadConfig();
    expect(loaded.search?.indexAllBranches).toBe(true);
  });
});
