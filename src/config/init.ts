import fs from "node:fs/promises";
import os from "node:os";
import readline from "node:readline/promises";

import { stdin as input, stdout as output } from "node:process";

import { getDefaultConfig, loadConfig, saveConfig } from "./index.js";
import { getClogHome, getConfigPath } from "../utils/paths.js";
import { pathExists } from "../utils/fs.js";

async function promptForAuthor(defaultAuthor: string): Promise<string> {
  const rl = readline.createInterface({ input, output });

  try {
    const answer = await rl.question(
      `Your name (used as the default author for new local discoveries) [${defaultAuthor}]: `,
    );
    return answer.trim() || defaultAuthor;
  } finally {
    rl.close();
  }
}

export async function initializeClog({ interactive }: { interactive: boolean }): Promise<{
  createdConfig: boolean;
}> {
  const configPath = getConfigPath();
  const hasConfig = await pathExists(configPath);

  if (hasConfig) {
    await loadConfig();
    return { createdConfig: false };
  }

  const defaultAuthor = os.userInfo().username;
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
