import fs from "node:fs/promises";
import path from "node:path";

import { z } from "zod";

import { classifyAdapterVersion } from "../adapters/adapter.js";
import { getAdapter, isSourceParseSupported } from "../adapters/registry.js";
import type { Config } from "../config/schema.js";
import type {
  ConversationMeta,
  Message,
  RelationshipInspection,
  SummaryExtraction,
} from "../models/conversation.js";
import {
  conversationRelationshipSchema,
  preserveConfirmedRelationship,
  relationshipInspectionSchema,
  relationshipInspectionStateSchema,
  summaryExtractionSchema,
  summaryKindSchema,
} from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { writeFileAtomic } from "../utils/atomic-write.js";
import { validateSourceKey } from "../utils/source-keys.js";

const META_SUFFIX = ".meta.json";
const JSONL_SUFFIX = ".jsonl";

// Accept the standard ISO 8601 date-time shapes clog produces and consumes:
// YYYY-MM-DDTHH:mm:ss[.sss](Z|+HH:MM|-HH:MM). Date-only or looser forms are rejected
// so field-by-field change detection is not affected by ambiguous input.
const ISO_TIMESTAMP_REGEX =
  /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:?\d{2})$/;

const isoTimestamp = z
  .string()
  .refine(
    (value) => ISO_TIMESTAMP_REGEX.test(value) && !Number.isNaN(Date.parse(value)),
    { message: "must be an ISO 8601 timestamp" },
  );

const sourceKeySchema = z.string().superRefine((value, ctx) => {
  const validation = validateSourceKey(value);
  if (validation.ok) {
    return;
  }

  ctx.addIssue({
    code: z.ZodIssueCode.custom,
    message:
      validation.reason === "reserved_path_name"
        ? "must not be a reserved path name"
        : "must match source-key syntax",
  });
});

const pairMetadataInputSchema = z.object({
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
  source: sourceKeySchema,
  createdAt: isoTimestamp,
  slug: z.string().nullable(),
  relationshipInspection: relationshipInspectionStateSchema.optional(),
  relationships: z.array(conversationRelationshipSchema).optional(),
}).superRefine((meta, context) => {
  const hasInspection = meta.relationshipInspection !== undefined;
  const hasRelationships = meta.relationships !== undefined;
  if (hasInspection !== hasRelationships) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: hasInspection ? ["relationships"] : ["relationshipInspection"],
      message:
        "relationshipInspection and relationships must either both be present or both be absent",
    });
    return;
  }

  if (!hasInspection || !hasRelationships) {
    return;
  }

  const result = relationshipInspectionSchema.safeParse({
    ...meta.relationshipInspection,
    relationships: meta.relationships,
  });
  if (result.success) {
    return;
  }

  for (const issue of result.error.issues) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path:
        issue.path[0] === "relationships"
          ? issue.path
          : ["relationshipInspection", ...issue.path],
      message: issue.message,
    });
  }
});

export const pairMetadataSchema = pairMetadataInputSchema.transform((meta) => ({
  ...meta,
  summaryKind:
    meta.summaryKind ?? (meta.summary.trim() ? "curated" : "none"),
  summaryExtraction: meta.summaryExtraction ?? null,
}));

export type PairMetadata = z.infer<typeof pairMetadataSchema>;

export interface ScannedPair {
  rootDir: string;
  relativeDir: string;
  stem: string;
  normalizedRelativePath: string;
  metaPath: string;
  jsonlPath: string;
  metaExists: boolean;
  jsonlExists: boolean;
}

export interface ScanPairsOptions {
  shouldDescend?: (entry: {
    rootDir: string;
    currentDir: string;
    relativeDir: string;
    entryName: string;
    entryPath: string;
  }) => boolean;
  diagnostics?: PairDiagnosticAdapter;
}

export interface PairDiagnosticAdapter {
  formatPath(physicalPath: string): string;
  formatPairPath(normalizedRelativePath: string): string;
  translateFilesystemError(operation: string, physicalPath: string, error: unknown): Error;
}

export interface ValidatedPair {
  rootDir: string;
  relativeDir: string;
  stem: string;
  normalizedRelativePath: string;
  metaPath: string;
  jsonlPath: string;
  meta: PairMetadata;
  messageCount: number;
  transcriptProjectionVersion: number;
  relationshipInspection: RelationshipInspection & { version: number };
}

