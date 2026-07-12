import fs from "node:fs/promises";

import { isSourceParseSupported } from "../adapters/registry.js";
import {
  listConversationsInDb,
  withDb,
} from "../db/index.js";
import { writePair } from "../interchange/pairs.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { getRawConversationPath } from "../utils/paths.js";
import { validateSourceKey } from "../utils/source-keys.js";
import {
  conversationToRemoteMeta,
  serializeRemoteMeta,
} from "./meta.js";
import {
  getRemoteAuthorDir,
  getRemoteJsonlPath,
  getRemoteMetaPath,
  getRemoteSourceDir,
} from "./paths.js";

export type ChangeKind = "added" | "updated" | "retracted";

export interface ChangeRecord {
  kind: ChangeKind;
  id: string;
  title: string;
  source: string;
  author: string;
}

export interface ExportStats {
  changes: ChangeRecord[];
  warnings: ClogWarning[];
}

export async function collectSameAuthorSavedIdentities(
  author: string,
): Promise<Set<string>> {
  return withDb((db) => {
    const saved = listConversationsInDb(db, {
      states: ["saved"],
      author,
    });
    return new Set(saved.map((c) => `${c.source}\0${c.sourceId}`));
  });
}

export async function exportAuthorToCheckout(
  author: string,
  preReconcileSameAuthorIds: Set<string>,
): Promise<ExportStats> {
  const stats: ExportStats = { changes: [], warnings: [] };

  const ownSavedRows = await withDb((db) =>
    listConversationsInDb(db, {
      states: ["saved"],
      author,
      origin: "local",
    }),
  );
  const ownSaved = selectExportableConversations(ownSavedRows, stats.warnings);

  const expectedBySource = new Map<string, Map<string, ConversationMeta>>();
  for (const conversation of ownSaved) {
    let bySource = expectedBySource.get(conversation.source);
    if (!bySource) {
      bySource = new Map();
      expectedBySource.set(conversation.source, bySource);
    }
    bySource.set(conversation.id, conversation);
  }

  for (const conversation of ownSaved) {
    const metaPath = getRemoteMetaPath(author, conversation.source, conversation.id);
    const jsonlPath = getRemoteJsonlPath(author, conversation.source, conversation.id);

    const existingMeta = await readFileIfExists(metaPath);
    const remoteMeta = conversationToRemoteMeta(conversation);
    const nextMeta = serializeRemoteMeta(remoteMeta);

    const rawPath = getRawConversationPath(conversation.source, conversation.id);
    const rawContent = await fs.readFile(rawPath);

    const existingJsonl = await readFileBufferIfExists(jsonlPath);
    await writePair({
      metaPath,
      jsonlPath,
      meta: remoteMeta,
      jsonl: rawContent,
    });

    const previouslyCompletePair = existingMeta != null && existingJsonl != null;
    const metaChanged = existingMeta !== nextMeta;
    const jsonlChanged =
      existingJsonl == null || !existingJsonl.equals(rawContent);

    if (!previouslyCompletePair) {
      stats.changes.push({
        kind: "added",
        id: conversation.id,
        title: conversation.title,
        source: conversation.source,
        author,
      });
    } else if (metaChanged || jsonlChanged) {
      stats.changes.push({
        kind: "updated",
        id: conversation.id,
        title: conversation.title,
        source: conversation.source,
        author,
      });
    }
  }

  // Retractions: files present in the author's directory that don't correspond
  // to a currently-saved local conversation for this author and source.
  const authorDir = getRemoteAuthorDir(author);
  const sourceDirs = await listSourceDirs(authorDir);

  for (const source of sourceDirs) {
    if (!isSourceParseSupported(source)) {
      continue;
    }

    const sourceDir = getRemoteSourceDir(author, source);
    const files = await safeReaddir(sourceDir);
    const idsInCheckout = Array.from(collectPairIds(files)).sort();
    const expected = expectedBySource.get(source) ?? new Map();

    for (const id of idsInCheckout) {
      if (expected.has(id)) {
        continue;
      }

      if (preReconcileSameAuthorIds.has(`${source}\0${id}`)) {
        continue;
      }

      const metaPath = getRemoteMetaPath(author, source, id);
      const jsonlPath = getRemoteJsonlPath(author, source, id);

      const metaExists = files.includes(`${id}.meta.json`);
      const jsonlExists = files.includes(`${id}.jsonl`);

      // Only retract when the pair is currently complete — lightest-necessary-touch.
      if (!metaExists || !jsonlExists) {
        continue;
      }

      const existingMetaRaw = await readFileIfExists(metaPath);
      let retractedTitle = id.slice(0, 8);
      if (existingMetaRaw) {
        try {
          const parsed = JSON.parse(existingMetaRaw) as { title?: string };
          if (typeof parsed.title === "string") {
            retractedTitle = parsed.title;
          }
        } catch {
          // fall back to id
        }
      }

      await fs.rm(metaPath, { force: true });
      await fs.rm(jsonlPath, { force: true });

      stats.changes.push({
        kind: "retracted",
        id,
        title: retractedTitle,
        source,
        author,
      });
    }
  }

  return stats;
}

