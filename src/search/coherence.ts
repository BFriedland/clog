import type { ConversationMeta } from "../models/conversation.js";
import { getConversationById, setConversationIndexedAt } from "../db/index.js";
import { parseConversationMessages } from "../cli/common.js";
import { loadConfig } from "../config/index.js";
import { nowIso } from "../utils/time.js";
import { getSearchProviders, searchAvailable } from "./deps.js";
import { SearchNotConfiguredError } from "./errors.js";
import { indexConversation } from "./indexer.js";

export function isConversationSearchable(
  conversation: ConversationMeta | null | undefined,
): conversation is ConversationMeta {
  return Boolean(conversation && conversation.state === "published" && conversation.indexedAt);
}

export async function markConversationIndexStale(
  conversation: ConversationMeta,
): Promise<ConversationMeta> {
  if (conversation.state !== "published" || !conversation.indexedAt) {
    return conversation;
  }

  await setConversationIndexedAt(conversation.id, null);
  return {
    ...conversation,
    indexedAt: null,
  };
}

export async function maybeReindexUpdatedConversation(
  conversation: ConversationMeta,
): Promise<ConversationMeta> {
  if (conversation.state !== "published") {
    return conversation;
  }

  const config = await loadConfig();
  if (!config.search) {
    return conversation;
  }

  try {
    const { embedding, vectorStore } = await getSearchProviders();
    const messages = await parseConversationMessages(config, conversation);
    await indexConversation(conversation, messages, embedding, vectorStore);
    return {
      ...conversation,
      indexedAt: nowIso(),
    };
  } catch {
    return {
      ...conversation,
      indexedAt: null,
    };
  }
}

export async function maybeAutoIndexConversations(
  conversations: ConversationMeta[],
): Promise<string[]> {
  if (conversations.length === 0 || !(await searchAvailable())) {
    return [];
  }

  try {
    const config = await loadConfig();
    const { embedding, vectorStore } = await getSearchProviders();
    const failures: string[] = [];

    for (const conversation of conversations) {
      if (conversation.state !== "published") {
        continue;
      }

      try {
        const messages = await parseConversationMessages(config, conversation);
        await indexConversation(conversation, messages, embedding, vectorStore);
        await setConversationIndexedAt(conversation.id, nowIso());
      } catch {
        failures.push(conversation.id);
      }
    }

    return failures;
  } catch {
    return conversations.map((conversation) => conversation.id);
  }
}

export async function tryDeleteConversationVectors(
  conversationIds: string[],
): Promise<string[]> {
  if (conversationIds.length === 0) {
    return [];
  }

  try {
    const { vectorStore } = await getSearchProviders();
    const failures: string[] = [];

    for (const conversationId of conversationIds) {
      try {
        await vectorStore.delete(conversationId);
      } catch {
        failures.push(conversationId);
      }
    }

    return failures;
  } catch (error) {
    if (error instanceof SearchNotConfiguredError) {
      return [];
    }

    return conversationIds;
  }
}

export async function ensureConversationSearchable(
  conversationId: string,
): Promise<boolean> {
  const conversation = await getConversationById(conversationId);
  return isConversationSearchable(conversation);
}
