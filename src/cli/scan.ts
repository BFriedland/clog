import { stat, copyFile } from "node:fs/promises";
import os from "node:os";
import { loadConfig } from "../config/schema.js";
import { getDefaultSourcePaths } from "../config/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { withDb } from "../db/index.js";
import { loadExcluded, isExcluded } from "./excluded.js";
import { loadClogignore, matchesClogignore } from "./clogignore.js";
import type { DiscoveredConversation } from "../models/conversation.js";

export interface ScanCounts {
  discovered: number;
  excluded: number;
  filtered: number;
  ignored: number;
  updated: number;
}

export async function scanSources(): Promise<ScanCounts> {
  const config = await loadConfig();
  const sourceConfig = config.sources["claude-code"];

  const sourcePaths =
    sourceConfig.paths.length > 0
      ? sourceConfig.paths
      : getDefaultSourcePaths();

  const adapter = new ClaudeCodeAdapter(sourcePaths);

  const excludedEntries = await loadExcluded();
  const clogignoreRules = await loadClogignore();

  const counts: ScanCounts = {
    discovered: 0,
    excluded: 0,
    filtered: 0,
    ignored: 0,
    updated: 0,
  };

  const passed: Array<{
    conv: DiscoveredConversation;
    mtime: string;
  }> = [];

  for await (const conv of adapter.discover()) {
    // Layer 1: Check excluded list
    if (isExcluded(excludedEntries, "claude-code", conv.sourceId)) {
      counts.excluded++;
      continue;
    }

    // Layer 2: Check config includePaths/excludePaths
    if (!matchesConfigPaths(sourceConfig, conv)) {
      counts.filtered++;
      continue;
    }

    // Layer 3: Check clogignore rules
    if (matchesClogignore(clogignoreRules, conv)) {
      counts.ignored++;
      continue;
    }

    // Get source file mtime
    let mtime: string;
    try {
      const fileStat = await stat(conv.sourcePath);
      mtime = fileStat.mtime.toISOString();
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") {
        continue;
      }
      throw err;
    }

    passed.push({ conv, mtime });
  }

  // Collect copy jobs to run after DB transaction
  const copyJobs: Array<{ src: string; dest: string }> = [];

  // Process all passing conversations within a single DB transaction
  await withDb((ctx) => {
    const now = new Date().toISOString();

    for (const { conv, mtime } of passed) {
      const existing = ctx.getConversationBySourceId(
        "claude-code",
        conv.sourceId
      );

      if (!existing) {
        // New conversation: insert as discovered
        ctx.insertConversation({
          id: conv.sourceId,
          sourceId: conv.sourceId,
          source: "claude-code",
          title: conv.metadata.title,
          summary: conv.metadata.summary,
          author: config.author || "",
          project: conv.metadata.project,
          tags: config.defaultTags || [],
          slug: conv.metadata.slug,
          createdAt: conv.metadata.createdAt,
          discoveredAt: now,
          modifiedAt: now,
          state: "discovered",
          publishedAt: null,
          publishVersion: 0,
          sourcePath: conv.sourcePath,
          filePath: null,
          sourceMtime: mtime,
          indexedAt: null,
        });
        counts.discovered++;
      } else if (existing.sourceMtime === mtime) {
        // Unchanged: skip
        continue;
      } else {
        // Source file changed
        if (existing.state === "discovered") {
          // Re-extract metadata and update
          ctx.updateConversation(existing.id, {
            title: conv.metadata.title,
            summary: conv.metadata.summary,
            slug: conv.metadata.slug,
            sourceMtime: mtime,
            modifiedAt: now,
          });
        } else {
          // Staged or published: preserve user-edited metadata, update timestamps
          ctx.updateConversation(existing.id, {
            sourceMtime: mtime,
            modifiedAt: now,
          });

          // If there is a raw copy (file_path), schedule re-copy
          if (existing.filePath) {
            copyJobs.push({
              src: conv.sourcePath,
              dest: existing.filePath,
            });
          }
        }

        counts.updated++;
      }
    }
  });

  // Execute file copy jobs outside the DB lock
  for (const job of copyJobs) {
    try {
      await copyFile(job.src, job.dest);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      console.error(`warning: failed to update ${job.dest}: ${message}`);
    }
  }

  return counts;
}

function matchesConfigPaths(
  sourceConfig: { includePaths: string[]; excludePaths: string[] },
  conv: DiscoveredConversation
): boolean {
  const project = conv.metadata.project;
  if (!project) return true;

  const home = os.homedir();
  const expandPath = (p: string): string =>
    p.startsWith("~") ? home + p.slice(1) : p;

  // If includePaths is non-empty, project must match at least one
  if (sourceConfig.includePaths.length > 0) {
    const matches = sourceConfig.includePaths.some((p) => {
      const expanded = expandPath(p);
      return project.startsWith(expanded);
    });
    if (!matches) return false;
  }

  // If excludePaths is set, skip if project matches any
  if (sourceConfig.excludePaths.length > 0) {
    const excluded = sourceConfig.excludePaths.some((p) => {
      const expanded = expandPath(p);
      return project.startsWith(expanded);
    });
    if (excluded) return false;
  }

  return true;
}
