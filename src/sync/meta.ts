import fs from "node:fs/promises";

import { z } from "zod";

import type { ConversationMeta, SummaryExtraction } from "../models/conversation.js";
import { summaryExtractionSchema, summaryKindSchema } from "../models/conversation.js";
import { BUILTIN_SOURCES } from "../utils/paths.js";

// Accept the standard ISO 8601 date-time shapes clog produces and consumes:
// YYYY-MM-DDTHH:mm:ss[.sss](Z|±HH:MM). Date-only or looser forms are rejected
// so that field-by-field change detection isn't thrown off by ambiguous input.
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const isoTimestamp = z
  .string()
  .refine(
    (value) => ISO_TIMESTAMP_REGEX.test(value) && !Number.isNaN(Date.parse(value)),
    { message: "must be an ISO 8601 timestamp" },
  );

const remoteMetaInputSchema = z.object({
  id: z.string().min(1),
  title: z.string(),
  summary: z.string(),
  summaryKind: summaryKindSchema.optional(),
  summaryExtraction: summaryExtractionSchema.nullable().optional(),
  tags: z.array(z.string()),
  author: z.string().min(1),
  projectName: z.string().nullable(),
  savedAt: isoTimestamp,
  modifiedAt: isoTimestamp,
  source: z.enum(BUILTIN_SOURCES),
  createdAt: isoTimestamp,
  slug: z.string().nullable(),
});

export const remoteMetaSchema = remoteMetaInputSchema.transform((meta) => ({
  ...meta,
  summaryKind:
    meta.summaryKind ?? (meta.summary.trim() ? "curated" : "none"),
  summaryExtraction: meta.summaryExtraction ?? null,
}));

export type RemoteMeta = z.infer<typeof remoteMetaSchema>;

export function conversationToRemoteMeta(
  conversation: ConversationMeta,
): RemoteMeta {
  if (conversation.savedAt == null) {
    throw new Error(
      `Cannot serialize conversation ${conversation.id} to remote meta: savedAt is null (not yet saved).`,
    );
  }

  return {
    id: conversation.id,
    title: conversation.title,
    summary: conversation.summary,
    summaryKind: conversation.summaryKind,
    summaryExtraction: cloneExtraction(conversation.summaryExtraction),
    tags: [...conversation.tags],
    author: conversation.author,
    projectName: conversation.projectName,
    savedAt: conversation.savedAt,
    modifiedAt: conversation.modifiedAt,
    source: conversation.source as RemoteMeta["source"],
    createdAt: conversation.createdAt,
    slug: conversation.slug,
  };
}

function cloneExtraction(
  extraction: SummaryExtraction | null,
): SummaryExtraction | null {
  if (extraction == null) return null;
  // Defensive copy so callers can't mutate the conversation's stored object.
  return JSON.parse(JSON.stringify(extraction)) as SummaryExtraction;
}

export function serializeRemoteMeta(meta: RemoteMeta): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export async function writeRemoteMeta(
  filePath: string,
  meta: RemoteMeta,
): Promise<void> {
  await fs.writeFile(filePath, serializeRemoteMeta(meta), "utf8");
}

export interface ParseRemoteMetaResult {
  ok: true;
  meta: RemoteMeta;
}

export interface ParseRemoteMetaError {
  ok: false;
  reason: string;
}

export function parseRemoteMeta(
  raw: string,
): ParseRemoteMetaResult | ParseRemoteMetaError {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid JSON: ${(error as Error).message}`,
    };
  }

  const result = remoteMetaSchema.safeParse(parsed);

  if (!result.success) {
    return {
      ok: false,
      reason: result.error.issues
        .map((issue) => `${issue.path.join(".") || "<root>"}: ${issue.message}`)
        .join("; "),
    };
  }

  return { ok: true, meta: result.data };
}

export async function readRemoteMeta(
  filePath: string,
): Promise<ParseRemoteMetaResult | ParseRemoteMetaError> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read file: ${(error as Error).message}`,
    };
  }

  return parseRemoteMeta(raw);
}
