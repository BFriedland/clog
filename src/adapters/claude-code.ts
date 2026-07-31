import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";
import { createReadStream } from "node:fs";

import type { Config } from "../config/schema.js";
import type { RelationshipInspection } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { isReadableDirectory } from "../utils/fs.js";
import { normalizeUserPath } from "../utils/paths.js";
import {
  SCAN_METADATA_MAX_LINES,
  type DiscoverOptions,
  type DiscoveredConversation,
  type SourceAdapter,
  type Transcript,
  globSourceFiles,
} from "./adapter.js";
import { projectClaudeCodeTranscript } from "./claude-code-transcript.js";

interface ClaudeJsonLine {
  type?: string;
  subtype?: string;
  timestamp?: string;
  cwd?: string;
  slug?: string;
  summary?: string;
  uuid?: string;
  parentUuid?: string | null;
  sessionId?: unknown;
  session_id?: unknown;
  forkedFrom?: unknown;
  isSidechain?: boolean;
  message?: {
    id?: string;
    role?: string;
    content?: unknown;
  };
}

interface ClaudeDiscoveryMetadata {
  title: string;
  summary: string;
  projectName: string | null;
  projectPath: string | null;
  slug: string | null;
  createdAt: string;
}

interface ClaudeFileInspection {
  discoveryFailed: boolean;
  metadata: ClaudeDiscoveryMetadata;
  relationshipInspection: RelationshipInspection;
}

interface InferredSuffixRecord {
  type: string | null;
  subtype: string | null;
  uuid: string | null;
  parentUuid: string | null;
  timestamp: string | null;
}

const KNOWN_HIDDEN_USER_WRAPPER_BLOCKS = ["local-command-caveat"];
const LOCAL_COMMAND_WRAPPER_REGEX =
  /<(command-name|command-message|command-args|local-command-stdout|local-command-stderr)>([\s\S]*?)<\/\1>/g;
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

export const CLAUDE_CODE_ADAPTER_VERSIONS = {
  relationshipInspection: 2,
  transcriptProjection: 2,
} as const;

export class ClaudeCodeAdapter implements SourceAdapter {
  readonly name = "claude-code";
  readonly relationshipInspectionVersion =
    CLAUDE_CODE_ADAPTER_VERSIONS.relationshipInspection;
  readonly transcriptProjectionVersion =
    CLAUDE_CODE_ADAPTER_VERSIONS.transcriptProjection;
  // Discovery calls the public relationship operation while sharing the same
  // source-format scan for metadata and the copied-history boundary.
  private readonly fileInspectionCache = new Map<
    string,
    Promise<ClaudeFileInspection>
  >();

  constructor(private readonly config: Config) {}

  async *discover(options: DiscoverOptions = {}): AsyncIterable<DiscoveredConversation> {
    for (const basePath of this.watchPaths()) {
      if (!(await isReadableDirectory(basePath))) {
        options.onWarning?.({
          code: "missing_source_file",
          message: "Configured Claude Code conversations directory is missing or unreadable.",
          source: this.name,
          path: basePath,
          guidance: "Fix the configured path or remove it from config.",
        });
        continue;
      }

      const files = await globSourceFiles(
        "*/*.jsonl",
        basePath,
        options.onIncomplete,
      );

      for (const filePath of files.sort()) {
        const discovered = await this.discoverFile(filePath, options.onWarning);
        if (discovered) {
          yield discovered;
        }
      }
    }
  }

  async inspectRelationships(
    filePath: string,
    options: DiscoverOptions = {},
  ): Promise<RelationshipInspection> {
    const result = await this.inspectFileOnce(
      filePath,
      options.onWarning,
      false,
    );
    return result.relationshipInspection;
  }

  async parseTranscript(
    filePath: string,
  ): Promise<Transcript> {
    return projectClaudeCodeTranscript(
      await readJsonlFile<unknown>(filePath),
      filePath,
    );
  }

