import { readFile } from "node:fs/promises";
import os from "node:os";
import { getClogignorePath } from "../config/index.js";
import type { DiscoveredConversation } from "../models/conversation.js";

export interface ClogignoreRule {
  type: "project" | "before" | "after";
  value: string;
}

export interface ClogignoreRules {
  rules: ClogignoreRule[];
}

export async function loadClogignore(): Promise<ClogignoreRules> {
  const filePath = getClogignorePath();
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return { rules: [] };
    }
    throw err;
  }

  const rules: ClogignoreRule[] = [];

  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line || line.startsWith("#")) continue;

    if (line.startsWith("project:")) {
      rules.push({ type: "project", value: line.slice("project:".length) });
    } else if (line.startsWith("before:")) {
      rules.push({ type: "before", value: line.slice("before:".length) });
    } else if (line.startsWith("after:")) {
      rules.push({ type: "after", value: line.slice("after:".length) });
    }
  }

  return { rules };
}

export function matchesClogignore(
  rules: ClogignoreRules,
  conversation: DiscoveredConversation
): boolean {
  for (const rule of rules.rules) {
    if (rule.type === "project") {
      const project = conversation.metadata.project;
      if (project && globMatch(rule.value, project)) {
        return true;
      }
    } else if (rule.type === "before") {
      const createdAt = conversation.metadata.createdAt;
      if (createdAt && createdAt < rule.value) {
        return true;
      }
    } else if (rule.type === "after") {
      const createdAt = conversation.metadata.createdAt;
      if (createdAt && createdAt > rule.value) {
        return true;
      }
    }
  }
  return false;
}

/**
 * Simple glob matching supporting `*` wildcards.
 * The pattern and value both have `~` expanded to the home directory.
 */
function globMatch(pattern: string, value: string): boolean {
  const home = os.homedir();
  const expandedPattern = pattern.startsWith("~")
    ? home + pattern.slice(1)
    : pattern;
  const expandedValue = value.startsWith("~")
    ? home + value.slice(1)
    : value;

  // Convert glob pattern to regex: escape special regex chars, replace * with .*
  const escaped = expandedPattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*");
  const regex = new RegExp(`^${escaped}$`);
  return regex.test(expandedValue);
}