export type PairValidationResult =
  | { kind: "valid"; pair: ValidatedPair }
  | { kind: "invalid"; warning: ClogWarning };

export interface WritePairArgs {
  metaPath: string;
  jsonlPath: string;
  meta: PairMetadata;
  jsonl: Buffer | string;
  mode?: number;
}

export function conversationToPairMetadata(
  conversation: ConversationMeta,
): PairMetadata {
  if (conversation.savedAt == null) {
    throw new Error(
      `Cannot serialize conversation ${conversation.id} metadata: savedAt is null (not yet saved).`,
    );
  }

  const relationshipInspection = relationshipInspectionSchema.parse({
    ...(conversation.relationshipInspection ?? {
      status: "unexamined",
      version: null,
      diagnostic: null,
    }),
    relationships: conversation.relationships ?? [],
  });

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
    source: conversation.source as PairMetadata["source"],
    createdAt: conversation.createdAt,
    slug: conversation.slug,
    relationshipInspection: {
      status: relationshipInspection.status,
      version: relationshipInspection.version,
      diagnostic: relationshipInspection.diagnostic,
    },
    relationships: relationshipInspection.relationships,
  };
}

export function serializePairMetadata(meta: PairMetadata): string {
  return `${JSON.stringify(meta, null, 2)}\n`;
}

export async function writePairMetadata(
  filePath: string,
  meta: PairMetadata,
  options: { mode?: number } = {},
): Promise<void> {
  await writeFileAtomic(filePath, serializePairMetadata(meta), options);
}

export interface ParsePairMetadataResult {
  ok: true;
  meta: PairMetadata;
}

export interface ParsePairMetadataError {
  ok: false;
  reason: string;
}

export function parsePairMetadata(
  raw: string,
): ParsePairMetadataResult | ParsePairMetadataError {
  let parsed: unknown;

  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      ok: false,
      reason: `invalid JSON: ${(error as Error).message}`,
    };
  }

  const result = pairMetadataSchema.safeParse(parsed);

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

export async function readPairMetadata(
  filePath: string,
): Promise<ParsePairMetadataResult | ParsePairMetadataError> {
  let raw: string;

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    return {
      ok: false,
      reason: `failed to read file: ${(error as Error).message}`,
    };
  }

  return parsePairMetadata(raw);
}

export async function scanPairs(
  dir: string,
  options: ScanPairsOptions = {},
): Promise<ScannedPair[]> {
  const rootDir = path.resolve(dir);
  const groups = new Map<string, ScannedPair>();

  await scanPairDir(rootDir, rootDir, groups, options);

  return [...groups.values()].sort((left, right) =>
    compareCodePoints(left.normalizedRelativePath, right.normalizedRelativePath),
  );
}

