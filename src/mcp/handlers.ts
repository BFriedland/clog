import { z } from "zod";

import { loadConfig } from "../config/index.js";
import { browseValues, getConversationById, listConversations, resolveConversationId, updateConversation } from "../db/index.js";
import { type ConversationMeta } from "../models/conversation.js";
import { getSearchProviders } from "../search/deps.js";
import { SearchDepsError, SearchNotConfiguredError } from "../search/errors.js";
import { isConversationSearchable, maybeReindexUpdatedConversation } from "../search/coherence.js";
import { searchConversations } from "../search/indexer.js";
import { nowIso } from "../utils/time.js";
import { filterConversationsByGrep, parseConversationMessages } from "../cli/common.js";

const listInputSchema = z.object({
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  author: z.string().optional(),
  grep: z.string().optional(),
  origin: z.enum(["local", "remote"]).optional(),
  limit: z.number().int().positive().max(100).default(20),
  offset: z.number().int().nonnegative().default(0),
});

const getInputSchema = z.object({
  id: z.string(),
  maxMessages: z.number().int().positive().max(200).default(20),
});

const updateInputSchema = z.object({
  id: z.string(),
  title: z.string().optional(),
  summary: z.string().optional(),
  addTags: z.array(z.string()).optional(),
  removeTags: z.array(z.string()).optional(),
});

const browseInputSchema = z.object({
  by: z.enum(["tags", "projects", "authors"]),
});

const searchInputSchema = z.object({
  query: z.string(),
  tags: z.array(z.string()).optional(),
  project: z.string().optional(),
  author: z.string().optional(),
  origin: z.enum(["local", "remote"]).optional(),
  limit: z.number().int().positive().max(50).default(10),
});

export async function handleListPublished(input: unknown) {
  const parsed = listInputSchema.parse(input ?? {});
  return listConversationsForState("published", parsed);
}

export async function handleListStaged(input: unknown) {
  const parsed = listInputSchema.parse(input ?? {});
  return listConversationsForState("staged", parsed);
}

export async function handleGet(input: unknown) {
  const parsed = getInputSchema.parse(input);
  const config = await loadConfig();
  const conversation = await resolveConversationByInput(parsed.id);

  if (conversation.state === "discovered") {
    throw new Error("clog_get only works on staged or published conversations.");
  }

  const messages = await parseConversationMessages(config, conversation);
  const startIndex = Math.max(0, messages.length - parsed.maxMessages);
  const truncated = startIndex > 0;

  return {
    id: conversation.id,
    source: conversation.source,
    title: conversation.title,
    summary: conversation.summary,
    tags: conversation.tags,
    author: conversation.author,
    projectName: conversation.projectName,
    state: conversation.state,
    createdAt: conversation.createdAt,
    messages: messages.slice(startIndex),
    totalMessages: messages.length,
    truncated,
    truncationNote: truncated
      ? `Showing the last ${parsed.maxMessages} of ${messages.length} messages. Request a larger maxMessages value to retrieve more.`
      : undefined,
  };
}

export async function handleUpdate(input: unknown) {
  const parsed = updateInputSchema.parse(input);
  const conversation = await resolveConversationByInput(parsed.id);

  if (conversation.state === "discovered") {
    throw new Error("clog_update only works on staged or published conversations.");
  }

  if (conversation.origin != null) {
    throw new Error(
      `clog_update cannot modify conversation ${conversation.id.slice(0, 7)} — it came from the remote and is read-only.`,
    );
  }

  const addTags = normalizeTags(parsed.addTags ?? []);
  const removeTags = new Set(normalizeTags(parsed.removeTags ?? []));
  const nextTags = [...new Set([...conversation.tags, ...addTags])].filter(
    (tag) => !removeTags.has(tag),
  );

  const updated = {
    ...conversation,
    title: parsed.title ?? conversation.title,
    summary: parsed.summary ?? conversation.summary,
    tags: nextTags,
  };

  const changed =
    updated.title !== conversation.title ||
    updated.summary !== conversation.summary ||
    JSON.stringify(updated.tags) !== JSON.stringify(conversation.tags);

  if (!changed) {
    return { conversation: summarizeConversation(conversation) };
  }

  const nextConversation = {
    ...updated,
    modifiedAt: nowIso(),
  };
  const finalConversation =
    conversation.state === "published" &&
    (
      updated.title !== conversation.title ||
      updated.summary !== conversation.summary
    )
      ? await maybeReindexUpdatedConversation(nextConversation)
      : nextConversation;
  await updateConversation(finalConversation);

  return {
    conversation: summarizeConversation(finalConversation),
  };
}

