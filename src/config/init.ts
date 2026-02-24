import { mkdir, access, readFile } from "node:fs/promises";
import path from "node:path";
import { createInterface } from "node:readline";
import os from "node:os";
import { getClogHome, getRawDir, getConfigPath } from "./index.js";
import { defaultConfig, saveConfig, loadConfig } from "./schema.js";

export async function ensureClogHome(): Promise<void> {
  const home = getClogHome();
  await mkdir(home, { recursive: true });
  await mkdir(getRawDir(), { recursive: true });
  await mkdir(path.join(getRawDir(), "claude-code"), { recursive: true });

  // Ensure config.json exists
  try {
    await access(getConfigPath());
  } catch {
    await saveConfig(defaultConfig());
  }
}

export async function healthCheck(): Promise<{
  ok: boolean;
  errors: string[];
}> {
  const errors: string[] = [];

  // Check clog home exists
  try {
    await access(getClogHome());
  } catch {
    errors.push(`CLOG_HOME directory missing: ${getClogHome()}`);
    return { ok: false, errors };
  }

  // Check config.json is valid
  try {
    const configPath = getConfigPath();
    const raw = await readFile(configPath, "utf-8");
    JSON.parse(raw);
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      errors.push("config.json is missing. Run `clog init` to create it.");
    } else if (err instanceof SyntaxError) {
      errors.push(
        "config.json contains invalid JSON. Back it up and run `clog init` to recreate it."
      );
    } else {
      errors.push(`Error reading config.json: ${err}`);
    }
  }

  // Check raw dir exists
  try {
    await access(getRawDir());
  } catch {
    errors.push(`Raw directory missing: ${getRawDir()}`);
  }

  return { ok: errors.length === 0, errors };
}

function prompt(question: string): Promise<string> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

export async function initInteractive(): Promise<void> {
  // Check if this is a fresh setup before ensureClogHome creates defaults
  let needsSetup = false;
  try {
    await access(getConfigPath());
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === "ENOENT") {
      needsSetup = true;
    } else {
      throw err;
    }
  }

  await ensureClogHome();

  if (needsSetup) {
    if (process.stdin.isTTY) {
      console.log("No config found. Running clog init...");
    }

    const config = await loadConfig();
    const defaultName = os.userInfo().username || "unknown";

    if (process.stdin.isTTY) {
      const name = await prompt(
        `Your name (used to tag published conversations) [${defaultName}]: `
      );
      config.author = name || defaultName;
    } else {
      config.author = defaultName;
    }

    await saveConfig(config);
  }

  console.log(`Initialized clog at ${getClogHome()}`);
}
