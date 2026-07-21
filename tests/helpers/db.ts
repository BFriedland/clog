import type { ConversationMeta } from "../../src/models/conversation.js";
import { savedConversationMetaSchema } from "../../src/models/conversation.js";
import { withDb } from "../../src/db/index.js";
import {
  unsafeDeleteConversationInDb,
  unsafeInsertConversationInDb,
  unsafeUpdateLocalConversationInDb,
  unsafeUpdateConversationInDb,
} from "../../src/db/unsafe-conversations.js";

export async function insertConversation(
  conversation: ConversationMeta,
): Promise<void> {
  const saved = savedConversationMetaSchema.parse(conversation);
  await withDb((db) => unsafeInsertConversationInDb(db, saved), {
    mode: "write",
  });
}

export async function updateConversation(
  conversation: ConversationMeta,
): Promise<void> {
  const saved = savedConversationMetaSchema.parse(conversation);
  await withDb((db) => unsafeUpdateConversationInDb(db, saved), {
    mode: "write",
  });
}

export async function guardedLocalUpdateConversation(
  conversation: ConversationMeta,
): Promise<number> {
  const saved = savedConversationMetaSchema.parse(conversation);
  return withDb((db) => unsafeUpdateLocalConversationInDb(db, saved), {
    mode: "write",
  });
}

export async function deleteConversation(id: string): Promise<void> {
  await withDb((db) => unsafeDeleteConversationInDb(db, id), { mode: "write" });
}
