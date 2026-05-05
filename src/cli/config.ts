import { Command } from "commander";
import { z } from "zod";

import { loadConfig, saveConfig } from "../config/index.js";
import { parseConfig, type Config } from "../config/schema.js";
import { ClogError } from "../utils/errors.js";
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
      const supplied = parseConfigValue(value);
      setNestedValue(config, key, supplied);

      let validated: Config;
      try {
        validated = parseConfig(config);
      } catch (error) {
        if (error instanceof z.ZodError) {
          throw new ClogError(formatZodIssue(key, error));
        }
        throw error;
      }

      // The schema strips unknown keys silently. Catch both the bare-typo
      // case ("authore" at the top level) and the nested-typo case
      // (`set remote '{"urll": "..."}'` — `remote` still resolves but `urll`
      // is gone) by walking what the user supplied against what zod kept.
      const stripped = findStrippedPath(supplied, getNestedValue(validated, key), [key]);
      if (stripped) {
        throw new ClogError(
          `Unknown config key "${stripped.join(".")}". Run \`clog config get\` to see the available keys.`,
        );
      }

      await saveConfig(validated);
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

function formatZodIssue(key: string, error: z.ZodError): string {
  const issue = error.issues[0];
  if (!issue) {
    return `Invalid value for "${key}".`;
  }
  const path = issue.path.length > 0 ? issue.path.join(".") : key;
  return `Invalid value for "${path}": ${issue.message}.`;
}

// Returns the first path (relative to the original `key`) where the user's
// supplied value has a key that zod silently stripped. Arrays and primitives
// are validated by zod's type checks, so we only descend through plain objects.
function findStrippedPath(
  supplied: unknown,
  parsed: unknown,
  pathPrefix: string[],
): string[] | null {
  if (parsed === undefined) {
    return pathPrefix;
  }
  if (!isPlainObject(supplied) || !isPlainObject(parsed)) {
    return null;
  }
  for (const key of Object.keys(supplied)) {
    const sub = findStrippedPath(supplied[key], parsed[key], [...pathPrefix, key]);
    if (sub) return sub;
  }
  return null;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
