import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { getExcludedPath } from "../config/index.js";

export interface ExcludedEntry {
  source: string;
  sourceId: string;
}

export async function loadExcluded(): Promise<ExcludedEntry[]> {
  const filePath = getExcludedPath();
  let content: string;
  try {
    content = await readFile(filePath, "utf-8");
  } catch (err: unknown) {
    if (
      err instanceof Error &&
      "code" in err &&
      (err as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      return [];
    }
    throw err;
  }

  const entries: ExcludedEntry[] = [];
  for (const rawLine of content.split("\n")) {
    const line = rawLine.trim();
    if (!line) continue;

    const colonIdx = line.indexOf(":");
    if (colonIdx === -1) continue;

    entries.push({
      source: line.slice(0, colonIdx),
      sourceId: line.slice(colonIdx + 1),
    });
  }

  return entries;
}

export async function addExcluded(
  source: string,
  sourceId: string
): Promise<void> {
  const entries = await loadExcluded();
  if (entries.some((e) => e.source === source && e.sourceId === sourceId)) {
    return; // Already excluded
  }
  entries.push({ source, sourceId });
  await writeExcluded(entries);
}

export async function removeExcluded(
  source: string,
  sourceId: string
): Promise<void> {
  const entries = await loadExcluded();
  const filtered = entries.filter(
    (e) => !(e.source === source && e.sourceId === sourceId)
  );
  await writeExcluded(filtered);
}

export function isExcluded(
  excluded: ExcludedEntry[],
  source: string,
  sourceId: string
): boolean {
  return excluded.some((e) => e.source === source && e.sourceId === sourceId);
}

async function writeExcluded(entries: ExcludedEntry[]): Promise<void> {
  const filePath = getExcludedPath();
  await mkdir(path.dirname(filePath), { recursive: true });
  const content = entries.map((e) => `${e.source}:${e.sourceId}`).join("\n") + "\n";
  await writeFile(filePath, content, "utf-8");
}
