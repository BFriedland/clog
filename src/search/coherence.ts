import type { DbContext } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";

export function isConversationSearchable(
  conv: ConversationMeta | null | undefined,
): conv is ConversationMeta {
  return Boolean(
    conv &&
    conv.state === "published" &&
    conv.indexedAt,
  );
}

export function markConversationIndexStale(
  ctx: DbContext,
  conv: ConversationMeta,
): void {
  if (conv.state === "published" && conv.indexedAt) {
    ctx.setIndexedAt(conv.id, null);
  }
}

export async function deindexConversations(ids: string[]): Promise<void> {
  if (ids.length === 0) return;

  try {
    const { getSearchProviders } = await import("./deps.js");
    const { vectorStore } = await getSearchProviders();

    for (const id of ids) {
      try {
        await vectorStore.delete(id);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        console.error(
          `warning: failed to deindex ${id.slice(0, 7)}: ${message}`,
        );
      }
    }
  } catch (err) {
    if (
      err instanceof Error &&
      err.name === "SearchNotConfiguredError"
    ) {
      return;
    }
    const message = err instanceof Error ? err.message : String(err);
    console.error(`warning: failed to initialize deindexing: ${message}`);
  }
}
