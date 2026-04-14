import fs from "node:fs/promises";
import path from "node:path";

import { getClogIgnorePath, normalizeUserPath } from "../utils/paths.js";

export type ClogIgnoreRule =
  | { kind: "project"; pattern: string; hasGlob: boolean }
  | { kind: "before"; date: string }
  | { kind: "after"; date: string };

export async function readClogIgnoreRules(): Promise<ClogIgnoreRule[]> {
  const filePath = getClogIgnorePath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter((line) => line && !line.startsWith("#"))
      .map(parseRule)
      .filter((rule): rule is ClogIgnoreRule => rule !== null);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export function matchesClogIgnoreRule(
  rule: ClogIgnoreRule,
  args: { projectPath: string; createdAt: string },
): boolean {
  if (rule.kind === "project") {
    const normalizedProjectPath = normalizeUserPath(args.projectPath);

    if (!rule.hasGlob) {
      return pathMatchesBoundary(normalizedProjectPath, rule.pattern);
    }

    return globLikeMatch(normalizedProjectPath, rule.pattern);
  }

  if (rule.kind === "before") {
    return args.createdAt < rule.date;
  }

  return args.createdAt > rule.date;
}

export function pathMatchesBoundary(projectPath: string, configuredPath: string): boolean {
  const normalizedProjectPath = normalizeUserPath(projectPath);
  const normalizedConfiguredPath = normalizeUserPath(configuredPath);

  if (normalizedProjectPath === normalizedConfiguredPath) {
    return true;
  }

  const withSeparator = normalizedConfiguredPath.endsWith(path.sep)
    ? normalizedConfiguredPath
    : `${normalizedConfiguredPath}${path.sep}`;

  return normalizedProjectPath.startsWith(withSeparator);
}

function parseRule(line: string): ClogIgnoreRule | null {
  if (line.startsWith("project:")) {
    const pattern = normalizeUserPath(line.slice("project:".length));
    return {
      kind: "project",
      pattern,
      hasGlob: pattern.includes("*"),
    };
  }

  if (line.startsWith("before:")) {
    return {
      kind: "before",
      date: line.slice("before:".length),
    };
  }

  if (line.startsWith("after:")) {
    return {
      kind: "after",
      date: line.slice("after:".length),
    };
  }

  return null;
}

function globLikeMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
  return regex.test(value);
}
