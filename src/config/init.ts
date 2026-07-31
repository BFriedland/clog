import fs from "node:fs/promises";
import os from "node:os";

import {
  checkbox as promptForCheckbox,
  input as promptForInput,
} from "@inquirer/prompts";

import { getDefaultConfig, loadConfig, saveConfig } from "./index.js";
import {
  getRegisteredSourceMetadata,
  type RegisteredSourceMetadata,
} from "../adapters/registry.js";
import { isReadableDirectory, pathExists } from "../utils/fs.js";
import {
  BUILTIN_SOURCES,
  type BuiltinSource,
  getClogHome,
  getConfigPath,
  normalizeUserPath,
} from "../utils/paths.js";
import type { Config } from "./schema.js";

async function promptForAuthor(defaultAuthor: string): Promise<string> {
  const answer = await promptForInput({
    message: `Your name (used as the default author for conversations clog finds):`,
    default: defaultAuthor,
  });
  return answer.trim() || defaultAuthor;
}

interface DetectedSourcePath {
  source: BuiltinSource;
  displayName: string;
  path: string;
}

interface SourcePathChoice extends DetectedSourcePath {
  checked: boolean;
}

async function listSourcePathChoices(
  sources: RegisteredSourceMetadata[],
  config: Config,
): Promise<SourcePathChoice[]> {
  const choices: SourcePathChoice[] = [];

  for (const source of sources) {
    const sourceConfig = config.sources[source.source];
    const configuredPaths = new Map<string, string>();

    for (const configuredPath of sourceConfig.paths) {
      const normalizedPath = normalizeUserPath(configuredPath);
      if (!configuredPaths.has(normalizedPath)) {
        configuredPaths.set(normalizedPath, configuredPath);
      }
    }

    for (const standardPath of source.standardPaths) {
      const normalizedPath = normalizeUserPath(standardPath);
      const configuredPath = configuredPaths.get(normalizedPath);
      if (
        configuredPath === undefined &&
        !(await isReadableDirectory(normalizedPath))
      ) {
        continue;
      }

      choices.push({
        source: source.source,
        displayName: source.displayName,
        path: configuredPath ?? standardPath,
        checked: sourceConfig.enabled && configuredPath !== undefined,
      });
      configuredPaths.delete(normalizedPath);
    }

    for (const configuredPath of configuredPaths.values()) {
      choices.push({
        source: source.source,
        displayName: source.displayName,
        path: configuredPath,
        checked: sourceConfig.enabled,
      });
    }
  }

  return choices;
}

async function selectSourcePaths(
  config: Config,
): Promise<DetectedSourcePath[] | null> {
  const choices = await listSourcePathChoices(
    getRegisteredSourceMetadata(),
    config,
  );
  if (choices.length === 0) {
    return null;
  }

  return promptForCheckbox<DetectedSourcePath>({
    message: "Which conversation directories may clog scan?",
    choices: choices.map((entry) => ({
      name: `${entry.displayName} — ${entry.path}`,
      value: {
        source: entry.source,
        displayName: entry.displayName,
        path: entry.path,
      },
      checked: entry.checked,
    })),
  });
}

function applySelectedSourcePaths(
  config: Config,
  selectedPaths: DetectedSourcePath[],
): void {
  for (const source of BUILTIN_SOURCES) {
    config.sources[source].enabled = false;
    config.sources[source].paths = [];
  }

  for (const selected of selectedPaths) {
    const sourceConfig = config.sources[selected.source];
    const normalizedSelectedPath = normalizeUserPath(selected.path);
    if (
      sourceConfig.paths.some(
        (configuredPath) =>
          normalizeUserPath(configuredPath) === normalizedSelectedPath,
      )
    ) {
      continue;
    }
    sourceConfig.enabled = true;
    sourceConfig.paths.push(selected.path);
  }
}

export async function initializeClog(input: {
  interactive: boolean;
  rerunSetup?: boolean;
}): Promise<{
  createdConfig: boolean;
}> {
  const { interactive, rerunSetup = false } = input;
  const configPath = getConfigPath();
  const hasConfig = await pathExists(configPath);
  const osDefaultAuthor = os.userInfo().username;

  if (hasConfig) {
    const config = await loadConfig();

    if (!interactive || !rerunSetup) {
      return { createdConfig: false };
    }

    const defaultAuthor = config.author.trim() || osDefaultAuthor;
    const author = await promptForAuthor(defaultAuthor);
    const selectedPaths = await selectSourcePaths(config);
    if (selectedPaths !== null) {
      applySelectedSourcePaths(config, selectedPaths);
    }
    await saveConfig({
      ...config,
      author,
    });

    return { createdConfig: false };
  }

  const defaultAuthor = osDefaultAuthor;
  const author = interactive ? await promptForAuthor(defaultAuthor) : defaultAuthor;
  const config = getDefaultConfig(author);

  if (interactive) {
    const selectedPaths = await selectSourcePaths(config);
    if (selectedPaths !== null) {
      applySelectedSourcePaths(config, selectedPaths);
    }
  }

  await saveConfig(config);
  return { createdConfig: true };
}

export async function ensureClogHome({ interactive }: { interactive: boolean }): Promise<void> {
  await fs.mkdir(getClogHome(), { recursive: true });

  const { ensureClogHomeDirs } = await import("./index.js");
  await ensureClogHomeDirs();

  await initializeClog({ interactive });
}
