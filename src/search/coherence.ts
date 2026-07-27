import type { ConversationMeta } from "../models/conversation.js";
import {
  listConversations,
  setConversationIndexedAt,
} from "../db/index.js";
import { parseConversationMessages } from "../cli/common.js";
import { loadConfig } from "../config/index.js";
import { nowIso } from "../utils/time.js";
import { getSearchProviders, searchAvailable } from "./deps.js";
import { SearchNotConfiguredError } from "./errors.js";
import { indexConversation } from "./indexer.js";
import {
  hasCurrentSearchContracts,
  selectIndexEligibleConversations,
} from "./relationships.js";

export function isConversationSearchable(
  conversation: ConversationMeta | null | undefined,
): conversation is ConversationMeta {
  return Boolean(
    conversation &&
      conversation.state === "saved" &&
      conversation.indexedAt &&
      conversation.savedAt &&
      conversation.indexedAt >= conversation.savedAt &&
      hasCurrentSearchContracts(conversation),
  );
}

export async function listIndexEligibleConversationsNeedingIndex(
  options: {
    indexAllBranches?: boolean;
  } = {},
): Promise<ConversationMeta[]> {
  return selectIndexEligibleConversations(
    await listConversations(),
    options,
  ).filter(
    (conversation) =>
      conversation.savedAt != null &&
      (
        conversation.indexedAt == null ||
        conversation.indexedAt < conversation.savedAt
      ),
  );
}

export async function markConversationIndexStale(
  conversation: ConversationMeta,
): Promise<ConversationMeta> {
  if (conversation.state !== "saved" || !conversation.indexedAt) {
    return conversation;
  }

  await setConversationIndexedAt(conversation.id, null);
  return {
    ...conversation,
    indexedAt: null,
  };
}

export async function maybeReindexUpdatedConversation<T extends ConversationMeta>(
  conversation: T,
): Promise<T> {
  if (conversation.state !== "saved") {
    return conversation;
  }

  const config = await loadConfig();
  if (!config.search) {
    return {
      ...conversation,
      indexedAt: null,
    } as T;
  }

  if (!hasCurrentSearchContracts(conversation)) {
    return {
      ...conversation,
      indexedAt: null,
    } as T;
  }

  const eligibleIds = new Set(
    selectIndexEligibleConversations(
      replaceConversationsById(await listConversations(), [conversation]),
      { indexAllBranches: config.search.indexAllBranches },
    ).map((candidate) => candidate.id),
  );
  if (!eligibleIds.has(conversation.id)) {
    return {
      ...conversation,
      indexedAt: null,
    } as T;
  }

  try {
    const { embedding, vectorStore } = await getSearchProviders();
    const messages = await parseConversationMessages(config, conversation);
    await indexConversation(conversation, messages, embedding, vectorStore);
    return {
      ...conversation,
      indexedAt: nowIso(),
    } as T;
  } catch {
    return {
      ...conversation,
      indexedAt: null,
    } as T;
  }
}

export async function maybeAutoIndexConversations(
  conversations: ConversationMeta[],
  onProgress?: (completed: number, total: number) => void,
): Promise<{
  failedIds: string[];
  indexedIds: string[];
  skippedIds: string[];
}> {
  if (conversations.length === 0 || !(await searchAvailable())) {
    return {
      failedIds: [],
      indexedIds: [],
      skippedIds: conversations.map((conversation) => conversation.id),
    };
  }

  try {
    const config = await loadConfig();
    const { embedding, vectorStore } = await getSearchProviders();
    const eligibleIds = new Set(
      selectIndexEligibleConversations(
        replaceConversationsById(await listConversations(), conversations),
        { indexAllBranches: config.search?.indexAllBranches },
      ).map((conversation) => conversation.id),
    );
    const candidates = conversations.filter(
      (conversation) =>
        conversation.state === "saved" &&
        eligibleIds.has(conversation.id),
    );
    const failedIds = conversations
      .filter(
        (conversation) =>
          conversation.state === "saved" &&
          !hasCurrentSearchContracts(conversation),
      )
      .map((conversation) => conversation.id);
    const indexedIds: string[] = [];
    const skippedIds = conversations
      .filter(
        (conversation) =>
          hasCurrentSearchContracts(conversation) &&
          !eligibleIds.has(conversation.id),
      )
      .map((conversation) => conversation.id);
    let completed = 0;

    for (const conversation of candidates) {
      try {
        const messages = await parseConversationMessages(config, conversation);
        await indexConversation(conversation, messages, embedding, vectorStore);
        await setConversationIndexedAt(conversation.id, nowIso());
        indexedIds.push(conversation.id);
      } catch {
        failedIds.push(conversation.id);
      }
      completed += 1;
      onProgress?.(completed, candidates.length);
    }

    return { failedIds, indexedIds, skippedIds };
  } catch {
    return {
      failedIds: conversations.map((conversation) => conversation.id),
      indexedIds: [],
      skippedIds: [],
    };
  }
}

export async function tryDeleteConversationVectors(
  conversationIds: string[],
  onProgress?: (completed: number, total: number) => void,
): Promise<string[]> {
  if (conversationIds.length === 0) {
    return [];
  }

  try {
    const { vectorStore } = await getSearchProviders();
    const failures: string[] = [];

    for (const [index, conversationId] of conversationIds.entries()) {
      try {
        await vectorStore.delete(conversationId);
      } catch {
        failures.push(conversationId);
      }
      onProgress?.(index + 1, conversationIds.length);
    }

    return failures;
  } catch (error) {
    if (error instanceof SearchNotConfiguredError) {
      return [];
    }

    return conversationIds;
  }
}

function replaceConversationsById(
  existing: readonly ConversationMeta[],
  replacements: readonly ConversationMeta[],
): ConversationMeta[] {
  const replacementsById = new Map(
    replacements.map((conversation) => [conversation.id, conversation] as const),
  );
  return [
    ...existing.map(
      (conversation) => replacementsById.get(conversation.id) ?? conversation,
    ),
    ...replacements.filter(
      (conversation) =>
        !existing.some((candidate) => candidate.id === conversation.id),
    ),
  ];
}
