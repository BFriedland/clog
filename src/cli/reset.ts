import { rm } from "node:fs/promises";
import { withDb } from "../db/index.js";
import { deindexConversations } from "../search/coherence.js";

export async function resetCommand(ids: string[]): Promise<void> {
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

      if (conv.state !== "staged" && conv.state !== "published") {
        console.error(
          `Skipping ${resolvedId.slice(0, 7)} (state is ${conv.state}, try \`clog add\` first)`
        );
        continue;
      }

      const isPublished = conv.state === "published";
      ctx.updateConversation(resolvedId, {
        state: "discovered",
        filePath: null,
        ...(isPublished ? { indexedAt: null } : {}),
      });
      if (isPublished) {
        deindexIds.push(resolvedId);
      }

      if (conv.filePath) {
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
  console.log(`Reset ${count} conversation(s)`);
}
