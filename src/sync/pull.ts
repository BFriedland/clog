import path from "node:path";
import { readdir, stat } from "node:fs/promises";
import type { Config } from "../config/schema.js";
import { saveConfig } from "../config/schema.js";
import { getRemoteDir } from "../config/index.js";
import { withDb } from "../db/index.js";
import { loadExcluded, isExcluded } from "../cli/excluded.js";
import { readMetaJson, metaToConversation } from "./meta.js";
import { gitClone, gitPull, isGitRepo, gitRemoteUrl, gitRevParseHead } from "./git.js";
import type { ConversationMeta } from "../models/conversation.js";
import { deindexConversations } from "../search/coherence.js";

export interface PullResult {
  inserted: number;
  updated: number;
  deleted: number;
  skippedExcluded: number;
  skippedDuplicate: number;
  warnings: string[];
}

export async function syncPull(config: Config): Promise<PullResult> {
  const remoteUrl = config.remote.url;
  if (!remoteUrl) {
    throw new Error("No remote configured. Run `clog remote add <url>` first.");
  }

  const remoteDir = getRemoteDir();
  const isRepo = await isGitRepo(remoteDir);

  if (isRepo) {
    // Validate remote URL matches config
    const currentUrl = await gitRemoteUrl(remoteDir);
    if (currentUrl !== remoteUrl) {
      throw new Error(
        `Remote URL mismatch: checkout has "${currentUrl}" but config has "${remoteUrl}". ` +
        `Remove the checkout or update your config.`
      );
    }

    const pull = await gitPull(remoteDir);
    if (!pull.success) {
      throw new Error(
        `Unexpected conflict during rebase. Inspect with: git -C ${remoteDir} status`
      );
    }
  } else {
    await gitClone(remoteUrl, remoteDir);
  }

  const result = await reconcile(config);

  // Update lastSyncHead
  try {
    const head = await gitRevParseHead(remoteDir);
    config.remote.lastSyncHead = head;
    await saveConfig(config);
  } catch {
    // non-fatal — lastSyncHead is for staleness detection only
  }

  return result;
}

