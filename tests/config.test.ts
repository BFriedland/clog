import path from "node:path";
import { mkdir, readFile } from "node:fs/promises";
import { createTestEnv, type TestEnv } from "./helpers/test-env.js";
import { getClogHome, getDbPath, getRawDir, getConfigPath } from "../src/config/index.js";
import {
  ConfigSchema,
  defaultConfig,
  loadConfig,
  saveConfig,
} from "../src/config/schema.js";

let env: TestEnv;

beforeEach(async () => {
  env = await createTestEnv();
});

afterEach(async () => {
  await env.cleanup();
});

describe("Config path resolution", () => {
  it("uses CLOG_HOME env var for getClogHome", () => {
    expect(getClogHome()).toBe(env.clogHome);
  });

  it("uses CLOG_HOME for getDbPath", () => {
    expect(getDbPath()).toBe(path.join(env.clogHome, "clog.db"));
  });

  it("uses CLOG_HOME for getRawDir", () => {
    expect(getRawDir()).toBe(path.join(env.clogHome, "raw"));
  });

  it("uses CLOG_HOME for getConfigPath", () => {
    expect(getConfigPath()).toBe(path.join(env.clogHome, "config.json"));
  });
});

describe("Default config", () => {
  it("has expected defaults", () => {
    const cfg = defaultConfig();
    expect(cfg.author).toBe("");
    expect(cfg.autoScan).toBe(false);
    expect(cfg.defaultTags).toEqual([]);
    expect(cfg.remote).toBeNull();
    expect(cfg.sources["claude-code"].enabled).toBe(true);
    expect(cfg.sources["claude-code"].paths).toEqual([]);
    expect(cfg.sources["claude-code"].includePaths).toEqual([]);
    expect(cfg.sources["claude-code"].excludePaths).toEqual([]);
    expect(cfg.sources["codex-cli"].enabled).toBe(false);
  });
});

describe("Schema validation", () => {
  it("accepts a valid config", () => {
    const result = ConfigSchema.safeParse({
      author: "alice",
      autoScan: true,
      defaultTags: ["work"],
      sources: {
        "claude-code": { enabled: true, paths: ["/some/path"] },
        "codex-cli": { enabled: false },
      },
    });
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe("alice");
      expect(result.data.autoScan).toBe(true);
      expect(result.data.defaultTags).toEqual(["work"]);
    }
  });

  it("rejects invalid config (author must be string)", () => {
    const result = ConfigSchema.safeParse({ author: 42 });
    expect(result.success).toBe(false);
  });

  it("rejects invalid config (autoScan must be boolean)", () => {
    const result = ConfigSchema.safeParse({ autoScan: "yes" });
    expect(result.success).toBe(false);
  });

  it("applies defaults for missing fields", () => {
    const result = ConfigSchema.safeParse({});
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.author).toBe("");
      expect(result.data.sources["claude-code"].enabled).toBe(true);
    }
  });
});

describe("loadConfig", () => {
  it("returns defaults when no config file exists", async () => {
    const cfg = await loadConfig();
    expect(cfg.author).toBe("");
    expect(cfg.autoScan).toBe(false);
    expect(cfg.defaultTags).toEqual([]);
  });
});

describe("saveConfig + loadConfig round-trip", () => {
  it("saves and loads config correctly", async () => {
    await mkdir(env.clogHome, { recursive: true });

    const cfg = defaultConfig();
    cfg.author = "testuser";
    cfg.defaultTags = ["review", "debug"];
    cfg.autoScan = true;

    await saveConfig(cfg);

    const loaded = await loadConfig();
    expect(loaded.author).toBe("testuser");
    expect(loaded.defaultTags).toEqual(["review", "debug"]);
    expect(loaded.autoScan).toBe(true);
    expect(loaded.sources["claude-code"].enabled).toBe(true);
  });

  it("persists as valid JSON on disk", async () => {
    await mkdir(env.clogHome, { recursive: true });

    const cfg = defaultConfig();
    cfg.author = "bob";
    await saveConfig(cfg);

    const raw = await readFile(getConfigPath(), "utf-8");
    const parsed = JSON.parse(raw);
    expect(parsed.author).toBe("bob");
  });
});
