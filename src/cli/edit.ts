import chalk from "chalk";
import { withDb } from "../db/index.js";

export async function editCommand(
  id: string,
  opts: { title?: string; summary?: string; author?: string }
): Promise<void> {
  if (!opts.title && !opts.summary && !opts.author) {
    throw new Error("Provide at least one of --title, --summary, or --author. Usage: clog edit <id> [--title <title>] [--summary <summary>] [--author <author>]");
  }

  await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conv = ctx.getConversation(fullId);
    if (!conv) {
      throw new Error(`Conversation not found: ${fullId}. Run \`clog list --all\` to see available IDs.`);
    }
    if (conv.origin) {
      throw new Error(`Cannot edit a remote conversation (synced from ${conv.origin}). Run \`clog list --origin local\` to see local conversations.`);
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
    if (opts.author !== undefined) {
      updates.author = opts.author;
    }

    ctx.updateConversation(fullId, updates);

    // Mark for re-indexing if published and previously indexed
    if (conv.state === "published" && conv.indexedAt) {
      ctx.setIndexedAt(fullId, null);
    }

    const fields: string[] = [];
    if (opts.title !== undefined) fields.push("title");
    if (opts.summary !== undefined) fields.push("summary");
    if (opts.author !== undefined) fields.push("author");

    console.log(
      chalk.green("Updated") +
        ` ${fields.join(" and ")} for ${chalk.cyan(fullId.slice(0, 12))}`
    );
  });
}
