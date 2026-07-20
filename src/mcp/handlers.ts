import { z } from "zod";

import { loadConfig } from "../config/index.js";
import {
  browseValues,
  getConversationById,
  listConversations,
  resolveConversationId,
  updateLocalConversation,
} from "../db/index.js";
import {
  type ConversationMeta,
  summaryExtractionInputSchema,
  type SummaryExtraction,
} from "../models/conversation.js";
import {
  ANALYSIS_SUGGESTIONS,
  ANALYSIS_SUGGESTIONS_VERSION,
} from "./guides/analysis-suggestions.js";
import {
  SUMMARIZATION_GUIDE,
  SUMMARIZATION_GUIDE_VERSION,
} from "./guides/summarization.js";
import { getSearchProviders } from "../search/deps.js";
import { SearchDepsError, SearchNotConfiguredError, SearchSetupIncompleteError } from "../search/errors.js";
import { isConversationSearchable, maybeReindexUpdatedConversation } from "../search/coherence.js";
import { searchConversations } from "../search/indexer.js";
import { nowIso } from "../utils/time.js";
import {
  filterConversationsByGrep,
  getScanWarningsForCommand,
  parseConversationMessages,
} from "../cli/common.js";
import { scanLocalSources } from "../cli/scan.js";
import { requireLocalConversation } from "../conversations/write-guards.js";

const listSortBySchema = z.enum([
  "createdAt",
  "savedAt",
  "modifiedAt",
  "title",
  "project",
  "author",
]);
const listSortDirectionSchema = z.enum(["asc", "desc"]);

