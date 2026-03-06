import chalk from "chalk";
import { withDb } from "../db/index.js";

export async function tagCommand(id: string, tags: string[]): Promise<void> {
  await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conv = ctx.getConversation(fullId);
    if (!conv) {
      throw new Error(`Conversation not found: ${fullId}`);
    }
    if (conv.origin) {
      throw new Error(`Cannot tag a remote conversation (synced from ${conv.origin}).`);
    }

    // Normalize: lowercase, trim, deduplicate
    const normalized = [...new Set(tags.map((t) => t.trim().toLowerCase()).filter(Boolean))];

    // Merge with existing, avoiding duplicates
    const existing = new Set(conv.tags);
    const added: string[] = [];
    for (const tag of normalized) {
      if (!existing.has(tag)) {
        existing.add(tag);
        added.push(tag);
      }
    }

    ctx.updateConversation(fullId, {
      tags: [...existing],
      modifiedAt: new Date().toISOString(),
    });

    if (added.length > 0) {
      console.log(
        chalk.green("Tagged") +
          ` ${chalk.cyan(fullId.slice(0, 12))} with ${added.map((t) => chalk.yellow(t)).join(", ")}`
      );
    } else {
      console.log(
        chalk.dim("No new tags added") +
          ` (already present on ${chalk.cyan(fullId.slice(0, 12))})`
      );
    }
  });
}
