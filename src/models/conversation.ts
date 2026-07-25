import { z } from "zod";

export const conversationStateSchema = z.enum([
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

export const conversationBranchPointSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("source-turn"),
    id: z.string().min(1),
  }),
  z.object({
    kind: z.literal("source-message"),
    id: z.string().min(1),
  }),
]);

export type ConversationBranchPoint = z.infer<
  typeof conversationBranchPointSchema
>;

export const conversationRelationshipSchema = z.object({
  kind: z.literal("branch"),
  parent: z.object({
    source: z.string().min(1),
    sourceId: z.string().min(1),
  }),
  evidence: z.enum(["source", "inferred"]),
  branchPoint: conversationBranchPointSchema.nullable(),
});

export type ConversationRelationship = z.infer<
  typeof conversationRelationshipSchema
>;

const relationshipInspectionStateSchema = z.object({
  status: z.enum(["unexamined", "none_found", "linked", "unknown"]),
  version: z.number().int().positive().nullable(),
  diagnostic: z.string().min(1).nullable(),
});

export type RelationshipInspectionState = z.infer<
  typeof relationshipInspectionStateSchema
>;

export const relationshipInspectionSchema = relationshipInspectionStateSchema
  .extend({
    relationships: z.array(conversationRelationshipSchema),
  })
  .superRefine((inspection, context) => {
    validateRelationshipInspection(inspection, context);
  });

export type RelationshipInspection = z.infer<
  typeof relationshipInspectionSchema
>;

export function preserveConfirmedRelationship(
  current: Pick<
    ConversationMeta,
    "relationshipInspection" | "relationships"
  >,
  incoming: RelationshipInspection,
): RelationshipInspection {
  const currentHasConfirmedRelationship = current.relationships.some(
    (relationship) => relationship.evidence === "source",
  );
  const incomingHasOnlyInferredRelationships =
    incoming.relationships.length > 0 &&
    incoming.relationships.every(
      (relationship) => relationship.evidence === "inferred",
  );
  if (currentHasConfirmedRelationship && incomingHasOnlyInferredRelationships) {
    return {
      status: "linked",
      version: incoming.version,
      diagnostic: null,
      relationships: current.relationships,
    };
  }
  return incoming;
}

const conversationMetaBaseShape = {
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
  sourcePath: z.string(),
  filePath: z.string().nullable(),
  sourceMtime: z.string().nullable(),
  indexedAt: z.string().nullable(),
  originKind: originKindSchema,
  originRef: z.string().nullable(),
  relationshipInspection: relationshipInspectionStateSchema.default({
    status: "unexamined",
    version: null,
    diagnostic: null,
  }),
  relationships: z.array(conversationRelationshipSchema).default([]),
};

export const savedConversationMetaSchema = z.object({
  ...conversationMetaBaseShape,
  state: z.literal("saved"),
  savedAt: z.string(),
  savedMessageCount: z.number().int().nonnegative(),
  saveVersion: z.number().int().positive(),
  transcriptProjectionVersion: z.number().int().positive().nullable().default(null),
}).superRefine((conversation, context) => {
  validateRelationshipInspection({
    ...conversation.relationshipInspection,
    relationships: conversation.relationships,
  }, context);
});

export const unsavedConversationViewSchema = z.object({
  ...conversationMetaBaseShape,
  state: z.literal("unsaved"),
  savedAt: z.null(),
  savedMessageCount: z.null(),
  saveVersion: z.literal(0),
  transcriptProjectionVersion: z.null().default(null),
}).superRefine((conversation, context) => {
  validateRelationshipInspection({
    ...conversation.relationshipInspection,
    relationships: conversation.relationships,
  }, context);
});

export const conversationMetaSchema = z.union([
  savedConversationMetaSchema,
  unsavedConversationViewSchema,
]);

export type ConversationMeta = z.infer<typeof conversationMetaSchema>;
export type SavedConversationMeta = z.infer<typeof savedConversationMetaSchema>;
export type UnsavedConversationView = z.infer<typeof unsavedConversationViewSchema>;

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

function validateRelationshipInspection(
  inspection: {
    status: "unexamined" | "none_found" | "linked" | "unknown";
    version: number | null;
    diagnostic: string | null;
    relationships: ConversationRelationship[];
  },
  context: z.RefinementCtx,
): void {
  const relationshipCount = inspection.relationships.length;
  const versionIsNull = inspection.version == null;
  const diagnosticIsNull = inspection.diagnostic == null;

  if (
    inspection.status === "unexamined" &&
    (!versionIsNull || !diagnosticIsNull || relationshipCount !== 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "unexamined relationship inspection requires a null version, null diagnostic, and no relationships",
    });
    return;
  }

  if (
    inspection.status === "none_found" &&
    (versionIsNull || !diagnosticIsNull || relationshipCount !== 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "none_found relationship inspection requires a positive version, null diagnostic, and no relationships",
    });
    return;
  }

  if (
    inspection.status === "linked" &&
    (versionIsNull || !diagnosticIsNull || relationshipCount !== 1)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "linked relationship inspection requires a positive version, null diagnostic, and exactly one relationship",
    });
    return;
  }

  if (
    inspection.status === "unknown" &&
    (versionIsNull || diagnosticIsNull || relationshipCount !== 0)
  ) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message:
        "unknown relationship inspection requires a positive version, diagnostic, and no relationships",
    });
  }
}