export const listInputSchema = z.object({
  state: z
    .enum(["saved", "unsaved", "all"])
    .default("saved")
    .describe(
      "Defaults to saved. Use unsaved or all only when the user asks about unsaved conversations or needs a complete saved-and-unsaved view. Either value scans all enabled coding-agent transcript sources before listing.",
    ),
  tags: z
    .array(z.string())
    .optional()
    .describe("Filter by tags using OR semantics after tag normalization."),
  project: z
    .string()
    .optional()
    .describe("Filter by project using case-insensitive substring matching."),
  author: z
    .string()
    .optional()
    .describe("Filter by author metadata using case-insensitive substring matching."),
  grep: z
    .string()
    .optional()
    .describe("Case-insensitive substring match on title, summary, or message content."),
  origin: z
    .enum(["local", "remote"])
    .optional()
    .describe("Use local for locally writable rows, remote for imported read-only rows."),
  limit: z
    .number()
    .int()
    .positive()
    .max(100)
    .default(20)
    .describe("Maximum conversations to return. Defaults to 20; maximum is 100."),
  offset: z
    .number()
    .int()
    .nonnegative()
    .default(0)
    .describe("Zero-based result offset for pagination. Use nextOffset when hasMore is true."),
  sortBy: listSortBySchema
    .default("createdAt")
    .describe("Sort field. Defaults to createdAt."),
  sortDirection: listSortDirectionSchema
    .default("desc")
    .describe("Sort direction. Defaults to desc."),
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

type ListSortBy = z.infer<typeof listSortBySchema>;
type ListSortDirection = z.infer<typeof listSortDirectionSchema>;

export const updateInputSchema = z
  .object({
    id: z.string(),
    title: z.string().optional(),
    summary: z.string().optional(),
    extraction: summaryExtractionInputSchema.nullable().optional(),
    summaryKind: z.enum(["generated", "curated"]).optional(),
    addTags: z.array(z.string()).optional(),
    removeTags: z.array(z.string()).optional(),
  })
  .strict();

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

export async function handleList(input: unknown) {
  const parsed = listInputSchema.parse(input ?? {});
  const states = parsed.state === "all" ? undefined : [parsed.state];
  const scansLocalSources = parsed.state === "unsaved" || parsed.state === "all";
  const config = scansLocalSources || parsed.grep ? await loadConfig() : undefined;
  const warnings = scansLocalSources
    ? getScanWarningsForCommand(await scanLocalSources(config!))
    : [];

  return listConversationsForStates(states, parsed, config?.author, config, warnings);
}

export async function handleGet(input: unknown) {
  const parsed = getInputSchema.parse(input);
  validateRangeControls(parsed);
  const config = await loadConfig();
  const conversation = await resolveConversationByInput(parsed.id);

  if (conversation.state === "unsaved") {
    throw new Error("clog_get only works on saved conversations.");
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
    summaryKind: conversation.summaryKind,
    extraction: conversation.summaryExtraction,
    tags: conversation.tags,
    author: conversation.author,
    project: conversation.projectName,
    originKind: conversation.originKind,
    originRef: conversation.originRef,
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

  if (conversation.state === "unsaved") {
    throw new Error("clog_update only works on saved conversations.");
  }

  requireLocalConversation(conversation, "clog_update");

  const addTags = normalizeTags(parsed.addTags ?? []);
  const removeTags = new Set(normalizeTags(parsed.removeTags ?? []));
  const nextTags = [...new Set([...conversation.tags, ...addTags])].filter(
    (tag) => !removeTags.has(tag),
  );

  const nextSummary = parsed.summary ?? conversation.summary;
  const summaryProvided = parsed.summary !== undefined;
  const extractionProvided = parsed.extraction !== undefined;
  const nextExtraction = extractionProvided
    ? (parsed.extraction as SummaryExtraction | null)
    : conversation.summaryExtraction;

  // summaryKind reflects who wrote the prose summary. Adding structure to an
  // existing curated summary does not change that — the prose is still curated.
  // Defaults:
  //   - prose changes via MCP: 'generated' (agent wrote it), unless the caller
  //     explicitly passes 'curated' to mark a user-directed fix.
  //   - clearing both prose and extraction: 'none'.
  //   - extraction changes only: leave summaryKind as is.
  let nextSummaryKind = conversation.summaryKind;
  const summaryTextChanged =
    summaryProvided && nextSummary !== conversation.summary;
  const hasNoSummaryMetadata = !nextSummary.trim() && nextExtraction == null;

  if (hasNoSummaryMetadata) {
    nextSummaryKind = "none";
  } else if (parsed.summaryKind !== undefined) {
    nextSummaryKind = parsed.summaryKind;
  } else if (summaryTextChanged && nextSummary.trim()) {
    // Only default to 'generated' when there's actual prose. Clearing the
    // prose while leaving an extraction behind shouldn't claim the result
    // was newly generated; the existing kind is more honest.
    nextSummaryKind = "generated";
  }

  const updated = {
    ...conversation,
    title: parsed.title ?? conversation.title,
    summary: nextSummary,
    summaryKind: nextSummaryKind,
    summaryExtraction: nextExtraction,
    tags: nextTags,
  };

  const extractionChanged =
    JSON.stringify(conversation.summaryExtraction ?? null) !==
    JSON.stringify(updated.summaryExtraction ?? null);

  const changed =
    updated.title !== conversation.title ||
    updated.summary !== conversation.summary ||
    updated.summaryKind !== conversation.summaryKind ||
    extractionChanged ||
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
  await updateLocalConversation(finalConversation, { command: "clog_update" });

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
    origin: parsed.origin,
  });
  saved = filterConversationsByMcpMetadata(saved, parsed);

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
  let hits;
  try {
    hits = await searchConversations(parsed.query, parsed.limit, embedding, vectorStore, {
      isConversationSearchable: (conversationId) => searchableIds.has(conversationId),
      onScanCapReached: () => {
        warning = "Search hit the maximum scan window; completeness is not guaranteed.";
      },
    });
  } catch (error) {
    if (
      error instanceof SearchNotConfiguredError ||
      error instanceof SearchDepsError ||
      error instanceof SearchSetupIncompleteError
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new Error(
      `Search failed: ${detail}\nIf this looks like a vector-index issue (e.g. after changing the embedding model), try \`clog index --rebuild\`.`,
    );
  }

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
        summaryKind: conversation.summaryKind,
        extraction: conversation.summaryExtraction,
        tags: conversation.tags,
        author: conversation.author,
        project: conversation.projectName,
        originKind: conversation.originKind,
        originRef: conversation.originRef,
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

async function listConversationsForStates(
  states: Array<"saved" | "unsaved"> | undefined,
  input: z.infer<typeof listInputSchema>,
  configuredAuthor: string | undefined,
  config: Awaited<ReturnType<typeof loadConfig>> | undefined,
  warnings: ReturnType<typeof getScanWarningsForCommand>,
) {
  let conversations = await listConversations({
    states,
    origin: input.origin,
  });
  conversations = conversations.map((conversation) =>
    normalizeUnsavedConversation(conversation, configuredAuthor),
  );
  conversations = filterConversationsByMcpMetadata(conversations, input);

  if (input.tags && input.tags.length > 0) {
    const tags = new Set(normalizeTags(input.tags));
    conversations = conversations.filter((conversation) =>
      conversation.tags.some((tag) => tags.has(tag)),
    );
  }

  if (input.grep) {
    conversations = await filterConversationsByGrep(config!, input.grep, conversations);
  }

  conversations = sortConversationsForMcpList(
    conversations,
    input.sortBy,
    input.sortDirection,
  );

  const totalCount = conversations.length;
  const page = conversations
    .slice(input.offset, input.offset + input.limit)
    .map((conversation) => ({
      id: conversation.id,
      source: conversation.source,
      title: conversation.title,
      summary: conversation.summary,
      summaryKind: conversation.summaryKind,
      extraction: conversation.summaryExtraction,
      tags: conversation.tags,
      author: conversation.author,
      project: conversation.projectName,
      originKind: conversation.originKind,
      originRef: conversation.originRef,
      state: conversation.state,
      createdAt: conversation.createdAt,
      modifiedAt: conversation.modifiedAt,
      savedAt: conversation.savedAt,
      savedMessageCount: conversation.savedMessageCount,
      sourceMtime: conversation.sourceMtime,
    }));
  const returnedCount = page.length;
  const nextOffset = input.offset + input.limit;
  const hasMore = nextOffset < totalCount;

  const result = {
    conversations: page,
    totalCount,
    limit: input.limit,
    offset: input.offset,
    sortBy: input.sortBy,
    sortDirection: input.sortDirection,
    returnedCount,
    hasMore,
    nextOffset: hasMore ? nextOffset : undefined,
    paginationNote: hasMore
      ? `More conversations are available. Request offset ${nextOffset} with limit ${input.limit} for the next page.`
      : undefined,
  };

  return warnings.length > 0 ? { ...result, warnings } : result;
}

function normalizeUnsavedConversation(
  conversation: ConversationMeta,
  configuredAuthor: string | undefined,
): ConversationMeta {
  if (conversation.state === "saved") {
    return conversation;
  }

  if (configuredAuthor === undefined) {
    throw new Error("Current configuration is required to list unsaved conversations.");
  }

  return {
    ...conversation,
    author: configuredAuthor,
    tags: [],
    modifiedAt: conversation.sourceMtime ?? conversation.modifiedAt,
    summaryExtraction: null,
    savedAt: null,
    savedMessageCount: null,
    originKind: "local",
    originRef: null,
  };
}

function sortConversationsForMcpList(
  conversations: ConversationMeta[],
  sortBy: ListSortBy,
  sortDirection: ListSortDirection,
): ConversationMeta[] {
  return [...conversations].sort((left, right) => {
    const compared = compareConversationListField(left, right, sortBy, sortDirection);
    return compared === 0 ? left.id.localeCompare(right.id) : compared;
  });
}

function compareConversationListField(
  left: ConversationMeta,
  right: ConversationMeta,
  sortBy: ListSortBy,
  sortDirection: ListSortDirection,
): number {
  switch (sortBy) {
    case "createdAt":
      return compareNullableNumbers(
        Date.parse(left.createdAt),
        Date.parse(right.createdAt),
        sortDirection,
      );
    case "savedAt":
      return compareNullableNumbers(
        parseSortableTimestamp(left.savedAt),
        parseSortableTimestamp(right.savedAt),
        sortDirection,
      );
    case "modifiedAt":
      return compareNullableNumbers(
        Date.parse(left.modifiedAt),
        Date.parse(right.modifiedAt),
        sortDirection,
      );
    case "title":
      return compareNullableText(left.title, right.title, sortDirection);
    case "project":
      return compareNullableText(left.projectName, right.projectName, sortDirection);
    case "author":
      return compareNullableText(left.author, right.author, sortDirection);
  }
}

function parseSortableTimestamp(value: string | null): number | null {
  if (value == null) {
    return null;
  }

  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? null : parsed;
}

function compareNullableNumbers(
  left: number | null,
  right: number | null,
  sortDirection: ListSortDirection,
): number {
  const normalizedLeft = left != null && !Number.isNaN(left) ? left : null;
  const normalizedRight = right != null && !Number.isNaN(right) ? right : null;

  if (normalizedLeft == null && normalizedRight == null) return 0;
  if (normalizedLeft == null) return 1;
  if (normalizedRight == null) return -1;

  const compared = normalizedLeft - normalizedRight;
  return sortDirection === "asc" ? compared : -compared;
}

function compareNullableText(
  left: string | null,
  right: string | null,
  sortDirection: ListSortDirection,
): number {
  if (left == null && right == null) return 0;
  if (left == null) return 1;
  if (right == null) return -1;

  const compared = left.localeCompare(right, undefined, { sensitivity: "base" });
  return sortDirection === "asc" ? compared : -compared;
}

function filterConversationsByMcpMetadata(
  conversations: ConversationMeta[],
  input: { project?: string; author?: string },
): ConversationMeta[] {
  const project = normalizeFilterText(input.project);
  const author = normalizeFilterText(input.author);

  return conversations.filter((conversation) => {
    if (project && !matchesCaseInsensitiveSubstring(conversation.projectName, project)) {
      return false;
    }

    if (author && !matchesCaseInsensitiveSubstring(conversation.author, author)) {
      return false;
    }

    return true;
  });
}

function matchesCaseInsensitiveSubstring(value: string | null, query: string): boolean {
  return value != null && value.toLowerCase().includes(query);
}

function normalizeFilterText(value: string | undefined): string | null {
  const normalized = value?.trim().toLowerCase();
  return normalized ? normalized : null;
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
    summaryKind: conversation.summaryKind,
    extraction: conversation.summaryExtraction,
    tags: conversation.tags,
    author: conversation.author,
    project: conversation.projectName,
    originKind: conversation.originKind,
    originRef: conversation.originRef,
    state: conversation.state,
    createdAt: conversation.createdAt,
    modifiedAt: conversation.modifiedAt,
  };
}

export async function handleSummarizationGuide() {
  return {
    version: SUMMARIZATION_GUIDE_VERSION,
    guide: SUMMARIZATION_GUIDE,
  };
}

export async function handleAnalysisSuggestions() {
  return {
    version: ANALYSIS_SUGGESTIONS_VERSION,
    suggestions: ANALYSIS_SUGGESTIONS,
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
