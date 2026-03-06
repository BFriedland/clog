import path from "node:path";
import { readdir, rm, copyFile, mkdir, stat } from "node:fs/promises";
import type { Config } from "../config/schema.js";
import { saveConfig } from "../config/schema.js";
import { getRemoteDir } from "../config/index.js";
import { withDb } from "../db/index.js";
import { writeMetaJson } from "./meta.js";
import { isGitRepo, gitPull, gitAddCommitPush, gitRevParseHead } from "./git.js";
import { reconcile } from "./pull.js";
import { resolveContentPath } from "./resolve-content-path.js";

export interface PushChange {
  id: string;
  title: string;
  type: "added" | "updated" | "retracted";
}

export interface PushResult {
  changes: PushChange[];
  committed: boolean;
  pushed: boolean;
  error?: string;
  pullResult?: Awaited<ReturnType<typeof reconcile>>;
}

export async function syncPush(config: Config): Promise<PushResult> {
  const remoteUrl = config.remote.url;
  if (!remoteUrl) {
    throw new Error("No remote configured. Run `clog remote add <url>` first.");
  }
  if (!config.author) {
    throw new Error('Set your author name first: clog config set author <name>');
  }

  const remoteDir = getRemoteDir();
  if (!(await isGitRepo(remoteDir))) {
    throw new Error("You haven't pulled from the remote yet. Run 'clog sync pull' first.");
  }

  // First-push non-GitHub safety check is handled by the CLI layer

  // Pull phase: incorporate teammates' changes
  const pull = await gitPull(remoteDir);
  if (!pull.success) {
    throw new Error(
      `Unexpected conflict during rebase. Inspect with: git -C ${remoteDir} status`
    );
  }
  const pullResult = await reconcile(config);

  // Export phase
  const changes: PushChange[] = [];
  const authorDir = path.join(remoteDir, config.author);
  await mkdir(authorDir, { recursive: true });

  // Get conversations for this author — locally published for export,
  // all published (regardless of origin) for retraction per spec section 7 step 4
  const { localPublished, allPublishedIds } = await withDb((ctx) => {
    const local = ctx.listConversations({ state: "published", origin: "local", author: config.author });
    const all = ctx.listConversations({ state: "published", author: config.author });
    return { localPublished: local, allPublishedIds: new Set(all.map((c) => c.id)) };
  });

  // Copy JSONL + write meta.json for each (JSONL first to avoid orphaned meta)
  for (const conv of localPublished) {
    const metaPath = path.join(authorDir, `${conv.id}.meta.json`);
    const jsonlDest = path.join(authorDir, `${conv.id}.jsonl`);
    const jsonlSrc = resolveContentPath(conv);

    // Determine if this is an add or update
    let isUpdate = false;
    try {
      await stat(metaPath);
      isUpdate = true;
    } catch {
      // file doesn't exist — it's new
    }

    try {
      await copyFile(jsonlSrc, jsonlDest);
    } catch (err) {
      // Source file may not exist. Skip this conversation entirely.
      if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
      continue;
    }

    await writeMetaJson(metaPath, conv);

    changes.push({
      id: conv.id,
      title: conv.title,
      type: isUpdate ? "updated" : "added",
    });
  }

  // Retraction: delete files in <author>/ that don't correspond to any
  // published conversation for this author (regardless of origin, per spec §7.4)
  try {
    const files = await readdir(authorDir);
    const metaFiles = files.filter((f) => f.endsWith(".meta.json"));
    for (const metaFile of metaFiles) {
      const id = metaFile.replace(".meta.json", "");
      if (!allPublishedIds.has(id)) {
        // Retract
        await rm(path.join(authorDir, metaFile), { force: true });
        await rm(path.join(authorDir, `${id}.jsonl`), { force: true });
        changes.push({ id, title: "", type: "retracted" });
      }
    }
  } catch {
    // Author dir may not exist yet
  }

  // Commit and push
  const commitMessage = generateCommitMessage(config.author, changes);
  const { committed, pushed, error } = await gitAddCommitPush(remoteDir, commitMessage);

  // Update lastSyncHead
  if (pushed) {
    try {
      const head = await gitRevParseHead(remoteDir);
      config.remote.lastSyncHead = head;
      await saveConfig(config);
    } catch {
      // non-fatal
    }
  }

  return { changes, committed, pushed, error, pullResult };
}

export function generateCommitMessage(
  author: string,
  changes: PushChange[]
): string {
  const added = changes.filter((c) => c.type === "added").length;
  const updated = changes.filter((c) => c.type === "updated").length;
  const retracted = changes.filter((c) => c.type === "retracted").length;

  const parts: string[] = [];
  if (added > 0) parts.push(`${added} added`);
  if (updated > 0) parts.push(`${updated} updated`);
  if (retracted > 0) parts.push(`${retracted} removed`);

  const summary = parts.join(", ");
  const firstLine = `clog: ${author} — ${summary}`;

  if (changes.length <= 10) {
    const lines = changes.map((c) => {
      const prefix = c.type === "added" ? "+" : c.type === "updated" ? "~" : "-";
      return `  ${prefix} ${c.id.slice(0, 6)} ${c.title}`;
    });
    return `${firstLine}\n\n${lines.join("\n")}`;
  }

  return firstLine;
}
