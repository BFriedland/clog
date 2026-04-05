import { rm } from "node:fs/promises";
import { withDb } from "../db/index.js";
import { addExcluded } from "./excluded.js";
import { deindexConversations } from "../search/coherence.js";

export async function excludeCommand(ids: string[]): Promise<void> {
  let count = 0;
  const deindexIds: string[] = [];

  await withDb(async (ctx) => {
    for (const id of ids) {
      const resolvedId = ctx.resolveId(id);
      const conv = ctx.getConversation(resolvedId);
      if (!conv) {
        console.error(`Conversation not found: ${resolvedId}. Run \`clog list --all\` to see available IDs.`);
        continue;
      }

      await addExcluded(conv.source, conv.sourceId);
      deindexIds.push(resolvedId);
      ctx.deleteConversation(resolvedId);

      if (conv.filePath && !conv.origin) {
        try {
          await rm(conv.filePath);
        } catch (err) {
          if ((err as NodeJS.ErrnoException).code !== "ENOENT") throw err;
        }
      }
      count++;
    }
  });

  await deindexConversations(deindexIds);
  console.log(`Excluded ${count} conversation(s)`);
}
