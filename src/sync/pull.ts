import fs from "node:fs/promises";
import path from "node:path";

import { getAdapter } from "../adapters/registry.js";
import { matchesRemoteClogIgnoreRule, readClogIgnoreRules } from "../cli/clogignore.js";
import type { Config } from "../config/schema.js";
import {
  deleteConversationInDb,
  getConversationBySourceIdentityInDb,
  insertConversationInDb,
  listConversationsInDb,
  updateConversationInDb,
  withDb,
} from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { nowIso } from "../utils/time.js";
import { BUILTIN_SOURCES } from "../utils/paths.js";
import { parseRemoteMeta, type RemoteMeta } from "./meta.js";
import {
  getRemoteJsonlPath,
  getRemoteMetaPath,
  getRemoteRoot,
} from "./paths.js";

export interface PullStats {
  inserted: number;
  updated: number;
  deleted: number;
  skipped: number;
  warnings: ClogWarning[];
}

type RemotePair = {
  author: string;
  source: string;
  id: string;
  metaPath: string;
  jsonlPath: string;
  metaExists: boolean;
  jsonlExists: boolean;
};

type ValidatedPair = {
  author: string;
  source: string;
  id: string;
  metaPath: string;
  jsonlPath: string;
  meta: RemoteMeta;
  messageCount: number;
};

export async function reconcileRemote(
  config: Config,
  remoteUrl: string,
): Promise<PullStats> {
  const stats: PullStats = {
    inserted: 0,
    updated: 0,
    deleted: 0,
    skipped: 0,
    warnings: [],
  };

  const root = getRemoteRoot();

  const pairs = await scanRemotePairs(root, stats.warnings);

  const validated: ValidatedPair[] = [];
  const skippedTuples = new Set<string>();

  for (const pair of pairs) {
    const validation = await validatePair(pair, config);
    if (validation.kind === "valid") {
      validated.push(validation.pair);
    } else {
      stats.warnings.push(validation.warning);
      stats.skipped += 1;
      skippedTuples.add(tupleKey(pair.author, pair.source, pair.id));
    }
  }

  const validatedAfterExclude = validated.filter((pair) => {
    return true;
  });
  const clogIgnoreRules = await readClogIgnoreRules();
  const validatedAfterIgnore = validatedAfterExclude.filter((pair) => {
    if (
      clogIgnoreRules.some((rule) =>
        matchesRemoteClogIgnoreRule(rule, {
          sourceId: pair.id,
          projectName: pair.meta.projectName,
        }),
      )
    ) {
      stats.skipped += 1;
      return false;
    }
    return true;
  });

  await withDb((db) => {
    const existing = listConversationsInDb(db, {
      origin: { url: remoteUrl },
    });

    const existingByKey = new Map<string, ConversationMeta>();
    for (const conversation of existing) {
      existingByKey.set(
        sourceIdentityKey(conversation.source, conversation.sourceId),
        conversation,
      );
    }

    const seenKeys = new Set<string>();

    for (const pair of validatedAfterIgnore) {
      const key = sourceIdentityKey(pair.source, pair.id);
      if (seenKeys.has(key)) {
        stats.skipped += 1;
        continue;
      }
      seenKeys.add(key);

      const existingForRemote = existingByKey.get(key);

      if (!existingForRemote) {
        const conflict = getConversationBySourceIdentityInDb(db, pair.source, pair.id);
        if (conflict && conflict.origin !== remoteUrl) {
          stats.skipped += 1;
          continue;
        }

        const row = buildConversationFromRemote(pair, remoteUrl);
        insertConversationInDb(db, row);
        stats.inserted += 1;
        continue;
      }

      const updated = mergeRemoteInto(existingForRemote, pair, remoteUrl);
      if (updated) {
        updateConversationInDb(db, updated);
        stats.updated += 1;
      }
    }

    for (const [key, conversation] of existingByKey) {
      if (seenKeys.has(key)) {
        continue;
      }
      if (skippedTuples.has(tupleKey(conversation.author, conversation.source, conversation.sourceId))) {
        continue;
      }
      deleteConversationInDb(db, conversation.id);
      stats.deleted += 1;
    }
  });

  return stats;
}