  watchPaths(): string[] {
    return this.config.sources["claude-code"].paths.map(normalizeUserPath);
  }

  private async discoverFile(
    filePath: string,
    onWarning?: (warning: ClogWarning) => void,
  ): Promise<DiscoveredConversation | null> {
    const sourceId = path.basename(filePath, ".jsonl");

    try {
      this.fileInspectionCache.set(
        filePath,
        inspectClaudeFile({
          filePath,
          onWarning,
          relationshipInspectionVersion: this.relationshipInspectionVersion,
          source: this.name,
          includeDiscoveryMetadata: true,
        }),
      );
      const relationshipInspection = await this.inspectRelationships(
        filePath,
        { onWarning },
      );
      const inspection = await this.inspectFileOnce(filePath, onWarning);
      if (inspection.discoveryFailed) {
        return null;
      }

      return {
        sourceId,
        sourcePath: filePath,
        metadata: inspection.metadata,
        relationshipInspection: {
          status: relationshipInspection.status,
          version: relationshipInspection.version,
          diagnostic: relationshipInspection.diagnostic,
        },
        relationships: relationshipInspection.relationships,
      };
    } finally {
      this.fileInspectionCache.delete(filePath);
    }
  }

  private inspectFileOnce(
    filePath: string,
    onWarning?: (warning: ClogWarning) => void,
    includeDiscoveryMetadata = false,
  ): Promise<ClaudeFileInspection> {
    const cached = this.fileInspectionCache.get(filePath);
    if (cached) {
      return cached;
    }
    return inspectClaudeFile({
      filePath,
      onWarning,
      relationshipInspectionVersion: this.relationshipInspectionVersion,
      source: this.name,
      includeDiscoveryMetadata,
    });
  }
}

