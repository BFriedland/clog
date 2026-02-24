import chalk from "chalk";
import { loadConfig, saveConfig } from "../config/schema.js";

export async function configCommand(
  action?: string,
  key?: string,
  value?: string
): Promise<void> {
  const config = await loadConfig();

  // No args: display full config
  if (!action) {
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  if (action === "get") {
    if (!key) {
      console.log(chalk.red("Usage: clog config get <key>"));
      return;
    }
    const val = getNestedValue(config, key);
    if (val === undefined) {
      console.log(chalk.red(`Key "${key}" not found in config.`));
      return;
    }
    if (typeof val === "object" && val !== null) {
      console.log(JSON.stringify(val, null, 2));
    } else {
      console.log(String(val));
    }
    return;
  }

  if (action === "set") {
    if (!key || value === undefined) {
      console.log(chalk.red("Usage: clog config set <key> <value>"));
      return;
    }
    const parsed = parseValue(value);
    setNestedValue(config, key, parsed);
    await saveConfig(config);
    const display = typeof parsed === "object" ? JSON.stringify(parsed) : String(parsed);
    console.log(chalk.green("Set") + ` ${chalk.cyan(key)} = ${chalk.white(display)}`);
    return;
  }

  console.log(chalk.red(`Unknown config action: ${action}`));
  console.log("Usage: clog config [get <key> | set <key> <value>]");
}

function getNestedValue(obj: Record<string, unknown>, path: string): unknown {
  const keys = path.split(".");
  let current: unknown = obj;
  for (const k of keys) {
    if (current === null || current === undefined || typeof current !== "object") {
      return undefined;
    }
    current = (current as Record<string, unknown>)[k];
  }
  return current;
}

function setNestedValue(
  obj: Record<string, unknown>,
  path: string,
  value: unknown
): void {
  const keys = path.split(".");
  let current: Record<string, unknown> = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    const k = keys[i];
    if (
      current[k] === null ||
      current[k] === undefined ||
      typeof current[k] !== "object"
    ) {
      current[k] = {};
    }
    current = current[k] as Record<string, unknown>;
  }
  current[keys[keys.length - 1]] = value;
}

function parseValue(value: string): unknown {
  // Try JSON first — handles arrays, objects, booleans, numbers, null
  try {
    return JSON.parse(value);
  } catch {
    // Fall through to string
  }

  return value;
}
