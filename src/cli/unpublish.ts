import { withDb } from "../db/index.js";

export async function unpublishCommand(ids: string[]): Promise<void> {
  let count = 0;

  await withDb(async (ctx) => {
    for (const id of ids) {
      const resolvedId = ctx.resolveId(id);
      const conv = ctx.getConversation(resolvedId);
      if (!conv) {
        console.error(`Conversation not found: ${resolvedId}. Run \`clog list --all\` to see available IDs.`);
        continue;
      }

      if (conv.origin) {
        console.error(
          `Skipping ${resolvedId.slice(0, 7)} (remote conversation, synced from ${conv.origin}). Run \`clog list --origin local\` to see local conversations.`
        );
        continue;
      }

      if (conv.state !== "published") {
        console.error(
          `Skipping ${resolvedId.slice(0, 7)} (state is ${conv.state}, not published). Run \`clog publish <id>\` first.`
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
