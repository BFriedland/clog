import chalk from "chalk";
import { withDb } from "../db/index.js";

export async function untagCommand(id: string, tags: string[]): Promise<void> {
  await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conv = ctx.getConversation(fullId);
    if (!conv) {
      throw new Error(`Conversation not found: ${fullId}`);
    }
    if (conv.origin) {
      throw new Error(`Cannot untag a remote conversation (synced from ${conv.origin}).`);
    }

    // Normalize tags to remove
    const toRemove = new Set(tags.map((t) => t.trim().toLowerCase()));

    // Filter out the specified tags (silent if not present)
    const remaining = conv.tags.filter((t) => !toRemove.has(t));

    ctx.updateConversation(fullId, {
      tags: remaining,
      modifiedAt: new Date().toISOString(),
    });

    const removed = conv.tags.filter((t) => toRemove.has(t));
    if (removed.length > 0) {
      console.log(
        chalk.green("Removed") +
          ` ${removed.map((t) => chalk.yellow(t)).join(", ")} from ${chalk.cyan(fullId.slice(0, 12))}`
      );
    } else {
      console.log(
        chalk.dim("No matching tags found") +
          ` on ${chalk.cyan(fullId.slice(0, 12))}`
      );
    }
  });
}