export async function validatePair(
  pair: ScannedPair,
  config: Config,
  diagnostics?: PairDiagnosticAdapter,
): Promise<PairValidationResult> {
  const pairDisplayPath = diagnostics?.formatPairPath(pair.normalizedRelativePath)
    ?? pair.normalizedRelativePath;
  const metaDisplayPath = diagnostics?.formatPath(pair.metaPath) ?? pair.metaPath;
  const jsonlDisplayPath = diagnostics?.formatPath(pair.jsonlPath) ?? pair.jsonlPath;

  if (!pair.metaExists || !pair.jsonlExists) {
    return {
      kind: "invalid",
      warning: {
        code: "pair_incomplete",
        message: `Skipping conversation ${pairDisplayPath} - incomplete (${
          !pair.metaExists ? "missing .meta.json" : "missing .jsonl"
        }).`,
        paths: [metaDisplayPath, jsonlDisplayPath],
      },
    };
  }

  let raw: string;
  try {
    raw = await fs.readFile(pair.metaPath, "utf8");
  } catch (error) {
    // With a diagnostic adapter the display path is carried on `path` and
    // rendered separately, so the message only needs the operation and code.
    const code = filesystemErrorCode(error);
    const reason = diagnostics
      ? `failed to read .meta.json${code != null ? ` (${code})` : ""}`
      : `failed to read .meta.json: ${(error as Error).message}`;
    return {
      kind: "invalid",
      warning: {
        code: "pair_invalid_metadata",
        message: `Skipping conversation ${pairDisplayPath} - ${reason}`,
        path: metaDisplayPath,
      },
    };
  }

  const parsed = parsePairMetadata(raw);
  if (!parsed.ok) {
    return {
      kind: "invalid",
      warning: {
        code: "pair_invalid_metadata",
        message: `Skipping conversation ${pairDisplayPath} - invalid .meta.json: ${parsed.reason}`,
        path: metaDisplayPath,
      },
    };
  }

  const { meta } = parsed;
  const pairWarning = { source: meta.source, id: meta.id };

  if (meta.id !== pair.stem) {
    return {
      kind: "invalid",
      warning: {
        code: "pair_id_mismatch",
        message: diagnostics
          ? `Skipping conversation ${pairDisplayPath} - filename stem "${pair.stem}" does not match meta.id "${meta.id}".`
          : `Skipping conversation - filename stem "${pair.stem}" does not match meta.id "${meta.id}".`,
        pair: pairWarning,
        path: metaDisplayPath,
      },
    };
  }

  if (!isSourceParseSupported(meta.source)) {
    return {
      kind: "invalid",
      warning: {
        code: "unsupported_source",
        message: `Skipping conversation ${pairDisplayPath} - source "${meta.source}" is not supported by this clog build.`,
        pair: { author: meta.author, source: meta.source, id: meta.id },
        path: metaDisplayPath,
        source: meta.source,
      },
    };
  }

  const adapter = getAdapter(meta.source, config);
  const portableInspection =
    meta.relationshipInspection != null && meta.relationships != null
      ? relationshipInspectionSchema.parse({
          ...meta.relationshipInspection,
          relationships: meta.relationships,
        })
      : null;
  const portableInspectionClassification =
    portableInspection == null
      ? null
      : classifyAdapterVersion(
          portableInspection.version,
          adapter.relationshipInspectionVersion,
        );
  if (
    portableInspectionClassification === "version_skew"
  ) {
    return {
      kind: "invalid",
      warning: {
        code: "adapter_version_skew",
        message: `Skipping conversation ${pairDisplayPath} - relationship metadata was written by a newer clog version.`,
        pair: pairWarning,
        path: metaDisplayPath,
        source: meta.source,
        guidance: "Upgrade clog before importing or synchronizing this conversation.",
      },
    };
  }

  let messages: Message[];
  let transcriptProjectionVersion: number;
  let relationshipInspection: RelationshipInspection & { version: number };
  try {
    messages = (await adapter.parseTranscript(pair.jsonlPath)).messages;
    transcriptProjectionVersion = adapter.transcriptProjectionVersion;
    let inspection: RelationshipInspection;
    if (
      portableInspection != null &&
      portableInspectionClassification === "current"
    ) {
      inspection = portableInspection;
    } else {
      const inspected = await adapter.inspectRelationships(pair.jsonlPath);
      inspection =
        portableInspection != null &&
        portableInspectionClassification === "refreshable"
          ? preserveConfirmedRelationship(
              {
                relationshipInspection: {
                  status: portableInspection.status,
                  version: portableInspection.version,
                  diagnostic: portableInspection.diagnostic,
                },
                relationships: portableInspection.relationships,
              },
              inspected,
            )
          : inspected;
    }
    if (inspection.version == null) {
      throw new Error(
        `${meta.source} returned an unexamined relationship inspection for an imported conversation.`,
      );
    }
    relationshipInspection = {
      ...inspection,
      version: inspection.version,
    };
  } catch (error) {
    // A filesystem read failure carries a stable code; keep the display path on
    // `path` rather than repeating it in the message. Content parse failures
    // keep their native message, which never contains the input path.
    const code = filesystemErrorCode(error);
    const reason =
      diagnostics && code != null
        ? `failed to read .jsonl (${code})`
        : `failed to parse .jsonl: ${(error as Error).message}`;
    return {
      kind: "invalid",
      warning: {
        code: "pair_invalid_content",
        message: `Skipping conversation ${pairDisplayPath} - ${reason}`,
        pair: pairWarning,
        path: jsonlDisplayPath,
      },
    };
  }

  return {
    kind: "valid",
    pair: {
      rootDir: pair.rootDir,
      relativeDir: pair.relativeDir,
      stem: pair.stem,
      normalizedRelativePath: pair.normalizedRelativePath,
      metaPath: pair.metaPath,
      jsonlPath: pair.jsonlPath,
      meta,
      messageCount: messages.length,
      transcriptProjectionVersion,
      relationshipInspection,
    },
  };
}

