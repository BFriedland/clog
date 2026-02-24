import { withDb } from "../db/index.js";

export async function unpublishCommand(ids: string[]): Promise<void> {
  let count = 0;

  await withDb(async (ctx) => {
    for (const id of ids) {
      const resolvedId = ctx.resolveId(id);
      const conv = ctx.getConversation(resolvedId);
      if (!conv) {
        console.log(`Conversation not found: ${resolvedId}`);
        continue;
      }

      if (conv.state !== "published") {
        console.log(
          `Skipping ${resolvedId.slice(0, 12)}... (state is ${conv.state}, not published)`
        );
        continue;
      }

      ctx.updateConversation(resolvedId, {
        state: "staged",
      });
      count++;
    }
  });

  console.log(`Unpublished ${count} conversation(s)`);
}
