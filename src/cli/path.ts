import { withDb } from "../db/index.js";
import { resolveContentPath } from "../sync/resolve-content-path.js";

export async function pathCommand(id: string): Promise<void> {
  await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    const conv = ctx.getConversation(fullId);
    if (!conv) {
      throw new Error(`Conversation not found: ${fullId}. Run \`clog list --all\` to see available IDs.`);
    }

    console.log(resolveContentPath(conv));
  });
}
