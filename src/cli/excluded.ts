import fs from "node:fs/promises";

import type { ClogWarning } from "../models/warnings.js";
import { getExcludedPath } from "../utils/paths.js";

export interface ExcludedEntry {
  id: string;
  source: string;
  lineNumber: number;
}

export interface ReadExcludedResult {
  entries: ExcludedEntry[];
  warnings: ClogWarning[];
}

export interface InvalidExcludedLine {
  lineNumber: number;
  content: string;
}

export async function readExcludedEntries(): Promise<ReadExcludedResult> {
  const filePath = getExcludedPath();
  let raw = "";

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [], warnings: [] };
    }

    throw error;
  }

  const warnings: ClogWarning[] = [];
  const entries: ExcludedEntry[] = [];
  const seen = new Set<string>();

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const parsed = parseExcludedEntry(trimmed);
    if (!parsed) {
      warnings.push({
        code: "invalid_excluded_file",
        message: `Invalid excluded-file entry at line ${index + 1}.`,
        path: filePath,
        guidance: 'Expected "sourceId@source".',
      });
      continue;
    }

    const key = `${parsed.id}@${parsed.source}`;
    if (seen.has(key)) {
      warnings.push({
        code: "duplicate_excluded_entry",
        message: `Duplicate excluded entry "${key}" at line ${index + 1}.`,
        path: filePath,
      });
      continue;
    }

    seen.add(key);
    entries.push({
      ...parsed,
      lineNumber: index + 1,
    });
  }

  return { entries, warnings };
}

export async function readExcludedEntriesForMutation(): Promise<{
  entries: ExcludedEntry[];
}> {
  const filePath = getExcludedPath();
  let raw = "";

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { entries: [] };
    }

    throw error;
  }

  const entries: ExcludedEntry[] = [];
  const invalidLines: InvalidExcludedLine[] = [];
  const seen = new Set<string>();

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    const parsed = parseExcludedEntry(trimmed);
    if (!parsed) {
      invalidLines.push({
        lineNumber: index + 1,
        content: line,
      });
      continue;
    }

    const key = `${parsed.id}@${parsed.source}`;
    if (seen.has(key)) {
      invalidLines.push({
        lineNumber: index + 1,
        content: line,
      });
      continue;
    }

    seen.add(key);
    entries.push({
      ...parsed,
      lineNumber: index + 1,
    });
  }

  if (invalidLines.length > 0) {
    const details = invalidLines
      .map((line) => `line ${line.lineNumber}: ${line.content}`)
      .join("; ");
    throw new Error(
      `Excluded file is invalid. Fix these entries first (${details}). Expected "sourceId@source".`,
    );
  }

  return { entries };
}

export function isExcluded(
  entries: ExcludedEntry[],
  id: string,
  source: string,
): boolean {
  return entries.some((entry) => entry.id === id && entry.source === source);
}

export async function writeExcludedEntries(entries: ExcludedEntry[]): Promise<void> {
  const filePath = getExcludedPath();
  const content = entries
    .map((entry) => `${entry.id}@${entry.source}`)
    .join("\n");

  await fs.writeFile(filePath, content ? `${content}\n` : "", "utf8");
}

export function addExcludedEntry(
  entries: ExcludedEntry[],
  id: string,
  source: string,
): ExcludedEntry[] {
  if (isExcluded(entries, id, source)) {
    return entries;
  }

  return [...entries, { id, source, lineNumber: 0 }];
}

export function removeExcludedEntryByPrefix(
  entries: ExcludedEntry[],
  input: string,
): { entries: ExcludedEntry[]; removed: ExcludedEntry } {
  const atIndex = input.lastIndexOf("@");
  const prefix = atIndex === -1 ? input : input.slice(0, atIndex);
  const source = atIndex === -1 ? null : input.slice(atIndex + 1);

  const matches = entries.filter((entry) => {
    if (source && entry.source !== source) {
      return false;
    }

    return entry.id.startsWith(prefix);
  });

  if (matches.length === 0) {
    throw new Error(`No excluded conversation matches "${input}".`);
  }

  if (matches.length > 1) {
    const candidates = matches.map((entry) => `${entry.id}@${entry.source}`).join(", ");
    throw new Error(`Excluded conversation ID "${input}" is ambiguous. Matches: ${candidates}`);
  }

  const removed = matches[0]!;
  return {
    entries: entries.filter(
      (entry) => !(entry.id === removed.id && entry.source === removed.source),
    ),
    removed,
  };
}

function parseExcludedEntry(value: string): { id: string; source: string } | null {
  const atIndex = value.lastIndexOf("@");
  if (atIndex <= 0 || atIndex === value.length - 1) {
    return null;
  }

  return {
    id: value.slice(0, atIndex),
    source: value.slice(atIndex + 1),
  };
}
