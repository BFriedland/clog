import fs from "node:fs/promises";
import os from "node:os";

import { input as promptForInput } from "@inquirer/prompts";

import { getDefaultConfig, loadConfig, saveConfig } from "./index.js";
import { getClogHome, getConfigPath } from "../utils/paths.js";
import { pathExists } from "../utils/fs.js";

async function promptForAuthor(defaultAuthor: string): Promise<string> {
  const answer = await promptForInput({
    message: `Your name (used as the default author for conversations clog finds):`,
    default: defaultAuthor,
  });
  return answer.trim() || defaultAuthor;
}

export async function initializeClog(input: {
  interactive: boolean;
  forcePromptAuthor?: boolean;
}): Promise<{
  createdConfig: boolean;
}> {
  const { interactive, forcePromptAuthor = false } = input;
  const configPath = getConfigPath();
  const hasConfig = await pathExists(configPath);
  const osDefaultAuthor = os.userInfo().username;

  if (hasConfig) {
    const config = await loadConfig();

    if (!interactive || !forcePromptAuthor) {
      return { createdConfig: false };
    }

    const defaultAuthor = config.author.trim() || osDefaultAuthor;
    const author = await promptForAuthor(defaultAuthor);
    await saveConfig({
      ...config,
      author,
    });

    return { createdConfig: false };
  }

  const defaultAuthor = osDefaultAuthor;
  const author = interactive ? await promptForAuthor(defaultAuthor) : defaultAuthor;

  await saveConfig(getDefaultConfig(author));
  return { createdConfig: true };
}

export async function ensureClogHome({ interactive }: { interactive: boolean }): Promise<void> {
  await fs.mkdir(getClogHome(), { recursive: true });

  const { ensureClogHomeDirs } = await import("./index.js");
  await ensureClogHomeDirs();

  await initializeClog({ interactive });
}
