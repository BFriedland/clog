import fs from "node:fs/promises";

import { getEnabledAdapters } from "../adapters/registry.js";
import type { DiscoveredConversation } from "../adapters/adapter.js";
import { type Config } from "../config/schema.js";
import {
  getConversationBySourceIdentityInDb,
  insertConversationInDb,
  listConversationsInDb,
  updateConversationInDb,
  withDb,
  deleteConversationInDb,
} from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { nowIso } from "../utils/time.js";
import { matchesClogIgnoreRule, pathMatchesBoundary, readClogIgnoreRules } from "./clogignore.js";
import { isExcluded, readExcludedEntries } from "./excluded.js";

interface ScanCandidate {
  source: string;
  sourceId: string;
  sourcePath: string;
  sourceMtime: string;
  metadata: DiscoveredConversation["metadata"];
}

export interface ScanResult {
  warnings: ClogWarning[];
  counts: {
    discovered: number;
    updated: number;
    pruned: number;
    excluded: number;
    filtered: number;
    ignored: number;
  };
}

export async function scanLocalSources(config: Config): Promise<ScanResult> {
  const warnings: ClogWarning[] = [];
  const counts = {
    discovered: 0,
    updated: 0,
    pruned: 0,
    excluded: 0,
    filtered: 0,
    ignored: 0,
  };

  const [{ entries: excludedEntries, warnings: excludedWarnings }, clogIgnoreRules] =
    await Promise.all([readExcludedEntries(), readClogIgnoreRules()]);
  warnings.push(...excludedWarnings);

  const adapters = getEnabledAdapters(config);
  const candidates: ScanCandidate[] = [];
  const scannedRoots = new Map<string, string[]>();

  for (const adapter of adapters) {
    scannedRoots.set(adapter.name, adapter.watchPaths());

    for await (const discovered of adapter.discover({
      onWarning: (warning) => warnings.push(warning),
    })) {
      const excluded = isExcluded(excludedEntries, discovered.sourceId, adapter.name);
      if (excluded) {
        counts.excluded += 1;
        continue;
      }

      if (!discovered.metadata.projectPath) {
        warnings.push({
          code: "path_filter_without_project",
          message: "Skipping conversation because project path could not be determined.",
          source: adapter.name,
          path: discovered.sourcePath,
          guidance: "Discovery fails closed when project path metadata is unavailable.",
        });
        continue;
      }

      if (!passesConfigPathFilters(adapter.name, config, discovered.metadata.projectPath)) {
        counts.filtered += 1;
        continue;
      }

      if (
        clogIgnoreRules.some((rule) =>
          matchesClogIgnoreRule(rule, {
            projectPath: discovered.metadata.projectPath ?? "",
            createdAt: discovered.metadata.createdAt,
          }),
        )
      ) {
        counts.ignored += 1;
        continue;
      }

      const stat = await fs.stat(discovered.sourcePath);
      candidates.push({
        source: adapter.name,
        sourceId: discovered.sourceId,
        sourcePath: discovered.sourcePath,
        sourceMtime: stat.mtime.toISOString(),
        metadata: discovered.metadata,
      });
    }
  }

  await withDb((db) => {
    const existing = listConversationsInDb(db);
    const seenKeys = new Set<string>();
    const scanTime = nowIso();

    for (const candidate of candidates) {
      const key = `${candidate.source}:${candidate.sourceId}`;
      seenKeys.add(key);

      const found = getConversationBySourceIdentityInDb(db, candidate.source, candidate.sourceId);

      if (!found) {
        insertConversationInDb(
          db,
          buildDiscoveredConversation(candidate, config.author, config.defaultTags, scanTime),
        );
        counts.discovered += 1;
        continue;
      }

      const sourceChanged =
        found.sourceMtime !== candidate.sourceMtime || found.sourcePath !== candidate.sourcePath;
      if (!sourceChanged) {
        continue;
      }

      if (found.state === "discovered") {
        updateConversationInDb(db, {
          ...found,
          title: candidate.metadata.title,
          summary: candidate.metadata.summary,
          projectName: candidate.metadata.projectName,
          projectPath: candidate.metadata.projectPath,
          slug: candidate.metadata.slug,
          createdAt: candidate.metadata.createdAt,
          sourcePath: candidate.sourcePath,
          sourceMtime: candidate.sourceMtime,
          modifiedAt: scanTime,
        });
      } else {
        updateConversationInDb(db, {
          ...found,
          sourcePath: candidate.sourcePath,
          sourceMtime: candidate.sourceMtime,
          modifiedAt: scanTime,
        });
      }

      counts.updated += 1;
    }

    for (const conversation of existing) {
      if (conversation.state !== "discovered") {
        continue;
      }

      const roots = scannedRoots.get(conversation.source) ?? [];
      if (roots.length === 0) {
        continue;
      }

      if (
        !roots.some((root) => pathMatchesBoundary(conversation.sourcePath, root)) ||
        seenKeys.has(`${conversation.source}:${conversation.sourceId}`)
      ) {
        continue;
      }

      deleteConversationInDb(db, conversation.id);
      counts.pruned += 1;
    }
  });

  return { warnings, counts };
}

function buildDiscoveredConversation(
  candidate: ScanCandidate,
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
    author,
    projectName: candidate.metadata.projectName,
    projectPath: candidate.metadata.projectPath,
    tags: [...new Set(defaultTags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))],
    slug: candidate.metadata.slug,
    createdAt: candidate.metadata.createdAt,
    discoveredAt: timestamp,
    modifiedAt: timestamp,
    state: "discovered",
    publishedAt: null,
    publishedMessageCount: null,
    publishVersion: 0,
    sourcePath: candidate.sourcePath,
    filePath: null,
    sourceMtime: candidate.sourceMtime,
    indexedAt: null,
    origin: null,
  };
}

function passesConfigPathFilters(source: string, config: Config, projectPath: string): boolean {
  const sourceConfig = config.sources[source as keyof Config["sources"]];

  if (!sourceConfig) {
    return true;
  }

  if (
    sourceConfig.includePaths.length > 0 &&
    !sourceConfig.includePaths.some((entry) => pathMatchesBoundary(projectPath, entry))
  ) {
    return false;
  }

  if (sourceConfig.excludePaths.some((entry) => pathMatchesBoundary(projectPath, entry))) {
    return false;
  }

  return true;
}