async function scanRemotePairs(
  root: string,
  warnings: ClogWarning[],
): Promise<RemotePair[]> {
  const pairs: RemotePair[] = [];

  let authors: string[];
  try {
    authors = (await fs.readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
      .map((entry) => entry.name)
      .sort();
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }
    throw error;
  }

  for (const author of authors) {
    const authorDir = path.join(root, author);
    let sourceEntries: Array<{ name: string; isDir: boolean }>;
    try {
      sourceEntries = (await fs.readdir(authorDir, { withFileTypes: true })).map(
        (entry) => ({ name: entry.name, isDir: entry.isDirectory() }),
      );
    } catch {
      continue;
    }

    const sourceDirs = sourceEntries
      .filter((entry) => entry.isDir)
      .map((entry) => entry.name)
      .sort();

    for (const source of sourceDirs) {
      if (!isSupportedSource(source)) {
        warnings.push({
          code: "unsupported_source",
          message: `Unsupported source directory "${author}/${source}" in remote checkout — skipping.`,
          source,
        });
        continue;
      }

      const sourceDir = path.join(authorDir, source);
      let files: string[];
      try {
        files = (await fs.readdir(sourceDir)).sort();
      } catch {
        continue;
      }

      const idsSeen = new Set<string>();

      for (const file of files) {
        const id = extractConversationId(file);
        if (!id) {
          continue;
        }
        if (idsSeen.has(id)) {
          continue;
        }
        idsSeen.add(id);

        const metaPath = getRemoteMetaPath(author, source, id);
        const jsonlPath = getRemoteJsonlPath(author, source, id);

        const [metaExists, jsonlExists] = await Promise.all([
          fileExists(metaPath),
          fileExists(jsonlPath),
        ]);

        pairs.push({
          author,
          source,
          id,
          metaPath,
          jsonlPath,
          metaExists,
          jsonlExists,
        });
      }
    }
  }

  pairs.sort((a, b) => {
    if (a.author !== b.author) return a.author.localeCompare(b.author);
    if (a.source !== b.source) return a.source.localeCompare(b.source);
    return a.id.localeCompare(b.id);
  });

  return pairs;
}

function extractConversationId(filename: string): string | null {
  if (filename.endsWith(".meta.json")) {
    return filename.slice(0, -".meta.json".length);
  }
  if (filename.endsWith(".jsonl")) {
    return filename.slice(0, -".jsonl".length);
  }
  return null;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    await fs.stat(filePath);
    return true;
  } catch {
    return false;
  }
}

type PairValidation =
  | { kind: "valid"; pair: ValidatedPair }
  | { kind: "invalid"; warning: ClogWarning };

async function validatePair(
  pair: RemotePair,
  config: Config,
): Promise<PairValidation> {
  if (!pair.metaExists || !pair.jsonlExists) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_incomplete_pair",
        message: `Skipping remote conversation ${pair.id} — incomplete pair (${
          !pair.metaExists ? "missing .meta.json" : "missing .jsonl"
        }).`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        paths: [pair.metaPath, pair.jsonlPath],
        guidance:
          "Ask the original author to save the conversation again, or remove the orphaned file from the remote repo.",
      },
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(pair.metaPath, "utf8");
  } catch (error) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_metadata",
        message: `Skipping remote conversation ${pair.id} — failed to read .meta.json: ${(error as Error).message}`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.metaPath,
      },
    };
  }

  const parseResult = parseRemoteMeta(raw);
  if (!parseResult.ok) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_metadata",
        message: `Skipping remote conversation ${pair.id} — invalid .meta.json: ${parseResult.reason}`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.metaPath,
        guidance:
          "Ask the original author to save the conversation again, or fix/remove the pair in the remote repo.",
      },
    };
  }

  const { meta } = parseResult;

  if (meta.id !== pair.id) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_metadata",
        message: `Skipping remote conversation — meta.id "${meta.id}" does not match filename "${pair.id}".`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.metaPath,
      },
    };
  }

  if (meta.source !== pair.source) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_metadata",
        message: `Skipping remote conversation ${pair.id} — meta.source "${meta.source}" does not match directory "${pair.source}".`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.metaPath,
      },
    };
  }

  if (meta.author !== pair.author) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_metadata",
        message: `Skipping remote conversation ${pair.id} — meta.author "${meta.author}" does not match directory "${pair.author}".`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.metaPath,
      },
    };
  }

  let messageCount: number;
  try {
    const adapter = getAdapter(pair.source, config);
    const messages = await adapter.parseMessages(pair.jsonlPath);
    messageCount = messages.length;
  } catch (error) {
    return {
      kind: "invalid",
      warning: {
        code: "remote_invalid_content",
        message: `Skipping remote conversation ${pair.id} — failed to parse .jsonl: ${(error as Error).message}`,
        remote: { author: pair.author, source: pair.source, id: pair.id },
        path: pair.jsonlPath,
        guidance:
          "Ask the original author to save the conversation again, or fix/remove the pair in the remote repo.",
      },
    };
  }

  return {
    kind: "valid",
    pair: {
      author: pair.author,
      source: pair.source,
      id: pair.id,
      metaPath: pair.metaPath,
      jsonlPath: pair.jsonlPath,
      meta,
      messageCount,
    },
  };
}

