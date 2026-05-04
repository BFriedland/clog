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
  maxMessages: z.number().int().positive().max(200).optional(),
  head: z.number().int().positive().max(200).optional(),
  tail: z.number().int().positive().max(200).optional(),
  offset: z.number().int().nonnegative().optional(),
  limit: z.number().int().positive().max(200).optional(),
});

type GetInput = z.infer<typeof getInputSchema>;

interface MessageRange {
  mode: "tail" | "head" | "window";
  startIndex: number;
  endIndex: number;
  returnedMessages: number;
  pageSize: number;
  hasMoreBefore: boolean;
  hasMoreAfter: boolean;
  previousOffset?: number;
  nextOffset?: number;
}

interface SelectedRange {
  range: MessageRange;
  requestedOffset?: number;
}

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

export async function handleListSaved(input: unknown) {
  const parsed = listInputSchema.parse(input ?? {});
  return listConversationsForState("saved", parsed);
}

export async function handleListStaged(input: unknown) {
  const parsed = listInputSchema.parse(input ?? {});
  return listConversationsForState("staged", parsed);
}

export async function handleGet(input: unknown) {
  const parsed = getInputSchema.parse(input);
  validateRangeControls(parsed);
  const config = await loadConfig();
  const conversation = await resolveConversationByInput(parsed.id);

  if (conversation.state === "discovered") {
    throw new Error("clog_get only works on staged or saved conversations.");
  }

  const messages = await parseConversationMessages(config, conversation);
  const selected = selectMessageRange(parsed, messages.length);
  const { range } = selected;
  const truncated = range.hasMoreBefore || range.hasMoreAfter;

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
    messages: messages.slice(range.startIndex, range.endIndex),
    totalMessages: messages.length,
    range,
    truncated,
    truncationNote: truncated ? buildTruncationNote(selected, messages.length) : undefined,
  };
}

function selectMessageRange(input: GetInput, totalMessages: number): SelectedRange {
  if (input.head !== undefined) {
    return buildRange("head", 0, Math.min(input.head, totalMessages), input.head, totalMessages);
  }

  if (input.offset !== undefined) {
    const pageSize = input.limit ?? 20;
    const startIndex = Math.min(input.offset, totalMessages);
    const endIndex = Math.min(startIndex + pageSize, totalMessages);
    return {
      ...buildRange("window", startIndex, endIndex, pageSize, totalMessages),
      requestedOffset: input.offset,
    };
  }

  const pageSize = input.tail ?? input.maxMessages ?? 20;
  const startIndex = Math.max(0, totalMessages - pageSize);
  return buildRange("tail", startIndex, totalMessages, pageSize, totalMessages);
}

function validateRangeControls(input: GetInput): void {
  const activeModes = [
    input.maxMessages !== undefined ? "maxMessages" : null,
    input.head !== undefined ? "head" : null,
    input.tail !== undefined ? "tail" : null,
    input.offset !== undefined ? "offset/limit" : null,
  ].filter(Boolean);

  if (activeModes.length > 1) {
    throw new Error("Choose only one message range: maxMessages, head, tail, or offset/limit.");
  }

  if (input.limit !== undefined && input.offset === undefined) {
    throw new Error("limit can only be used with offset. Use head to request the first N messages.");
  }
}

function buildRange(
  mode: MessageRange["mode"],
  startIndex: number,
  endIndex: number,
  pageSize: number,
  totalMessages: number,
): SelectedRange {
  const range: MessageRange = {
    mode,
    startIndex,
    endIndex,
    returnedMessages: endIndex - startIndex,
    pageSize,
    hasMoreBefore: startIndex > 0,
    hasMoreAfter: endIndex < totalMessages,
  };

  if (range.hasMoreBefore) {
    range.previousOffset = Math.max(0, startIndex - pageSize);
  }

  if (range.hasMoreAfter) {
    range.nextOffset = endIndex;
  }

  return { range };
}

function buildTruncationNote(selected: SelectedRange, totalMessages: number): string {
  const { range, requestedOffset } = selected;
  const previous = range.hasMoreBefore
    ? `Request offset ${range.previousOffset} with limit ${range.pageSize} for the previous window.`
    : undefined;
  const next = range.hasMoreAfter
    ? `Request offset ${range.nextOffset} with limit ${range.pageSize} for the next window.`
    : undefined;

  if (
    range.mode === "window" &&
    requestedOffset !== undefined &&
    requestedOffset >= totalMessages
  ) {
    return [
      `Requested offset ${requestedOffset} is beyond the ${totalMessages}-message conversation.`,
      previous,
    ].filter(Boolean).join(" ");
  }

  if (range.mode === "tail") {
    return `Showing the last ${range.returnedMessages} of ${totalMessages} messages. Request head or offset/limit to inspect earlier messages.`;
  }

  const shownRange =
    range.returnedMessages > 0
      ? `Showing messages ${range.startIndex + 1}-${range.endIndex} of ${totalMessages}.`
      : `Showing no messages from the ${totalMessages}-message conversation.`;

  return [shownRange, next, previous].filter(Boolean).join(" ");
}

export async function handleUpdate(input: unknown) {
  const parsed = updateInputSchema.parse(input);
  const conversation = await resolveConversationByInput(parsed.id);

  if (conversation.state === "discovered") {
    throw new Error("clog_update only works on staged or saved conversations.");
  }

  if (conversation.origin != null) {
    throw new Error(
      `clog_update cannot modify conversation ${conversation.id.slice(0, 8)} — it came from the remote and is read-only.`,
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
    conversation.state === "saved" &&
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
  let saved = await listConversations({
    states: ["saved"],
    projectName: parsed.project,
    author: parsed.author,
    origin: parsed.origin,
  });

  if (parsed.tags && parsed.tags.length > 0) {
    const tags = new Set(normalizeTags(parsed.tags));
    saved = saved.filter((conversation) =>
      conversation.tags.some((tag) => tags.has(tag)),
    );
  }

  const searchableIds = new Set(
    saved
      .filter((conversation) => isConversationSearchable(conversation))
      .map((conversation) => conversation.id),
  );

  if (searchableIds.size === 0) {
    return {
      results: [],
      totalCount: 0,
      indexCoverage: {
        indexed: 0,
        saved: saved.length,
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
    saved.map((conversation) => [conversation.id, conversation] as const),
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
      saved: saved.length,
    },
    warning,
  };
}

async function listConversationsForState(
  state: "staged" | "saved",
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