async function readFileIfExists(filePath: string): Promise<string | null> {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function readFileBufferIfExists(
  filePath: string,
): Promise<Buffer | null> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

async function listSourceDirs(authorDir: string): Promise<string[]> {
  try {
    const entries = await fs.readdir(authorDir, { withFileTypes: true });
    return entries
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

async function safeReaddir(dir: string): Promise<string[]> {
  try {
    return await fs.readdir(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }
}

function collectPairIds(files: string[]): Set<string> {
  const ids = new Set<string>();
  for (const file of files) {
    if (file.endsWith(".meta.json")) {
      ids.add(file.slice(0, -".meta.json".length));
    } else if (file.endsWith(".jsonl")) {
      ids.add(file.slice(0, -".jsonl".length));
    }
  }
  return ids;
}

function selectExportableConversations(
  conversations: ConversationMeta[],
  warnings: ClogWarning[],
): ConversationMeta[] {
  const exportable: ConversationMeta[] = [];
  const warnedUnsupportedSources = new Set<string>();

  for (const conversation of conversations) {
    if (isSourceParseSupported(conversation.source)) {
      exportable.push(conversation);
      continue;
    }

    const sourceValidation = validateSourceKey(conversation.source);
    if (sourceValidation.ok) {
      if (!warnedUnsupportedSources.has(conversation.source)) {
        warnedUnsupportedSources.add(conversation.source);
        warnings.push({
          code: "unsupported_source",
          message: `Skipping local saved conversations from unsupported source "${conversation.source}" during sync push - this clog build cannot export that source.`,
          source: conversation.source,
        });
      }
      continue;
    }

    warnings.push({
      code: "pair_invalid_metadata",
      message: `Skipping local saved conversation ${conversation.id.slice(0, 8)} during sync push - stored source key "${conversation.source}" is invalid.`,
      conversation: { id: conversation.id, source: conversation.source },
    });
  }

  return exportable;
}

export interface CommitMessageArgs {
  changes: ChangeRecord[];
}

export function buildCommitMessage(args: CommitMessageArgs): string {
  const { changes } = args;

  if (changes.length === 0) {
    throw new Error("buildCommitMessage called with no changes");
  }

  const perAuthor = new Map<string, ChangeRecord[]>();
  for (const change of changes) {
    const bucket = perAuthor.get(change.author) ?? [];
    bucket.push(change);
    perAuthor.set(change.author, bucket);
  }

  const authorCount = perAuthor.size;

  if (authorCount === 1) {
    const [author] = perAuthor.keys();
    return buildSingleAuthorCommit(author!, changes);
  }

  return buildMultiAuthorCommit(perAuthor, changes);
}

function buildSingleAuthorCommit(
  author: string,
  changes: ChangeRecord[],
): string {
  const counts = summarize(changes);
  const header = `clog: ${author} — ${formatCounts(counts)}`;

  if (changes.length > 10) {
    return header;
  }

  const lines = changes
    .slice()
    .sort(changeSortKey)
    .map((change) => {
      const prefix = prefixFor(change.kind);
      const shortId = change.id.slice(0, 8);
      return `  ${prefix} ${shortId} ${change.title}`;
    });

  return `${header}\n\n${lines.join("\n")}\n`;
}

function buildMultiAuthorCommit(
  perAuthor: Map<string, ChangeRecord[]>,
  changes: ChangeRecord[],
): string {
  const authorCount = perAuthor.size;
  const totals = summarize(changes);
  const header = `clog: ${authorCount} authors — ${formatCounts(totals)}`;

  const authorLines = Array.from(perAuthor.keys())
    .sort()
    .map((author) => {
      const counts = summarize(perAuthor.get(author)!);
      return `  ${author}: ${formatCounts(counts)}`;
    });

  return `${header}\n\n${authorLines.join("\n")}\n`;
}

interface Counts {
  added: number;
  updated: number;
  retracted: number;
}

function summarize(changes: ChangeRecord[]): Counts {
  const counts: Counts = { added: 0, updated: 0, retracted: 0 };
  for (const change of changes) {
    counts[change.kind] += 1;
  }
  return counts;
}

function formatCounts(counts: Counts): string {
  const parts: string[] = [];
  if (counts.added > 0) parts.push(`${counts.added} added`);
  if (counts.updated > 0) parts.push(`${counts.updated} updated`);
  if (counts.retracted > 0) parts.push(`${counts.retracted} retracted`);
  return parts.join(", ");
}

function prefixFor(kind: ChangeKind): string {
  switch (kind) {
    case "added":
      return "+";
    case "updated":
      return "~";
    case "retracted":
      return "-";
  }
}

function changeSortKey(a: ChangeRecord, b: ChangeRecord): number {
  const order: Record<ChangeKind, number> = { added: 0, updated: 1, retracted: 2 };
  if (order[a.kind] !== order[b.kind]) {
    return order[a.kind] - order[b.kind];
  }
  return a.id.localeCompare(b.id);
}