export async function writePair(args: WritePairArgs): Promise<void> {
  await writeFileAtomic(args.jsonlPath, args.jsonl, { mode: args.mode });
  await writePairMetadata(args.metaPath, args.meta, { mode: args.mode });
}

function cloneExtraction(
  extraction: SummaryExtraction | null,
): SummaryExtraction | null {
  if (extraction == null) return null;
  return JSON.parse(JSON.stringify(extraction)) as SummaryExtraction;
}

async function scanPairDir(
  rootDir: string,
  currentDir: string,
  groups: Map<string, ScannedPair>,
  options: ScanPairsOptions,
): Promise<void> {
  let entries: Array<{ name: string; isDirectory: () => boolean; isFile: () => boolean }>;

  try {
    entries = await fs.readdir(currentDir, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    if (options.diagnostics) {
      throw options.diagnostics.translateFilesystemError(
        "Failed to read conversation files directory",
        currentDir,
        error,
      );
    }
    throw error;
  }

  entries.sort((left, right) => compareCodePoints(left.name, right.name));
  const relativeDir = normalizeRelativeDir(
    path.relative(rootDir, currentDir),
  );

  for (const entry of entries) {
    const entryPath = path.join(currentDir, entry.name);

    if (entry.isDirectory()) {
      if (
        options.shouldDescend?.({
          rootDir,
          currentDir,
          relativeDir,
          entryName: entry.name,
          entryPath,
        }) === false
      ) {
        continue;
      }
      await scanPairDir(rootDir, entryPath, groups, options);
      continue;
    }

    if (!entry.isFile()) {
      continue;
    }

    const side = pairSideFromFilename(entry.name);
    if (!side) {
      continue;
    }

    const normalizedRelativePath = relativeDir
      ? `${relativeDir}/${side.stem}`
      : side.stem;
    const existing = groups.get(normalizedRelativePath);

    const pair =
      existing ??
      buildScannedPair(rootDir, currentDir, relativeDir, side.stem, normalizedRelativePath);

    if (side.kind === "meta") {
      pair.metaExists = true;
      pair.metaPath = entryPath;
    } else {
      pair.jsonlExists = true;
      pair.jsonlPath = entryPath;
    }

    groups.set(normalizedRelativePath, pair);
  }
}

function filesystemErrorCode(error: unknown): string | null {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? code : null;
}

function buildScannedPair(
  rootDir: string,
  pairDir: string,
  relativeDir: string,
  stem: string,
  normalizedRelativePath: string,
): ScannedPair {
  return {
    rootDir,
    relativeDir,
    stem,
    normalizedRelativePath,
    metaPath: path.join(pairDir, `${stem}${META_SUFFIX}`),
    jsonlPath: path.join(pairDir, `${stem}${JSONL_SUFFIX}`),
    metaExists: false,
    jsonlExists: false,
  };
}

function pairSideFromFilename(
  filename: string,
): { kind: "meta" | "jsonl"; stem: string } | null {
  if (filename.endsWith(META_SUFFIX)) {
    return {
      kind: "meta",
      stem: filename.slice(0, -META_SUFFIX.length),
    };
  }

  if (filename.endsWith(JSONL_SUFFIX)) {
    return {
      kind: "jsonl",
      stem: filename.slice(0, -JSONL_SUFFIX.length),
    };
  }

  return null;
}

function normalizeRelativeDir(relativeDir: string): string {
  if (!relativeDir || relativeDir === ".") {
    return "";
  }

  return relativeDir.split(path.sep).filter(Boolean).join("/");
}

export function compareCodePoints(left: string, right: string): number {
  const leftPoints = Array.from(left);
  const rightPoints = Array.from(right);
  const length = Math.min(leftPoints.length, rightPoints.length);

  for (let i = 0; i < length; i += 1) {
    const leftCode = leftPoints[i]!.codePointAt(0)!;
    const rightCode = rightPoints[i]!.codePointAt(0)!;
    if (leftCode !== rightCode) {
      return leftCode - rightCode;
    }
  }

  return leftPoints.length - rightPoints.length;
}
