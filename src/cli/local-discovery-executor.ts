import type { Database } from "sql.js";

import type { DiscoveredConversation } from "../adapters/adapter.js";
import {
  isLocallyWritable,
  requireLocalConversation,
} from "../conversations/write-guards.js";
import {
  getConversationBySourceIdentityInDb,
  listConversationsInDb,
} from "../db/index.js";
import {
  unsafeDeleteConversationInDb,
  unsafeInsertConversationInDb,
  unsafeUpdateConversationInDb,
} from "../db/unsafe-conversations.js";
import type { ConversationMeta } from "../models/conversation.js";
import { summaryKindForDiscoveredSummary } from "../models/conversation.js";
import { pathMatchesBoundary } from "./clogignore.js";

export interface LocalDiscoveryCandidate {
  source: string;
  sourceId: string;
  sourcePath: string;
  sourceMtime: string;
  metadata: DiscoveredConversation["metadata"];
}

export interface LocalDiscoveryWriteCounts {
  discovered: number;
  updated: number;
  pruned: number;
}

export function applyLocalDiscoveryResultsInDb(
  db: Database,
  args: {
    candidates: LocalDiscoveryCandidate[];
    author: string;
    defaultTags: string[];
    scanTime: string;
    encounteredKeys: Set<string>;
    scannedRoots: Map<string, string[]>;
  },
): LocalDiscoveryWriteCounts {
  const counts = {
    discovered: 0,
    updated: 0,
    pruned: 0,
  };
  const existing = listConversationsInDb(db);
  const seenKeys = new Set<string>();

  for (const candidate of args.candidates) {
    const key = `${candidate.source}:${candidate.sourceId}`;
    seenKeys.add(key);

    const found = getConversationBySourceIdentityInDb(
      db,
      candidate.source,
      candidate.sourceId,
    );

    if (found && !isLocallyWritable(found)) {
      continue;
    }

    if (!found) {
      unsafeInsertConversationInDb(
        db,
        buildDiscoveredConversation(
          candidate,
          args.author,
          args.defaultTags,
          args.scanTime,
        ),
      );
      counts.discovered += 1;
      continue;
    }

    const localFound = requireLocalConversation(found, "local source scan");
    const sourceChanged =
      localFound.sourceMtime !== candidate.sourceMtime ||
      localFound.sourcePath !== candidate.sourcePath;
    if (!sourceChanged) {
      continue;
    }

    if (localFound.state === "unsaved") {
      unsafeUpdateConversationInDb(db, {
        ...localFound,
        title: candidate.metadata.title,
        summary: candidate.metadata.summary,
        summaryKind: summaryKindForDiscoveredSummary(candidate.metadata.summary),
        summaryExtraction: null,
        projectName: candidate.metadata.projectName,
        projectPath: candidate.metadata.projectPath,
        slug: candidate.metadata.slug,
        createdAt: candidate.metadata.createdAt,
        sourcePath: candidate.sourcePath,
        sourceMtime: candidate.sourceMtime,
        modifiedAt: args.scanTime,
      });
    } else {
      unsafeUpdateConversationInDb(db, {
        ...localFound,
        sourcePath: candidate.sourcePath,
        sourceMtime: candidate.sourceMtime,
        modifiedAt: args.scanTime,
      });
    }

    counts.updated += 1;
  }

  for (const conversation of existing) {
    if (conversation.state !== "unsaved" || !isLocallyWritable(conversation)) {
      continue;
    }

    const key = `${conversation.source}:${conversation.sourceId}`;
    const roots = args.scannedRoots.get(conversation.source) ?? [];
    if (roots.length === 0) {
      continue;
    }

    if (
      !roots.some((root) => pathMatchesBoundary(conversation.sourcePath, root)) ||
      seenKeys.has(key)
    ) {
      continue;
    }

    unsafeDeleteConversationInDb(db, conversation.id);
    if (!args.encounteredKeys.has(key)) {
      counts.pruned += 1;
    }
  }

  return counts;
}

function buildDiscoveredConversation(
  candidate: LocalDiscoveryCandidate,
  author: string,
  defaultTags: string[],
  timestamp: string,
): ConversationMeta {
  return {
    id: candidate.sourceId,
    sourceId: candidate.sourceId,
    source: candidate.source,
    title: candidate.metadata.title,
    summary: candidate.metadata.summary,
    summaryKind: summaryKindForDiscoveredSummary(candidate.metadata.summary),
    summaryExtraction: null,
    author,
    projectName: candidate.metadata.projectName,
    projectPath: candidate.metadata.projectPath,
    tags: [...new Set(defaultTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    slug: candidate.metadata.slug,
    createdAt: candidate.metadata.createdAt,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "unsaved",
    savedAt: null,
    savedMessageCount: null,
    saveVersion: 0,
    sourcePath: candidate.sourcePath,
    filePath: null,
    sourceMtime: candidate.sourceMtime,
    indexedAt: null,
    originKind: "local",
    originRef: null,
  };
}
