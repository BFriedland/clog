import { copyFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { withDb } from "../db/index.js";
import { getRawDir } from "../config/index.js";
import { scanSources } from "./scan.js";

export async function addCommand(
  ids: string[],
  opts: { all?: boolean; project?: string }
): Promise<void> {
  await scanSources();

  const rawDir = path.join(getRawDir(), "claude-code");
  await mkdir(rawDir, { recursive: true });

  let count = 0;

  await withDb(async (ctx) => {
    let conversations;

    if (opts.all) {
      conversations = ctx.listConversations({ state: "discovered" });
    } else if (opts.project) {
      conversations = ctx.listConversations({
        state: "discovered",
        project: opts.project,
      });
    } else {
      conversations = ids.map((id) => {
        const resolvedId = ctx.resolveId(id);
        const conv = ctx.getConversation(resolvedId);
        if (!conv) {
          throw new Error(`Conversation not found: ${resolvedId}. Run \`clog list --all\` to see available IDs.`);
        }
        return conv;
      });
    }

    // Copy all files before updating DB so a mid-loop failure
    // doesn't leave the DB in a partially-staged state
    const copied: Array<{ id: string; destPath: string }> = [];
    for (const conv of conversations) {
      const destPath = path.join(rawDir, `${conv.id}.jsonl`);
      await copyFile(conv.sourcePath, destPath);
      copied.push({ id: conv.id, destPath });
    }

    const now = new Date().toISOString();
    for (const { id, destPath } of copied) {
      ctx.updateConversation(id, {
        state: "staged",
        filePath: destPath,
        modifiedAt: now,
      });
      count++;
    }
  });

  console.log(`Added ${count} conversation(s)`);
}
