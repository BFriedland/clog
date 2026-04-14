import { Command } from "commander";

import { loadConfig, saveConfig } from "../config/index.js";
import { getConfigPath } from "../utils/paths.js";

export function buildConfigCommand(): Command {
  const command = new Command("config").description("View or edit configuration");

  command
    .command("get")
    .argument("[key]")
    .action(async (key?: string) => {
      const config = await loadConfig();
      const value = key ? getNestedValue(config, key) : config;
      process.stdout.write(`${JSON.stringify(value, null, 2)}\n`);
    });

  command
    .command("set")
    .argument("<key>")
    .argument("<value>")
    .action(async (key: string, value: string) => {
      const config = await loadConfig();
      setNestedValue(config, key, parseConfigValue(value));
      await saveConfig(config);
      process.stdout.write(`Updated ${key} in ${getConfigPath()}\n`);
    });

  command.action(async () => {
    const config = await loadConfig();
    process.stdout.write(`${JSON.stringify(config, null, 2)}\n`);
  });

  return command;
}

function getNestedValue(value: unknown, key: string): unknown {
  return key.split(".").reduce((current, part) => {
    if (current && typeof current === "object" && part in current) {
      return (current as Record<string, unknown>)[part];
    }

    return undefined;
  }, value);
}

function setNestedValue(target: Record<string, unknown>, key: string, value: unknown): void {
  const parts = key.split(".");
  let current: Record<string, unknown> = target;

  for (const part of parts.slice(0, -1)) {
    if (!current[part] || typeof current[part] !== "object") {
      current[part] = {};
    }

    current = current[part] as Record<string, unknown>;
  }

  current[parts[parts.length - 1]!] = value;
}

function parseConfigValue(value: string): unknown {
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}