export async function reconcile(config: Config): Promise<PullResult> {
  const remoteUrl = config.remote.url;
  if (!remoteUrl) {
    throw new Error("No remote configured.");
  }

  const remoteDir = getRemoteDir();
  const excluded = await loadExcluded();
  const warnings: string[] = [];

  // Scan the remote directory for author dirs and .meta.json files
  const onDisk = new Map<string, { meta: NonNullable<Awaited<ReturnType<typeof readMetaJson>>>; authorDir: string }>();

  let authorDirs: string[];
  try {
    const entries = await readdir(remoteDir, { withFileTypes: true });
    authorDirs = entries
      .filter((e) => e.isDirectory() && e.name !== ".git")
      .map((e) => e.name)
      .sort();
  } catch {
    return { inserted: 0, updated: 0, deleted: 0, skippedExcluded: 0, skippedDuplicate: 0, warnings: [] };
  }

  for (const authorName of authorDirs) {
    const authorPath = path.join(remoteDir, authorName);
    let files: string[];
    try {
      files = (await readdir(authorPath)).filter((f) => f.endsWith(".meta.json"));
    } catch {
      continue;
    }

    for (const metaFile of files) {
      const id = metaFile.replace(".meta.json", "");
      const metaPath = path.join(authorPath, metaFile);
      const jsonlPath = path.join(authorPath, `${id}.jsonl`);

      // Check for orphaned files
      try {
        await stat(jsonlPath);
      } catch {
        warnings.push(`Orphaned .meta.json without .jsonl: ${authorName}/${metaFile}`);
        continue;
      }

      const meta = await readMetaJson(metaPath);
      if (!meta) {
        warnings.push(`Corrupt .meta.json: ${authorName}/${metaFile}`);
        continue;
      }

      onDisk.set(meta.id, { meta, authorDir: authorName });
    }

    // Check for orphaned .jsonl files (no matching .meta.json)
    try {
      const allFiles = await readdir(authorPath);
      const jsonlFiles = allFiles.filter((f) => f.endsWith(".jsonl"));
      for (const jsonlFile of jsonlFiles) {
        const id = jsonlFile.replace(".jsonl", "");
        const metaPath = path.join(authorPath, `${id}.meta.json`);
        try {
          await stat(metaPath);
        } catch {
          warnings.push(`Orphaned .jsonl without .meta.json: ${authorName}/${jsonlFile}`);
        }
      }
    } catch {
      // skip
    }
  }

  // Reconcile against DB in a single transaction
  const deindexIds: string[] = [];
  const result = await withDb((ctx) => {
    let inserted = 0;
    let updated = 0;
    let deleted = 0;
    let skippedExcluded = 0;
    let skippedDuplicate = 0;

    // Get all remote conversations currently in DB
    const remoteInDb = ctx.listConversations({ origin: "remote" })
      .filter((c) => c.origin === remoteUrl);
    const remoteDbMap = new Map(remoteInDb.map((c) => [c.id, c]));

    // Process what's on disk
    for (const [id, { meta, authorDir }] of onDisk) {
      // Skip excluded
      if (isExcluded(excluded, meta.source, id)) {
        skippedExcluded++;
        continue;
      }

      // Skip if local copy exists (origin IS NULL takes precedence)
      const localCopy = ctx.getConversationBySourceId(meta.source, id);
      if (localCopy && !localCopy.origin) {
        skippedDuplicate++;
        remoteDbMap.delete(id); // Don't delete the remote copy if one existed
        continue;
      }

      const sourcePath = path.join(remoteDir, authorDir, `${id}.jsonl`);
      const existing = remoteDbMap.get(id);

      if (existing) {
        // Update if metadata changed
        if (metadataChanged(existing, meta, sourcePath)) {
          ctx.updateConversation(id, {
            title: meta.title,
            summary: meta.summary,
            tags: meta.tags,
            author: meta.author,
            project: meta.project,
            slug: meta.slug,
            modifiedAt: meta.modifiedAt,
            publishedAt: meta.publishedAt,
            source: meta.source,
            sourcePath,
            filePath: sourcePath,
            ...(searchMetadataChanged(existing, meta)
              ? { indexedAt: null }
              : {}),
          });
          updated++;
        }
        remoteDbMap.delete(id);
      } else {
        // Insert new
        const conv = metaToConversation(meta, {
          origin: remoteUrl,
          sourcePath,
          filePath: sourcePath,
        });
        ctx.insertConversation(conv);
        inserted++;
      }
    }

    // Delete conversations that are in DB but no longer on disk
    for (const [id] of remoteDbMap) {
      ctx.deleteConversation(id);
      deindexIds.push(id);
      deleted++;
    }

    return { inserted, updated, deleted, skippedExcluded, skippedDuplicate };
  });

  await deindexConversations(deindexIds);
  return { ...result, warnings };
}

function metadataChanged(
  existing: ConversationMeta,
  meta: { title: string; summary: string; tags: string[]; author: string; project: string | null; slug: string | null; modifiedAt: string; publishedAt: string; source: string },
  sourcePath: string,
): boolean {
  if (existing.sourcePath !== sourcePath) return true;
  if (existing.filePath !== sourcePath) return true;
  if (existing.title !== meta.title) return true;
  if (existing.summary !== meta.summary) return true;
  if (existing.author !== meta.author) return true;
  if (existing.project !== meta.project) return true;
  if (existing.slug !== meta.slug) return true;
  if (existing.modifiedAt !== meta.modifiedAt) return true;
  if (existing.publishedAt !== meta.publishedAt) return true;
  if (existing.source !== meta.source) return true;
  if (JSON.stringify(existing.tags) !== JSON.stringify(meta.tags)) return true;
  return false;
}

function searchMetadataChanged(
  existing: ConversationMeta,
  meta: { title: string; summary: string; tags: string[] },
): boolean {
  if (existing.title !== meta.title) return true;
  if (existing.summary !== meta.summary) return true;
  if (JSON.stringify(existing.tags) !== JSON.stringify(meta.tags)) return true;
  return false;
}
