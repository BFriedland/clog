import { z } from "zod";

const conversationStateSchema = z.enum([
  "unsaved",
  "saved",
]);

export type ConversationState = z.infer<typeof conversationStateSchema>;

const originKindSchema = z.enum([
  "local",
  "git",
  "file",
]);

export type OriginKind = z.infer<typeof originKindSchema>;

export const summaryKindSchema = z.enum([
  "none",
  "imported",
  "generated",
  "curated",
]);

export type SummaryKind = z.infer<typeof summaryKindSchema>;

const summaryOutcomeSchema = z.enum([
  "fixed",
  "partial",
  "abandoned",
  "exploratory",
  "blocked",
  "noise",
  "unclear",
]);

// Two variants on purpose:
//   - summaryExtractionSchema is tolerant. It's used on read paths (DB load,
//     remote .meta.json parse) where data may have been written by a future
//     clog version that added a new field. Unknown keys are silently stripped
//     so older clogs keep importing remote conversations across version skew.
//   - summaryExtractionInputSchema is strict. It's used on the agent-write
//     path (MCP update_conversation) so an LLM that invents or misspells a field
//     gets a hard error instead of silent data loss.
export const summaryExtractionSchema = z.object({
  topics: z.array(z.string()).optional(),
  outcome: summaryOutcomeSchema.optional(),
  toolsUsed: z.array(z.string()).optional(),
  notableMoments: z
    .array(z.object({ why: z.string() }))
    .optional(),
});

export const summaryExtractionInputSchema = z
  .object({
    topics: z.array(z.string()).optional(),
    outcome: summaryOutcomeSchema.optional(),
    toolsUsed: z.array(z.string()).optional(),
    notableMoments: z
      .array(z.object({ why: z.string() }).strict())
      .optional(),
  })
  .strict();

export type SummaryExtraction = z.infer<typeof summaryExtractionSchema>;

const messageRoleSchema = z.enum([
  "user",
  "assistant",
  "tool_use",
  "tool_result",
]);

export const messageSchema = z.object({
  role: messageRoleSchema,
  content: z.string(),
  timestamp: z.string().nullable(),
  toolName: z.string().optional(),
  toolInput: z.unknown().optional(),
});

export type Message = z.infer<typeof messageSchema>;

export const conversationMetaSchema = z.object({
  id: z.string(),
  sourceId: z.string(),
  source: z.string(),
  title: z.string(),
  summary: z.string(),
  summaryKind: summaryKindSchema.default("none"),
  summaryExtraction: summaryExtractionSchema.nullable().default(null),
  author: z.string(),
  projectName: z.string().nullable(),
  projectPath: z.string().nullable(),
  tags: z.array(z.string()),
  slug: z.string().nullable(),
  createdAt: z.string(),
  discoveredAt: z.string(),
  modifiedAt: z.string(),
  state: conversationStateSchema,
  savedAt: z.string().nullable(),
  savedMessageCount: z.number().int().nonnegative().nullable(),
  saveVersion: z.number().int().nonnegative(),
  sourcePath: z.string(),
  filePath: z.string().nullable(),
  sourceMtime: z.string().nullable(),
  indexedAt: z.string().nullable(),
  originKind: originKindSchema,
  originRef: z.string().nullable(),
});

export type ConversationMeta = z.infer<typeof conversationMetaSchema>;

export function summaryKindForDiscoveredSummary(summary: string): SummaryKind {
  return summary.trim() ? "imported" : "none";
}

// A conversation is "summarized" iff the user has curated it or an agent has
// written a structured extraction. Anything else (empty, source-only, or
// prose-only generated) can still benefit from agent-written structure.
export function isUnsummarized(conversation: ConversationMeta): boolean {
  return (
    conversation.summaryKind !== "curated" &&
    conversation.summaryExtraction == null
  );
}

export function parseSummaryExtraction(raw: unknown): SummaryExtraction | null {
  if (raw == null) return null;
  if (typeof raw === "string") {
    if (!raw.trim()) return null;
    try {
      return summaryExtractionSchema.parse(JSON.parse(raw));
    } catch {
      return null;
    }
  }
  const result = summaryExtractionSchema.safeParse(raw);
  return result.success ? result.data : null;
}

export function serializeSummaryExtraction(
  extraction: SummaryExtraction | null,
): string | null {
  if (extraction == null) return null;
  return JSON.stringify(extraction);
}
