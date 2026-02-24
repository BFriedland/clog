import { rm } from "node:fs/promises";
import { withDb } from "../db/index.js";

export async function resetCommand(ids: string[]): Promise<void> {
  let count = 0;

  await withDb(async (ctx) => {
    for (const id of ids) {
      const resolvedId = ctx.resolveId(id);
      const conv = ctx.getConversation(resolvedId);
      if (!conv) {
        console.log(`Conversation not found: ${resolvedId}`);
        continue;
      }

      if (conv.state !== "staged" && conv.state !== "published") {
        console.log(
          `Skipping ${resolvedId.slice(0, 12)}... (state is ${conv.state})`
        );
        continue;
      }

      ctx.updateConversation(resolvedId, {
        state: "discovered",
        filePath: null,
      });

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

  console.log(`Reset ${count} conversation(s)`);
}