function buildConversationFromRemote(
  pair: ValidatedPair,
  remoteUrl: string,
): ConversationMeta {
  const now = nowIso();
  return {
    id: pair.meta.id,
    sourceId: pair.meta.id,
    source: pair.meta.source,
    title: pair.meta.title,
    summary: pair.meta.summary,
    author: pair.meta.author,
    projectName: pair.meta.projectName,
    projectPath: null,
    tags: [...pair.meta.tags],
    slug: pair.meta.slug,
    createdAt: pair.meta.createdAt,
    discoveredAt: now,
    modifiedAt: pair.meta.modifiedAt,
    state: "saved",
    savedAt: pair.meta.savedAt,
    savedMessageCount: pair.messageCount,
    saveVersion: 1,
    sourcePath: pair.jsonlPath,
    filePath: pair.jsonlPath,
    sourceMtime: null,
    indexedAt: null,
    origin: remoteUrl,
  };
}

function mergeRemoteInto(
  existing: ConversationMeta,
  pair: ValidatedPair,
  remoteUrl: string,
): ConversationMeta | null {
  const searchVisibleChanged =
    existing.title !== pair.meta.title ||
    existing.summary !== pair.meta.summary ||
    !tagsEqual(existing.tags, pair.meta.tags);

  const contentPathChanged =
    existing.sourcePath !== pair.jsonlPath || existing.filePath !== pair.jsonlPath;

  const metadataChanged =
    searchVisibleChanged ||
    existing.author !== pair.meta.author ||
    existing.projectName !== pair.meta.projectName ||
    existing.slug !== pair.meta.slug ||
    existing.createdAt !== pair.meta.createdAt ||
    existing.modifiedAt !== pair.meta.modifiedAt ||
    existing.savedAt !== pair.meta.savedAt ||
    existing.savedMessageCount !== pair.messageCount;

  if (!metadataChanged && !contentPathChanged) {
    return null;
  }

  return {
    ...existing,
    title: pair.meta.title,
    summary: pair.meta.summary,
    author: pair.meta.author,
    projectName: pair.meta.projectName,
    tags: [...pair.meta.tags],
    slug: pair.meta.slug,
    createdAt: pair.meta.createdAt,
    modifiedAt: pair.meta.modifiedAt,
    savedAt: pair.meta.savedAt,
    savedMessageCount: pair.messageCount,
    sourcePath: pair.jsonlPath,
    filePath: pair.jsonlPath,
    indexedAt:
      searchVisibleChanged || contentPathChanged ? null : existing.indexedAt,
    origin: remoteUrl,
  };
}

function tagsEqual(left: string[], right: string[]): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1) {
    if (left[i] !== right[i]) return false;
  }
  return true;
}

function sourceIdentityKey(source: string, id: string): string {
  return `${source}\u0000${id}`;
}

function tupleKey(author: string, source: string, id: string): string {
  return `${author}\u0000${source}\u0000${id}`;
}

function isSupportedSource(source: string): boolean {
  return (BUILTIN_SOURCES as readonly string[]).includes(source);
}
