import fs from "node:fs/promises";

import { getEnabledAdapters } from "../adapters/registry.js";
import { type Config } from "../config/schema.js";
import type { ClogWarning } from "../models/warnings.js";
import { nowIso } from "../utils/time.js";
import {
  type LocalDiscoveryCandidate,
  type LocalScanSnapshot,
  passesConfigPathFilters,
} from "../conversations/view.js";
import {
  conversationMatchesAnyClogIgnoreRule,
  readClogIgnoreRules,
} from "./clogignore.js";
export interface ScanResult extends LocalScanSnapshot {
  warnings: ClogWarning[];
  undiscoverable: Array<{
    source: string;
    path: string;
  }>;
  counts: {
    discovered: number;
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
    filtered: 0,
    ignored: 0,
    undiscoverable: 0,
  };

  const clogIgnoreRules = await readClogIgnoreRules();
  const scanTime = nowIso();

  const adapters = getEnabledAdapters(config);
  const candidates: LocalDiscoveryCandidate[] = [];
  const ignoredCandidates: LocalScanSnapshot["ignoredCandidates"] = [];
  const sourceStatuses: LocalScanSnapshot["sourceStatuses"] = [];

  for (const adapter of adapters) {
    let complete = false;
    let adapterReportedIncomplete = false;
    try {
      for await (const discovered of adapter.discover({
        onWarning: (warning) => warnings.push(warning),
        onIncomplete: () => {
          adapterReportedIncomplete = true;
        },
      })) {
        if (conversationMatchesAnyClogIgnoreRule({
          sourceId: discovered.sourceId,
          projectName: discovered.metadata.projectName,
          projectPath: discovered.metadata.projectPath,
          sourcePath: discovered.sourcePath,
        }, clogIgnoreRules)) {
          counts.ignored += 1;
          if (
            discovered.metadata.projectPath &&
            passesConfigPathFilters(
              adapter.name,
              config,
              discovered.metadata.projectPath,
            )
          ) {
            ignoredCandidates.push({
              source: adapter.name,
              sourceId: discovered.sourceId,
              sourcePath: discovered.sourcePath,
              metadata: discovered.metadata,
            });
          }
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
        counts.discovered += 1;
      }
      complete = !adapterReportedIncomplete;
    } catch (error) {
      warnings.push({
        code: "source_discovery_incomplete",
        source: adapter.name,
        message: `Discovery did not complete for ${adapter.name}: ${formatError(error)}`,
        guidance: "Retry the command after checking that the source directory is available.",
      });
    } finally {
      if (
        !complete &&
        !warnings.some(
          (warning) =>
            warning.code === "source_discovery_incomplete" && warning.source === adapter.name,
        )
      ) {
        warnings.push({
          code: "source_discovery_incomplete",
          source: adapter.name,
          message: `Discovery did not complete for ${adapter.name}.`,
          guidance: "Retry the command after checking that the source directory is available.",
        });
      }
      sourceStatuses.push({ source: adapter.name, complete });
    }
  }

  return {
    scanTime,
    author: config.author,
    candidates,
    ignoredCandidates,
    sourceStatuses,
    warnings,
    undiscoverable,
    counts,
  };
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
