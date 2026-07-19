import fs from "node:fs/promises";

import { getEnabledAdapters } from "../adapters/registry.js";
import { type Config } from "../config/schema.js";
import { withDb } from "../db/index.js";
import type { ClogWarning } from "../models/warnings.js";
import { nowIso } from "../utils/time.js";
import {
  conversationMatchesAnyClogIgnoreRule,
  pathMatchesBoundary,
  readClogIgnoreRules,
} from "./clogignore.js";
import {
  applyLocalDiscoveryResultsInDb,
  type LocalDiscoveryCandidate,
} from "./local-discovery-executor.js";

export interface ScanResult {
  warnings: ClogWarning[];
  undiscoverable: Array<{
    source: string;
    path: string;
  }>;
  counts: {
    discovered: number;
    updated: number;
    pruned: number;
    filtered: number;
    ignored: number;
    undiscoverable: number;
  };
}

export async function scanLocalSources(config: Config): Promise<ScanResult> {
  const warnings: ClogWarning[] = [];
  const undiscoverable: Array<{
    source: string;
    path: string;
  }> = [];
  const counts = {
    discovered: 0,
    updated: 0,
    pruned: 0,
    filtered: 0,
    ignored: 0,
    undiscoverable: 0,
  };

  const clogIgnoreRules = await readClogIgnoreRules();

  const adapters = getEnabledAdapters(config);
  const candidates: LocalDiscoveryCandidate[] = [];
  const encounteredKeys = new Set<string>();
  const scannedRoots = new Map<string, string[]>();

  for (const adapter of adapters) {
    scannedRoots.set(adapter.name, adapter.watchPaths());

    for await (const discovered of adapter.discover({
      onWarning: (warning) => warnings.push(warning),
    })) {
      encounteredKeys.add(`${adapter.name}:${discovered.sourceId}`);

      if (conversationMatchesAnyClogIgnoreRule({
        sourceId: discovered.sourceId,
        projectName: discovered.metadata.projectName,
        projectPath: discovered.metadata.projectPath,
        sourcePath: discovered.sourcePath,
      }, clogIgnoreRules)) {
        counts.ignored += 1;
        continue;
      }

      if (!discovered.metadata.projectPath) {
        counts.undiscoverable += 1;
        undiscoverable.push({
          source: adapter.name,
          path: discovered.sourcePath,
        });
        continue;
      }

      if (!passesConfigPathFilters(adapter.name, config, discovered.metadata.projectPath)) {
        counts.filtered += 1;
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
    const writeCounts = applyLocalDiscoveryResultsInDb(db, {
      candidates,
      author: config.author,
      defaultTags: config.defaultTags,
      scanTime: nowIso(),
      encounteredKeys,
      scannedRoots,
    });
    counts.discovered += writeCounts.discovered;
    counts.updated += writeCounts.updated;
    counts.pruned += writeCounts.pruned;
  }, { mode: "write" });

  return { warnings, undiscoverable, counts };
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
