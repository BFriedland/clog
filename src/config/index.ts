import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { ClogError } from "../utils/errors.js";
import {
  BUILTIN_SOURCES,
  getClogHome,
  getClogIgnorePath,
  getConfigPath,
  getDefaultSourcePaths,
  getImportsRoot,
  getRawRoot,
  normalizeUserPath,
} from "../utils/paths.js";
import { pathExists } from "../utils/fs.js";
import { type Config, configSchema, parseConfig } from "./schema.js";

function defaultSourceConfig(source: (typeof BUILTIN_SOURCES)[number]) {
  return {
    enabled: true,
    paths: getDefaultSourcePaths(source),
    includePaths: [],
    excludePaths: [],
  };
}

export function getDefaultConfig(author = ""): Config {
  return configSchema.parse({
    author,
    sources: {
      "claude-code": defaultSourceConfig("claude-code"),
      "codex-cli": defaultSourceConfig("codex-cli"),
    },
    defaultTags: [],
    autoScan: false,
    search: null,
  });
}

export async function loadConfig(): Promise<Config> {
  const configPath = getConfigPath();

  try {
    const raw = await fs.readFile(configPath, "utf8");
    return parseConfig(JSON.parse(raw));
  } catch (error) {
    if (error instanceof SyntaxError) {
      throw new ClogError(
        `Config file is invalid JSON: ${configPath}. Fix it or run "clog init" to recreate it.`,
      );
    }

    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return getDefaultConfig();
    }

    if (error instanceof z.ZodError) {
      throw new ClogError(
        `Config file is invalid: ${configPath}. Fix it or run "clog init" to recreate it.`,
      );
    }

    throw error;
  }
}

export async function saveConfig(config: Config): Promise<void> {
  const configPath = getConfigPath();
  await fs.mkdir(path.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

export function resolveConfiguredPaths(paths: string[]): string[] {
  return paths.map((entry) => normalizeUserPath(entry));
}

export async function ensureClogHomeDirs(): Promise<void> {
  await fs.mkdir(getClogHome(), { recursive: true });
  await fs.mkdir(getRawRoot(), { recursive: true });
  await fs.mkdir(getImportsRoot(), { recursive: true });

  const clogIgnorePath = getClogIgnorePath();
  if (!(await pathExists(clogIgnorePath))) {
    await fs.writeFile(clogIgnorePath, "", "utf8");
  }
}
