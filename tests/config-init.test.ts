import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@inquirer/prompts", () => ({
  checkbox: vi.fn(),
  input: vi.fn(),
}));

const promptsModule = await import("@inquirer/prompts");
const mockedPromptForCheckbox = vi.mocked(promptsModule.checkbox);
const mockedPromptForInput = vi.mocked(promptsModule.input);

import * as adapterRegistry from "../src/adapters/registry.js";
import { loadConfig, saveConfig } from "../src/config/index.js";
import { initializeClog } from "../src/config/init.js";

describe("initial source setup", () => {
  let tempDir: string;
  let claudePath: string;
  let codexPath: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-config-init-"));
    process.env.CLOG_HOME = path.join(tempDir, ".clog");
    claudePath = path.join(tempDir, "claude-conversations");
    codexPath = path.join(tempDir, "codex-conversations");

    vi.spyOn(adapterRegistry, "getRegisteredSourceMetadata").mockReturnValue([
      {
        source: "claude-code",
        displayName: "Claude Code",
        standardPaths: [claudePath],
      },
      {
        source: "codex-cli",
        displayName: "Codex CLI",
        standardPaths: [codexPath],
      },
    ]);
    mockedPromptForInput.mockResolvedValue("alice");
    mockedPromptForCheckbox.mockResolvedValue([]);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("offers every detected source path in one unselected multi-select prompt", async () => {
    await fs.mkdir(claudePath, { recursive: true });
    await fs.mkdir(codexPath, { recursive: true });
    mockedPromptForCheckbox.mockResolvedValue([
      {
        source: "claude-code",
        displayName: "Claude Code",
        path: claudePath,
      },
      {
        source: "codex-cli",
        displayName: "Codex CLI",
        path: codexPath,
      },
    ]);

    await initializeClog({ interactive: true });

    expect(mockedPromptForCheckbox).toHaveBeenCalledWith({
      message: "Which conversation directories may clog scan?",
      choices: [
        {
          name: `Claude Code — ${claudePath}`,
          value: {
            source: "claude-code",
            displayName: "Claude Code",
            path: claudePath,
          },
          checked: false,
        },
        {
          name: `Codex CLI — ${codexPath}`,
          value: {
            source: "codex-cli",
            displayName: "Codex CLI",
            path: codexPath,
          },
          checked: false,
        },
      ],
    });
    const config = await loadConfig();
    expect(config.sources["claude-code"]).toMatchObject({
      enabled: true,
      paths: [claudePath],
    });
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: true,
      paths: [codexPath],
    });
  });

  it("offers only readable detected paths and leaves unselected sources disabled", async () => {
    await fs.mkdir(claudePath, { recursive: true });

    await initializeClog({ interactive: true });

    expect(mockedPromptForCheckbox).toHaveBeenCalledWith({
      message: "Which conversation directories may clog scan?",
      choices: [
        {
          name: `Claude Code — ${claudePath}`,
          value: {
            source: "claude-code",
            displayName: "Claude Code",
            path: claudePath,
          },
          checked: false,
        },
      ],
    });
    const config = await loadConfig();
    expect(config.sources["claude-code"]).toMatchObject({
      enabled: false,
      paths: [],
    });
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: false,
      paths: [],
    });
  });

  it("enables only the selected subset of detected paths", async () => {
    await fs.mkdir(claudePath, { recursive: true });
    await fs.mkdir(codexPath, { recursive: true });
    mockedPromptForCheckbox.mockResolvedValue([
      {
        source: "codex-cli",
        displayName: "Codex CLI",
        path: codexPath,
      },
    ]);

    await initializeClog({ interactive: true });

    const config = await loadConfig();
    expect(config.sources["claude-code"]).toMatchObject({
      enabled: false,
      paths: [],
    });
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: true,
      paths: [codexPath],
    });
  });

  it("skips source selection when no registered path is detected", async () => {
    await initializeClog({ interactive: true });

    expect(mockedPromptForCheckbox).not.toHaveBeenCalled();
    const config = await loadConfig();
    expect(config.sources["claude-code"].enabled).toBe(false);
    expect(config.sources["codex-cli"].enabled).toBe(false);
    await expect(fs.stat(claudePath)).rejects.toMatchObject({ code: "ENOENT" });
    await expect(fs.stat(codexPath)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("leaves detected sources disabled during noninteractive setup", async () => {
    await fs.mkdir(claudePath, { recursive: true });
    await fs.mkdir(codexPath, { recursive: true });

    await initializeClog({ interactive: false });

    expect(mockedPromptForInput).not.toHaveBeenCalled();
    expect(mockedPromptForCheckbox).not.toHaveBeenCalled();
    const config = await loadConfig();
    expect(config.sources["claude-code"]).toMatchObject({
      enabled: false,
      paths: [],
    });
    expect(config.sources["codex-cli"]).toMatchObject({
      enabled: false,
      paths: [],
    });
  });

  it("preserves existing source choices during routine initialization", async () => {
    const existing = await loadConfig();
    existing.author = "stored-author";
    existing.sources["claude-code"] = {
      enabled: true,
      paths: ["/custom/claude"],
      includePaths: [],
      excludePaths: [],
    };
    await saveConfig(existing);
    await fs.mkdir(claudePath, { recursive: true });

    await initializeClog({ interactive: true });

    expect(mockedPromptForInput).not.toHaveBeenCalled();
    expect(mockedPromptForCheckbox).not.toHaveBeenCalled();
    const config = await loadConfig();
    expect(config.sources["claude-code"]).toEqual({
      enabled: true,
      paths: ["/custom/claude"],
      includePaths: [],
      excludePaths: [],
    });
  });

  it("reopens source selection during explicit setup with enabled paths selected", async () => {
    const customPath = path.join(tempDir, "custom-claude");
    const existing = await loadConfig();
    existing.author = "stored-author";
    existing.sources["claude-code"] = {
      enabled: true,
      paths: [customPath],
      includePaths: [],
      excludePaths: [],
    };
    await saveConfig(existing);
    await fs.mkdir(claudePath, { recursive: true });
    mockedPromptForCheckbox.mockResolvedValue([
      {
        source: "claude-code",
        displayName: "Claude Code",
        path: customPath,
      },
    ]);

    await initializeClog({ interactive: true, rerunSetup: true });

    expect(mockedPromptForCheckbox).toHaveBeenCalledWith({
      message: "Which conversation directories may clog scan?",
      choices: [
        {
          name: `Claude Code — ${claudePath}`,
          value: {
            source: "claude-code",
            displayName: "Claude Code",
            path: claudePath,
          },
          checked: false,
        },
        {
          name: `Claude Code — ${customPath}`,
          value: {
            source: "claude-code",
            displayName: "Claude Code",
            path: customPath,
          },
          checked: true,
        },
      ],
    });
    const config = await loadConfig();
    expect(config.sources["claude-code"]).toEqual({
      enabled: true,
      paths: [customPath],
      includePaths: [],
      excludePaths: [],
    });
  });

  it("disables a source when explicit setup clears its selected paths", async () => {
    const existing = await loadConfig();
    existing.sources["claude-code"] = {
      enabled: true,
      paths: [claudePath],
      includePaths: [],
      excludePaths: [],
    };
    await saveConfig(existing);
    await fs.mkdir(claudePath, { recursive: true });

    await initializeClog({ interactive: true, rerunSetup: true });

    const config = await loadConfig();
    expect(config.sources["claude-code"]).toEqual({
      enabled: false,
      paths: [],
      includePaths: [],
      excludePaths: [],
    });
  });
});
