import chalk from "chalk";
import { withDb } from "../db/index.js";

export async function editCommand(
  id: string,
  opts: { title?: string; summary?: string }
): Promise<void> {
  if (!opts.title && !opts.summary) {
    console.log("Usage: clog edit <id> [--title <title>] [--summary <summary>]");
    console.log("Provide at least one of --title or --summary.");
    return;
  }

  await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conv = ctx.getConversation(fullId);
    if (!conv) {
      throw new Error(`Conversation not found: ${fullId}`);
    }

    const updates: Parameters<typeof ctx.updateConversation>[1] = {
      modifiedAt: new Date().toISOString(),
    };

    if (opts.title !== undefined) {
      updates.title = opts.title;
    }
    if (opts.summary !== undefined) {
      updates.summary = opts.summary;
    }

    ctx.updateConversation(fullId, updates);

    // Mark for re-indexing if published and previously indexed
    if (conv.state === "published" && conv.indexedAt) {
      ctx.setIndexedAt(fullId, null);
    }

    const fields: string[] = [];
    if (opts.title !== undefined) fields.push("title");
    if (opts.summary !== undefined) fields.push("summary");

    console.log(
      chalk.green("Updated") +
        ` ${fields.join(" and ")} for ${chalk.cyan(fullId.slice(0, 12))}`
    );
  });
}
