import chalk from "chalk";
import { withDb } from "../db/index.js";
import { markConversationIndexStale } from "../search/coherence.js";

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

    const updates: Parameters<typeof ctx.updateConversation>[1] = {};
    let searchContentChanged = false;
    let metadataChanged = false;

    if (opts.title !== undefined) {
      if (opts.title !== conv.title) {
        updates.title = opts.title;
        searchContentChanged = true;
        metadataChanged = true;
      }
    }
    if (opts.summary !== undefined) {
      if (opts.summary !== conv.summary) {
        updates.summary = opts.summary;
        searchContentChanged = true;
        metadataChanged = true;
      }
    }
    if (opts.author !== undefined) {
      if (opts.author !== conv.author) {
        updates.author = opts.author;
        metadataChanged = true;
      }
    }

    if (!metadataChanged) {
      console.log(
        chalk.dim("No changes") +
          ` for ${chalk.cyan(fullId.slice(0, 7))}`
      );
      return;
    }

    updates.modifiedAt = new Date().toISOString();
    ctx.updateConversation(fullId, updates);
    if (searchContentChanged) {
      markConversationIndexStale(ctx, conv);
    }

    const fields: string[] = [];
    if (updates.title !== undefined) fields.push("title");
    if (updates.summary !== undefined) fields.push("summary");
    if (updates.author !== undefined) fields.push("author");

    console.log(
      chalk.green("Updated") +
        ` ${fields.join(" and ")} for ${chalk.cyan(fullId.slice(0, 7))}`
    );
  });
}
