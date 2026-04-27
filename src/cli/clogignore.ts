import fs from "node:fs/promises";
import path from "node:path";

import type { ConversationMeta } from "../models/conversation.js";
import { getClogIgnorePath, normalizeUserPath } from "../utils/paths.js";

export interface ClogIgnoreLine {
  raw: string;
  trimmed: string;
  lineNumber: number;
}

interface IgnoreMatchTarget {
  sourceId: string;
  projectName: string | null;
  projectPath: string | null;
  sourcePath: string;
}

export async function readClogIgnoreLines(): Promise<ClogIgnoreLine[]> {
  const filePath = getClogIgnorePath();

  try {
    const raw = await fs.readFile(filePath, "utf8");
    return raw
      .split(/\r?\n/)
      .map((line, index) => ({
        raw: line,
        trimmed: line.trim(),
        lineNumber: index + 1,
      }))
      .filter((line) => line.trimmed !== "" && !line.trimmed.startsWith("#"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    throw error;
  }
}

export async function readClogIgnoreRules(): Promise<string[]> {
  return (await readClogIgnoreLines()).map((line) => line.trimmed);
}

export async function appendClogIgnoreRules(rules: string[]): Promise<void> {
  if (rules.length === 0) {
    return;
  }

  const filePath = getClogIgnorePath();
  const existing = await readFileOrEmpty(filePath);
  const prefix = existing.length > 0 && !existing.endsWith("\n") ? "\n" : "";
  await fs.writeFile(filePath, `${existing}${prefix}${rules.join("\n")}\n`, "utf8");
}

export async function removeExactClogIgnoreRules(rules: string[]): Promise<{
  removed: string[];
  changed: boolean;
}> {
  const filePath = getClogIgnorePath();
  const raw = await readFileOrEmpty(filePath);
  const lines = raw.length === 0 ? [] : raw.split(/\r?\n/);
  const wanted = new Set(rules);
  const removed: string[] = [];
  const kept: string[] = [];

  for (const line of lines) {
    if (wanted.has(line)) {
      removed.push(line);
      continue;
    }
    kept.push(line);
  }

  while (kept.length > 0 && kept[kept.length - 1] === "") {
    kept.pop();
  }

  if (removed.length > 0) {
    const next = kept.length > 0 ? `${kept.join("\n")}\n` : "";
    await fs.writeFile(filePath, next, "utf8");
  }

  return {
    removed,
    changed: removed.length > 0,
  };
}

export function matchesClogIgnoreRule(
  rule: string,
  target: IgnoreMatchTarget,
): boolean {
  const trimmed = rule.trim();
  if (trimmed === "") {
    return false;
  }

  if (!isRecognizedClogIgnoreRule(trimmed)) {
    return false;
  }

  if (isPathLikeRule(trimmed)) {
    return matchesPathLikeRule(trimmed, target);
  }

  if (path.basename(target.sourcePath) === trimmed) {
    return true;
  }

  if (isUuidLike(trimmed)) {
    return target.sourceId === trimmed;
  }

  if (isShortIdLike(trimmed)) {
    return target.sourceId.startsWith(trimmed);
  }

  return matchesSimpleNameRule(trimmed, target);
}

export function matchesRemoteClogIgnoreRule(
  rule: string,
  target: Pick<IgnoreMatchTarget, "sourceId" | "projectName">,
): boolean {
  const trimmed = rule.trim();
  if (trimmed === "") {
    return false;
  }

  if (!isRecognizedClogIgnoreRule(trimmed)) {
    return false;
  }

  if (isPathLikeRule(trimmed)) {
    return false;
  }

  if (isUuidLike(trimmed)) {
    return target.sourceId === trimmed;
  }

  if (isShortIdLike(trimmed)) {
    return target.sourceId.startsWith(trimmed);
  }

  return target.projectName?.toLowerCase() === trimmed.toLowerCase();
}

export function conversationMatchesAnyClogIgnoreRule(
  conversation: Pick<
    ConversationMeta,
    "sourceId" | "projectName" | "projectPath" | "sourcePath"
  >,
  rules: string[],
): boolean {
  return rules.some((rule) =>
    matchesClogIgnoreRule(rule, {
      sourceId: conversation.sourceId,
      projectName: conversation.projectName,
      projectPath: conversation.projectPath,
      sourcePath: conversation.sourcePath,
    }),
  );
}

export function isRecognizedClogIgnoreRule(rule: string): boolean {
  const trimmed = rule.trim();

  if (trimmed === "") {
    return false;
  }

  if (trimmed.startsWith("project:") || trimmed.startsWith("before:") || trimmed.startsWith("after:")) {
    return false;
  }

  return true;
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

function matchesPathLikeRule(
  rule: string,
  target: Pick<IgnoreMatchTarget, "projectPath" | "sourcePath">,
): boolean {
  const normalizedRule = normalizeUserPath(rule);
  const candidates = [target.projectPath, target.sourcePath].filter(
    (value): value is string => value != null && value !== "",
  );

  return candidates.some((candidate) =>
    normalizedRule.includes("*")
      ? globLikeMatch(normalizeUserPath(candidate), normalizedRule)
      : pathMatchesBoundary(candidate, normalizedRule),
  );
}

function matchesSimpleNameRule(
  rule: string,
  target: Pick<IgnoreMatchTarget, "projectName" | "projectPath" | "sourcePath">,
): boolean {
  const lowered = rule.toLowerCase();

  if (target.projectName?.toLowerCase() === lowered) {
    return true;
  }

  return gatherSimpleNameCandidates(target).some((candidate) => candidate.toLowerCase() === lowered);
}

function gatherSimpleNameCandidates(
  target: Pick<IgnoreMatchTarget, "projectPath" | "sourcePath">,
): string[] {
  const values = new Set<string>();

  for (const filePath of [target.projectPath, target.sourcePath]) {
    if (!filePath) {
      continue;
    }

    for (const component of normalizeUserPath(filePath).split(path.sep)) {
      if (component) {
        values.add(component);
      }
    }

    const basename = path.basename(filePath);
    if (basename) {
      values.add(basename);
    }
  }

  return [...values];
}

function isPathLikeRule(rule: string): boolean {
  return rule.startsWith("~") || /[\\/]/.test(rule);
}

function isUuidLike(rule: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(rule);
}

function isShortIdLike(rule: string): boolean {
  return /^[0-9a-f]{4,}$/i.test(rule);
}

function globLikeMatch(value: string, pattern: string): boolean {
  const escaped = pattern.replaceAll(/[.+?^${}()|[\]\\]/g, "\\$&");
  const regex = new RegExp(`^${escaped.replaceAll("*", ".*")}$`);
  return regex.test(value);
}

async function readFileOrEmpty(filePath: string): Promise<string> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return "";
    }
    throw error;
  }
}