async function inspectClaudeFile(args: {
  filePath: string;
  includeDiscoveryMetadata: boolean;
  onWarning?: (warning: ClogWarning) => void;
  relationshipInspectionVersion: number;
  source: string;
}): Promise<ClaudeFileInspection> {
  const fileStat = await fs.stat(args.filePath);
  const fileMtime = fileStat.mtime.toISOString();
  const sourceId = path.basename(args.filePath, ".jsonl");
  const metadata: ClaudeDiscoveryMetadata = {
    title: "(untitled)",
    summary: "",
    projectName: null,
    projectPath: null,
    slug: null,
    createdAt: fileMtime,
  };
  const input = createReadStream(args.filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;
  let metadataCollecting = args.includeDiscoveryMetadata;
  let discoveryFailed = false;
  let firstTimestamp: string | null = null;
  let malformedRelationship = false;

  let forkedFromSeen = false;
  let forkedPrefixEnded = false;
  let forkedParentMalformed = false;
  const forkedParentIds = new Set<string>();
  let sourceForkCreatedAt: string | null = null;

  let inferredParentMalformed = false;
  let inferredParentSourceId: string | null = null;
  let inferredParentUuid: string | null = null;
  let inferredEvidenceSeen = false;
  let ownSessionEvidenceSeen = false;
  let inferredSuffix: InferredSuffixRecord[] = [];

  try {
    for await (const rawLine of rl) {
      lineNumber += 1;
      const trimmed = rawLine.trim();
      if (!trimmed) {
        if (metadataCollecting && lineNumber >= SCAN_METADATA_MAX_LINES) {
          metadataCollecting = false;
        }
        continue;
      }

      let line: ClaudeJsonLine;
      try {
        const parsed = JSON.parse(trimmed) as unknown;
        if (!isRecord(parsed)) {
          throw new Error("Claude Code JSONL records must be objects.");
        }
        line = parsed as ClaudeJsonLine;
      } catch {
        malformedRelationship = !claudeRelationshipScanComplete({
          forkedFromSeen,
          forkedPrefixEnded,
          ownSessionEvidenceSeen,
        });
        if (metadataCollecting) {
          discoveryFailed = true;
          emitMalformedClaudeWarning(args);
        }
        break;
      }

      const timestamp = normalizeTimestamp(line.timestamp);
      firstTimestamp ??= timestamp;
      if (metadataCollecting) {
        collectClaudeDiscoveryMetadata(metadata, line);
        if (
          claudeDiscoveryMetadataComplete(metadata) ||
          lineNumber >= SCAN_METADATA_MAX_LINES
        ) {
          metadataCollecting = false;
        }
      }

      if (line.isSidechain !== true) {
        const hasForkedFrom = Object.hasOwn(line, "forkedFrom");
        if (hasForkedFrom) {
          forkedFromSeen = true;
          const forkedFrom = isRecord(line.forkedFrom)
            ? line.forkedFrom
            : null;
          const parentSourceId = nonemptyString(forkedFrom?.sessionId);
          if (!parentSourceId || !isUuidLike(parentSourceId)) {
            forkedParentMalformed = true;
          } else {
            forkedParentIds.add(parentSourceId);
          }
        } else if (forkedFromSeen && !forkedPrefixEnded) {
          forkedPrefixEnded = true;
        }

        if (
          forkedPrefixEnded &&
          !sourceForkCreatedAt &&
          !hasForkedFrom &&
          timestamp
        ) {
          sourceForkCreatedAt = timestamp;
        }

        const hasSnakeSessionId = Object.hasOwn(line, "session_id");
        if (hasSnakeSessionId && line.session_id != null) {
          const sessionId = nonemptyString(line.session_id);
          if (!sessionId || !isUuidLike(sessionId)) {
            inferredParentMalformed = true;
          } else if (sessionId !== sourceId) {
            inferredEvidenceSeen = true;
            inferredParentSourceId = sessionId;
            inferredParentUuid = nonemptyString(line.uuid);
            inferredSuffix = [];
          } else {
            ownSessionEvidenceSeen = true;
          }
        }

        if (
          inferredEvidenceSeen &&
          !(hasSnakeSessionId && line.session_id === inferredParentSourceId)
        ) {
          inferredSuffix.push(toInferredSuffixRecord(line));
        }
      }

      const relationshipComplete = claudeRelationshipScanComplete({
        forkedFromSeen,
        forkedPrefixEnded,
        ownSessionEvidenceSeen,
      });
      const forkCreationResolved =
        !args.includeDiscoveryMetadata ||
        !forkedFromSeen ||
        sourceForkCreatedAt !== null;
      if (
        !metadataCollecting &&
        relationshipComplete &&
        forkCreationResolved
      ) {
        break;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  const relationshipInspection = buildClaudeRelationshipInspection({
    forkedFromSeen,
    forkedParentIds,
    forkedParentMalformed,
    inferredEvidenceSeen,
    inferredParentMalformed,
    inferredParentSourceId,
    malformedRelationship,
    relationshipInspectionVersion: args.relationshipInspectionVersion,
    source: args.source,
    sourceId,
  });
  const inferredForkCreatedAt =
    relationshipInspection.status === "linked" &&
      relationshipInspection.relationships[0]?.evidence === "inferred"
      ? inferForkCreatedAt(inferredSuffix, inferredParentUuid)
      : null;
  const forkCreatedAt =
    relationshipInspection.status === "linked"
      ? relationshipInspection.relationships[0]?.evidence === "source"
        ? sourceForkCreatedAt
        : inferredForkCreatedAt
      : null;
  metadata.createdAt = forkCreatedAt ?? (
    relationshipInspection.status === "linked"
      ? fileMtime
      : firstTimestamp ?? fileMtime
  );

  return {
    discoveryFailed,
    metadata,
    relationshipInspection,
  };
}

function claudeRelationshipScanComplete(args: {
  forkedFromSeen: boolean;
  forkedPrefixEnded: boolean;
  ownSessionEvidenceSeen: boolean;
}): boolean {
  return (
    (args.forkedFromSeen && args.forkedPrefixEnded) ||
    (
      !args.forkedFromSeen &&
      args.ownSessionEvidenceSeen
    )
  );
}

function collectClaudeDiscoveryMetadata(
  metadata: ClaudeDiscoveryMetadata,
  line: ClaudeJsonLine,
): void {
  if (!metadata.projectPath && typeof line.cwd === "string" && line.cwd.trim()) {
    metadata.projectPath = line.cwd;
    metadata.projectName = path.basename(line.cwd);
  }
  if (!metadata.slug && typeof line.slug === "string" && line.slug.trim()) {
    metadata.slug = line.slug;
  }

  const projectedTitle =
    line.type === "user" && typeof line.message?.content === "string"
      ? normalizeClaudeVisibleUserText(line.message.content)
      : null;
  if (metadata.title === "(untitled)" && projectedTitle) {
    metadata.title = truncateTitle(projectedTitle);
  }
  if (line.type === "summary" && typeof line.summary === "string") {
    metadata.summary = line.summary;
  }
}

function claudeDiscoveryMetadataComplete(
  metadata: ClaudeDiscoveryMetadata,
): boolean {
  return (
    metadata.title !== "(untitled)" &&
    metadata.summary !== "" &&
    metadata.slug !== null &&
    metadata.projectPath !== null
  );
}

function buildClaudeRelationshipInspection(args: {
  forkedFromSeen: boolean;
  forkedParentIds: Set<string>;
  forkedParentMalformed: boolean;
  inferredEvidenceSeen: boolean;
  inferredParentMalformed: boolean;
  inferredParentSourceId: string | null;
  malformedRelationship: boolean;
  relationshipInspectionVersion: number;
  source: string;
  sourceId: string;
}): RelationshipInspection {
  if (args.malformedRelationship) {
    return unknownClaudeRelationshipInspection(
      args.relationshipInspectionVersion,
      "claude_relationship_malformed_jsonl",
    );
  }
  if (args.forkedFromSeen) {
    if (args.forkedParentMalformed || args.forkedParentIds.size === 0) {
      return unknownClaudeRelationshipInspection(
        args.relationshipInspectionVersion,
        "claude_relationship_parent_id_invalid",
      );
    }
    if (args.forkedParentIds.size > 1) {
      return unknownClaudeRelationshipInspection(
        args.relationshipInspectionVersion,
        "claude_relationship_parent_conflict",
      );
    }
    const parentSourceId = [...args.forkedParentIds][0]!;
    if (parentSourceId === args.sourceId) {
      return unknownClaudeRelationshipInspection(
        args.relationshipInspectionVersion,
        "claude_relationship_self_parent",
      );
    }
    return linkedClaudeRelationshipInspection(
      args.relationshipInspectionVersion,
      args.source,
      parentSourceId,
      "source",
    );
  }
  if (args.inferredParentMalformed) {
    return unknownClaudeRelationshipInspection(
      args.relationshipInspectionVersion,
      "claude_relationship_parent_id_invalid",
    );
  }
  if (args.inferredEvidenceSeen && args.inferredParentSourceId) {
    return linkedClaudeRelationshipInspection(
      args.relationshipInspectionVersion,
      args.source,
      args.inferredParentSourceId,
      "inferred",
    );
  }
  return {
    status: "none_found",
    version: args.relationshipInspectionVersion,
    diagnostic: null,
    relationships: [],
  };
}

function linkedClaudeRelationshipInspection(
  version: number,
  source: string,
  parentSourceId: string,
  evidence: "source" | "inferred",
): RelationshipInspection {
  return {
    status: "linked",
    version,
    diagnostic: null,
    relationships: [{
      kind: "branch",
      parent: {
        source,
        sourceId: parentSourceId,
      },
      evidence,
      branchPoint: null,
    }],
  };
}

function unknownClaudeRelationshipInspection(
  version: number,
  diagnostic: string,
): RelationshipInspection {
  return {
    status: "unknown",
    version,
    diagnostic,
    relationships: [],
  };
}

function toInferredSuffixRecord(line: ClaudeJsonLine): InferredSuffixRecord {
  return {
    type: nonemptyString(line.type),
    subtype: nonemptyString(line.subtype),
    uuid: nonemptyString(line.uuid),
    parentUuid: nonemptyString(line.parentUuid),
    timestamp: normalizeTimestamp(line.timestamp),
  };
}

function inferForkCreatedAt(
  suffix: InferredSuffixRecord[],
  lastCopiedUuid: string | null,
): string | null {
  let copiedTailUuid = lastCopiedUuid;
  for (const record of suffix) {
    if (
      record.type === "system" &&
      record.subtype === "turn_duration" &&
      copiedTailUuid !== null &&
      record.parentUuid === copiedTailUuid
    ) {
      copiedTailUuid = record.uuid;
      continue;
    }
    if (record.timestamp) {
      return record.timestamp;
    }
  }
  return null;
}

function emitMalformedClaudeWarning(args: {
  filePath: string;
  onWarning?: (warning: ClogWarning) => void;
  source: string;
}): void {
  args.onWarning?.({
    code: "malformed_jsonl",
    message: "Skipping malformed Claude Code conversation file.",
    source: args.source,
    path: args.filePath,
    guidance: "Fix the JSONL or remove the malformed file.",
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function nonemptyString(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function isUuidLike(value: string): boolean {
  return UUID_REGEX.test(value);
}

function truncateTitle(value: string): string {
  return value.length <= 100 ? value : value.slice(0, 100);
}

function stripClaudeUserWrappers(text: string): string {
  let remaining = text.trim();
  let changed = true;

  while (changed) {
    changed = false;

    for (const wrapper of KNOWN_HIDDEN_USER_WRAPPER_BLOCKS) {
      const leadingWrapperRegex = new RegExp(
        `^<${wrapper}>[\\s\\S]*?<\\/${wrapper}>\\s*`,
      );
      const withoutWrapper = remaining.replace(leadingWrapperRegex, "");
      if (withoutWrapper !== remaining) {
        remaining = withoutWrapper.trimStart();
        changed = true;
      }
    }
  }

  return remaining.trim();
}

function normalizeClaudeVisibleUserText(text: string): string {
  const stripped = stripClaudeUserWrappers(text);
  if (!stripped) {
    return "";
  }

  const wrappers = [...stripped.matchAll(LOCAL_COMMAND_WRAPPER_REGEX)];
  if (wrappers.length === 0) {
    return stripped;
  }

  const matchedText = wrappers.map((match) => match[0]).join("").replace(/\s+/g, "");
  const sourceText = stripped.replace(/\s+/g, "");
  if (matchedText !== sourceText) {
    return stripped;
  }

  const values = new Map<string, string>();
  for (const [, name, value] of wrappers) {
    values.set(name, decodeClaudeWrapperText(value.trim()));
  }

  const commandName = values.get("command-name");
  const commandMessage = values.get("command-message");
  const commandArgs = values.get("command-args");
  const stdout = values.get("local-command-stdout");
  const stderr = values.get("local-command-stderr");

  if (stdout != null || stderr != null) {
    return [stdout, stderr].filter(Boolean).join("\n").trim();
  }

  if (commandName != null || commandMessage != null || commandArgs != null) {
    const baseCommand = commandName && commandName.trim() ? commandName.trim() : commandMessage?.trim() ?? "";
    const args = commandArgs?.trim() ?? "";
    return `${baseCommand}${args ? ` ${args}` : ""}`.trim();
  }

  return stripped;
}

function decodeClaudeWrapperText(text: string): string {
  return text
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

async function readJsonlFile<T>(filePath: string): Promise<T[]> {
  const raw = await fs.readFile(filePath, "utf8");
  const lines = raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean);

  return lines.map((line) => JSON.parse(line) as T);
}