export async function handleBrowse(input: unknown) {
  const parsed = browseInputSchema.parse(input);
  const field =
    parsed.by === "tags"
      ? "tags_json"
      : parsed.by === "projects"
        ? "project_name"
        : "author";

  const items = await browseValues(field);
  return { items };
}

export async function handleSearch(input: unknown) {
  const parsed = searchInputSchema.parse(input);
  const { embedding, vectorStore } = await requireSearchProviders();
  let published = await listConversations({
    states: ["published"],
    projectName: parsed.project,
    author: parsed.author,
    origin: parsed.origin,
  });

  if (parsed.tags && parsed.tags.length > 0) {
    const tags = new Set(normalizeTags(parsed.tags));
    published = published.filter((conversation) =>
      conversation.tags.some((tag) => tags.has(tag)),
    );
  }

  const searchableIds = new Set(
    published
      .filter((conversation) => isConversationSearchable(conversation))
      .map((conversation) => conversation.id),
  );

  if (searchableIds.size === 0) {
    return {
      results: [],
      totalCount: 0,
      indexCoverage: {
        indexed: 0,
        published: published.length,
      },
    };
  }

  let warning: string | undefined;
  const hits = await searchConversations(parsed.query, parsed.limit, embedding, vectorStore, {
    isConversationSearchable: (conversationId) => searchableIds.has(conversationId),
    onScanCapReached: () => {
      warning = "Search hit the maximum scan window; completeness is not guaranteed.";
    },
  });

  const conversationsById = new Map(
    published.map((conversation) => [conversation.id, conversation] as const),
  );
  const results = hits
    .map((hit) => {
      const conversation = conversationsById.get(hit.conversationId);
      if (!conversation || !isConversationSearchable(conversation)) {
        return null;
      }

      return {
        id: conversation.id,
        source: conversation.source,
        title: conversation.title,
        summary: conversation.summary,
        tags: conversation.tags,
        author: conversation.author,
        projectName: conversation.projectName,
        createdAt: conversation.createdAt,
        relevanceScore: hit.score,
        snippet: hit.text.replace(/\s+/g, " ").trim().slice(0, 200),
      };
    })
    .filter((result): result is NonNullable<typeof result> => Boolean(result));

  return {
    results,
    totalCount: results.length,
    indexCoverage: {
      indexed: searchableIds.size,
      published: published.length,
    },
    warning,
  };
}

async function listConversationsForState(
  state: "staged" | "published",
  input: z.infer<typeof listInputSchema>,
) {
  let conversations = await listConversations({
    states: [state],
    projectName: input.project,
    author: input.author,
    origin: input.origin,
  });

  if (input.tags && input.tags.length > 0) {
    const tags = new Set(normalizeTags(input.tags));
    conversations = conversations.filter((conversation) =>
      conversation.tags.some((tag) => tags.has(tag)),
    );
  }

  if (input.grep) {
    const config = await loadConfig();
    conversations = await filterConversationsByGrep(config, input.grep, conversations);
  }

  const totalCount = conversations.length;
  const page = conversations
    .slice(input.offset, input.offset + input.limit)
    .map((conversation) => ({
      id: conversation.id,
      source: conversation.source,
      title: conversation.title,
      summary: conversation.summary,
      tags: conversation.tags,
      author: conversation.author,
      projectName: conversation.projectName,
      createdAt: conversation.createdAt,
    }));

  return {
    conversations: page,
    totalCount,
  };
}

async function resolveConversationByInput(input: string): Promise<ConversationMeta> {
  const resolved = await resolveConversationId(input);
  const conversation = await getConversationById(resolved.id);
  if (!conversation) {
    throw new Error(`Conversation "${input}" not found.`);
  }

  return conversation;
}

function normalizeTags(tags: string[]): string[] {
  return [...new Set(tags.map((tag) => tag.trim().toLowerCase()).filter(Boolean))];
}

function summarizeConversation(conversation: ConversationMeta) {
  return {
    id: conversation.id,
    source: conversation.source,
    title: conversation.title,
    summary: conversation.summary,
    tags: conversation.tags,
    author: conversation.author,
    projectName: conversation.projectName,
    state: conversation.state,
    createdAt: conversation.createdAt,
    modifiedAt: conversation.modifiedAt,
  };
}

async function requireSearchProviders() {
  try {
    return await getSearchProviders();
  } catch (error) {
    if (error instanceof SearchNotConfiguredError || error instanceof SearchDepsError) {
      throw error;
    }

    throw error;
  }
}
