import { createReadStream } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";
import readline from "node:readline";

import type { Config } from "../config/schema.js";
import type {
  Message,
  RelationshipInspection,
} from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { normalizeUserPath } from "../utils/paths.js";
import {
  SCAN_METADATA_MAX_LINES,
  type DiscoverOptions,
  type DiscoveredConversation,
  type SourceAdapter,
  type Transcript,
  globSourceFiles,
} from "./adapter.js";

interface CodexLine {
  type?: string;
  timestamp?: string;
  payload?: Record<string, unknown>;
}

interface FunctionCallInfo {
  toolName: string;
  toolInput?: unknown;
  rawArguments?: string | null;
}

interface FunctionCallOutputInfo {
  callId: string;
  output: string | null;
  index: number;
  timestamp: string | null;
}

interface ExecCommandEndInfo {
  callId: string;
  exitCode: number | null;
  status: string | null;
  outputPresent: boolean;
}

interface CodexDiscoveryState {
  canonicalSessionMeta: Record<string, unknown> | null;
  canonicalSessionMetaSeen: boolean;
  embeddedSourceId: string | null;
  firstTopLevelTimestamp: string | null;
  finalTitle: string | null;
  pendingTitle: PendingCodexTitle | null;
  sessionMetaCwd: string | null;
  sessionMetaTimestamp: string | null;
  turnContextCwd: string | null;
}

interface PendingCodexTitle {
  text: string;
  normalized: string;
  timestamp: string | null;
  adjacent: boolean;
}

interface CodexMetadataInspection {
  discoveryState: CodexDiscoveryState;
  discoveryFailed: boolean;
  relationshipInspection: RelationshipInspection;
}

const UUID_SUFFIX_REGEX =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;
const UUID_REGEX =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

const KNOWN_WRAPPER_BLOCKS = ["environment_context", "user_shell_command"];
const AGENTS_INSTRUCTIONS_PREFIX_REGEX =
  /^# AGENTS\.md instructions for [^\n]+\n\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/;

export const CODEX_CLI_ADAPTER_VERSIONS = {
  relationshipInspection: 2,
  transcriptProjection: 1,
} as const;

export class CodexCliAdapter implements SourceAdapter {
  readonly name = "codex-cli";
  readonly relationshipInspectionVersion =
    CODEX_CLI_ADAPTER_VERSIONS.relationshipInspection;
  readonly transcriptProjectionVersion =
    CODEX_CLI_ADAPTER_VERSIONS.transcriptProjection;
  // Discovery must call the public relationship-inspection operation while
  // reusing the same bounded metadata read for identity, title, and path.
  private readonly metadataInspectionCache = new Map<
    string,
    Promise<CodexMetadataInspection>
  >();

  constructor(private readonly config: Config) {}

  async *discover(options: DiscoverOptions = {}): AsyncIterable<DiscoveredConversation> {
    for (const sessionsDir of await this.getSessionsDirs(options)) {
      const filePaths = await globSourceFiles(
        "**/*.jsonl",
        sessionsDir,
        options.onIncomplete,
      );

      for (const filePath of filePaths.sort()) {
        if (!path.basename(filePath).startsWith("rollout-")) {
          continue;
        }

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
    const result = await this.inspectMetadataOnce(filePath, options.onWarning);
    return result.relationshipInspection;
  }

  async parseTranscript(
    filePath: string,
  ): Promise<Transcript> {
    const lines = await readCodexLines(filePath);
    const functionCalls = new Map<string, FunctionCallInfo>();
    const functionOutputs = new Map<string, FunctionCallOutputInfo>();
    const execCommandEnds = new Map<string, ExecCommandEndInfo>();

    for (const [index, line] of lines.entries()) {
      const payloadType = stringValue(line.payload?.type);

      if (line.type === "response_item" && payloadType === "function_call") {
        const callId = stringValue(line.payload?.call_id);
        if (!callId) {
          continue;
        }

        const rawArguments = stringValue(line.payload?.arguments);
        const parsedArguments = tryParseJson(rawArguments);
        functionCalls.set(callId, {
          toolName: stringValue(line.payload?.name) ?? "tool",
          toolInput: parsedArguments.ok ? parsedArguments.value : undefined,
          rawArguments,
        });
        continue;
      }

      if (line.type === "response_item" && payloadType === "function_call_output") {
        const callId = stringValue(line.payload?.call_id);
        if (!callId || functionOutputs.has(callId)) {
          continue;
        }

        functionOutputs.set(callId, {
          callId,
          output: stringValue(line.payload?.output),
          index,
          timestamp: normalizeTimestamp(line.timestamp),
        });
        continue;
      }

      if (line.type === "event_msg" && payloadType === "exec_command_end") {
        const callId = stringValue(line.payload?.call_id);
        if (!callId) {
          continue;
        }

        execCommandEnds.set(callId, {
          callId,
          exitCode: numberValue(line.payload?.exit_code),
          status: stringValue(line.payload?.status),
          outputPresent: codexFallbackOutputPresent(line.payload ?? {}),
        });
      }
    }

    const messages: Message[] = [];

    for (const [index, line] of lines.entries()) {
      const payloadType = stringValue(line.payload?.type);
      const timestamp = normalizeTimestamp(line.timestamp);

      if (line.type === "response_item" && payloadType === "message") {
        const role = stringValue(line.payload?.role);

        if (role === "user") {
          const text = extractCodexMessageText(line.payload?.content, "input_text");
          if (text) {
            messages.push({
              role: "user",
              content: text,
              timestamp,
            });
          }
          continue;
        }

        if (role === "assistant") {
          const text = extractCodexMessageText(line.payload?.content, "output_text");
          if (text) {
            messages.push({
              role: "assistant",
              content: text,
              timestamp,
            });
          }
        }
        continue;
      }

      if (line.type === "response_item" && payloadType === "function_call") {
        const callId = stringValue(line.payload?.call_id);
        const functionCall = callId ? functionCalls.get(callId) : undefined;
        const toolName = functionCall?.toolName ?? stringValue(line.payload?.name) ?? "tool";

        messages.push({
          role: "tool_use",
          content: `${toolName}: ${summarizeCodexArguments(
            functionCall?.toolInput,
            functionCall?.rawArguments,
          )}`,
          timestamp,
          toolName,
          toolInput: functionCall?.toolInput,
        });
        continue;
      }

      if (line.type === "response_item" && payloadType === "function_call_output") {
        const callId = stringValue(line.payload?.call_id);
        if (!callId) {
          continue;
        }

        const functionCall = functionCalls.get(callId);
        const exec = execCommandEnds.get(callId);
        const toolName = functionCall?.toolName ?? "tool";

        messages.push({
          role: "tool_result",
          content: summarizeCodexToolResult({
            toolName,
            functionCallOutput: stringValue(line.payload?.output),
            exec,
            isFallbackExec: false,
          }),
          timestamp,
          toolName,
        });
        continue;
      }

      if (line.type === "event_msg" && payloadType === "user_message") {
        const text = stringValue(line.payload?.message);
        if (!text) {
          continue;
        }

        if (hasNearbyCanonicalUserDuplicate(lines, index, text)) {
          continue;
        }

        messages.push({
          role: "user",
          content: text,
          timestamp,
        });
        continue;
      }

      if (line.type === "event_msg" && payloadType === "exec_command_end") {
        const callId = stringValue(line.payload?.call_id);
        if (!callId || functionOutputs.has(callId)) {
          continue;
        }

        const exec = execCommandEnds.get(callId);
        const functionCall = functionCalls.get(callId);
        const toolName = functionCall?.toolName ?? "exec_command";

        messages.push({
          role: "tool_result",
          content: summarizeCodexToolResult({
            toolName,
            functionCallOutput: null,
            exec,
            isFallbackExec: true,
          }),
          timestamp,
          toolName,
        });
      }
    }

    return { messages, warnings: [] };
  }

  watchPaths(): string[] {
    return this.config.sources["codex-cli"].paths.map(normalizeUserPath);
  }

  private async getSessionsDirs(options: DiscoverOptions): Promise<string[]> {
    const sessionsDirs: string[] = [];

    for (const configuredPath of this.watchPaths()) {
      const normalized = path.basename(configuredPath) === "sessions"
        ? configuredPath
        : path.join(configuredPath, "sessions");

      try {
        const stat = await fs.stat(normalized);
        if (!stat.isDirectory()) {
          throw new Error("not a directory");
        }
        sessionsDirs.push(normalized);
      } catch {
        options.onIncomplete?.();
        options.onWarning?.({
          code: "missing_source_file",
          message: "Configured Codex sessions directory is missing or unreadable.",
          source: this.name,
          path: normalized,
          guidance: "Fix the configured path or remove it from config.",
        });
      }
    }

    return sessionsDirs;
  }

  private async discoverFile(
    filePath: string,
    onWarning?: (warning: ClogWarning) => void,
  ): Promise<DiscoveredConversation | null> {
    const fileStat = await fs.stat(filePath).catch(() => null);
    if (!fileStat) {
      emitMalformedCodexWarning(this.name, filePath, onWarning);
      return null;
    }

    try {
      this.metadataInspectionCache.set(
        filePath,
        inspectCodexMetadata({
          filePath,
          onWarning,
          relationshipInspectionVersion: this.relationshipInspectionVersion,
          source: this.name,
        }),
      );
      const inspection = await this.inspectRelationships(filePath, { onWarning });
      const metadata = await this.inspectMetadataOnce(filePath, onWarning);
      if (metadata.discoveryFailed) {
        return null;
      }

      const state = metadata.discoveryState;
      const sourceId = resolveCodexSourceId({
        embeddedSourceId: state.embeddedSourceId,
        filenameSourceId: extractCodexSourceIdFromFilename(filePath),
        onWarning,
        filePath,
        source: this.name,
      });

      if (!sourceId) {
        return null;
      }

      const projectPath = state.sessionMetaCwd ?? state.turnContextCwd;
      const title = truncateTitle(
        state.finalTitle ?? state.pendingTitle?.text ?? "(untitled)",
      );

      return {
        sourceId,
        sourcePath: filePath,
        metadata: {
          title,
          summary: "",
          projectName: projectPath ? path.basename(projectPath) : null,
          projectPath,
          slug: null,
          createdAt:
            state.sessionMetaTimestamp ??
            state.firstTopLevelTimestamp ??
            fileStat.mtime.toISOString(),
        },
        relationshipInspection: {
          status: inspection.status,
          version: inspection.version,
          diagnostic: inspection.diagnostic,
        },
        relationships: inspection.relationships,
      };
    } catch {
      emitMalformedCodexWarning(this.name, filePath, onWarning);
      return null;
    } finally {
      this.metadataInspectionCache.delete(filePath);
    }
  }

  private inspectMetadataOnce(
    filePath: string,
    onWarning?: (warning: ClogWarning) => void,
  ): Promise<CodexMetadataInspection> {
    const cached = this.metadataInspectionCache.get(filePath);
    if (cached) {
      return cached;
    }

    return inspectCodexMetadata({
      filePath,
      onWarning,
      relationshipInspectionVersion: this.relationshipInspectionVersion,
      source: this.name,
    });
  }
}

async function inspectCodexMetadata(args: {
  filePath: string;
  onWarning?: (warning: ClogWarning) => void;
  relationshipInspectionVersion: number;
  source: string;
}): Promise<CodexMetadataInspection> {
  const state = createCodexDiscoveryState();
  const input = createReadStream(args.filePath, { encoding: "utf8" });
  const rl = readline.createInterface({
    input,
    crlfDelay: Infinity,
  });
  let lineNumber = 0;

  try {
    for await (const rawLine of rl) {
      lineNumber += 1;
      const trimmed = rawLine.trim();

      if (trimmed) {
        let parsed: unknown;

        try {
          parsed = JSON.parse(trimmed);
        } catch {
          emitMalformedCodexWarning(
            args.source,
            args.filePath,
            args.onWarning,
          );
          return malformedCodexMetadataInspection(
            state,
            args.relationshipInspectionVersion,
          );
        }

        const line = recordValue(parsed) as CodexLine | null;
        if (!line) {
          emitMalformedCodexWarning(
            args.source,
            args.filePath,
            args.onWarning,
          );
          return malformedCodexMetadataInspection(
            state,
            args.relationshipInspectionVersion,
          );
        }

        collectCodexDiscoveryMetadata(state, line, {
          filePath: args.filePath,
          onWarning: args.onWarning,
          source: args.source,
        });

        if (isCodexDiscoveryMetadataComplete(state)) {
          break;
        }
      }

      if (lineNumber >= SCAN_METADATA_MAX_LINES) {
        break;
      }
    }
  } finally {
    rl.close();
    input.destroy();
  }

  return {
    discoveryState: state,
    discoveryFailed: false,
    relationshipInspection: inspectCanonicalCodexRelationship({
      canonicalSessionMeta: state.canonicalSessionMeta,
      canonicalSessionMetaSeen: state.canonicalSessionMetaSeen,
      filenameSourceId: extractCodexSourceIdFromFilename(args.filePath),
      relationshipInspectionVersion: args.relationshipInspectionVersion,
      source: args.source,
    }),
  };
}

function malformedCodexMetadataInspection(
  discoveryState: CodexDiscoveryState,
  relationshipInspectionVersion: number,
): CodexMetadataInspection {
  return {
    discoveryState,
    discoveryFailed: true,
    relationshipInspection: unknownCodexRelationshipInspection(
      relationshipInspectionVersion,
      "codex_relationship_malformed_jsonl",
    ),
  };
}

function inspectCanonicalCodexRelationship(args: {
  canonicalSessionMeta: Record<string, unknown> | null;
  canonicalSessionMetaSeen: boolean;
  filenameSourceId: string | null;
  relationshipInspectionVersion: number;
  source: string;
}): RelationshipInspection {
  if (!args.canonicalSessionMetaSeen) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_session_meta_missing",
    );
  }
  if (!args.canonicalSessionMeta) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_session_meta_malformed",
    );
  }

  const sourceId = stringValue(args.canonicalSessionMeta.id);
  if (!sourceId || !isUuidLike(sourceId)) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_source_id_invalid",
    );
  }
  if (args.filenameSourceId && args.filenameSourceId !== sourceId) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_source_id_mismatch",
    );
  }

  const cliVersion = stringValue(args.canonicalSessionMeta.cli_version);
  if (!cliVersion || !isSemverLikeCodexCliVersion(cliVersion)) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_cli_version_invalid",
    );
  }

  const parentValue = args.canonicalSessionMeta.forked_from_id;
  if (parentValue == null) {
    return {
      status: "none_found",
      version: args.relationshipInspectionVersion,
      diagnostic: null,
      relationships: [],
    };
  }

  const parentSourceId = stringValue(parentValue);
  if (!parentSourceId || !isUuidLike(parentSourceId)) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_parent_id_invalid",
    );
  }
  if (parentSourceId === sourceId) {
    return unknownCodexRelationshipInspection(
      args.relationshipInspectionVersion,
      "codex_relationship_self_parent",
    );
  }

  return {
    status: "linked",
    version: args.relationshipInspectionVersion,
    diagnostic: null,
    relationships: [{
      kind: "branch",
      parent: {
        source: args.source,
        sourceId: parentSourceId,
      },
      evidence: "source",
      branchPoint: null,
    }],
  };
}

function unknownCodexRelationshipInspection(
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

function isSemverLikeCodexCliVersion(value: string): boolean {
  return /^\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?$/.test(value);
}

function createCodexDiscoveryState(): CodexDiscoveryState {
  return {
    canonicalSessionMeta: null,
    canonicalSessionMetaSeen: false,
    embeddedSourceId: null,
    firstTopLevelTimestamp: null,
    finalTitle: null,
    pendingTitle: null,
    sessionMetaCwd: null,
    sessionMetaTimestamp: null,
    turnContextCwd: null,
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return null;
  }
  return value as Record<string, unknown>;
}

function collectCodexDiscoveryMetadata(
  state: CodexDiscoveryState,
  line: CodexLine,
  args: {
    filePath: string;
    onWarning?: (warning: ClogWarning) => void;
    source: string;
  },
): void {
  state.firstTopLevelTimestamp ??= normalizeTimestamp(line.timestamp);

  if (line.type === "session_meta" && !state.canonicalSessionMetaSeen) {
    state.canonicalSessionMetaSeen = true;
    state.canonicalSessionMeta = recordValue(line.payload);
    const id = stringValue(state.canonicalSessionMeta?.id);
    if (id) {
      if (isUuidLike(id)) {
        state.embeddedSourceId = id;
      } else {
        args.onWarning?.({
          code: "missing_source_id",
          message: "Codex session_meta payload.id is not a valid UUID.",
          source: args.source,
          path: args.filePath,
        });
      }
    }

    state.sessionMetaCwd = stringValue(state.canonicalSessionMeta?.cwd);
    state.sessionMetaTimestamp = stringValue(
      state.canonicalSessionMeta?.timestamp,
    );
  }

  if (line.type === "turn_context") {
    state.turnContextCwd ??= stringValue(line.payload?.cwd);
  }

  collectCodexDiscoveryTitle(state, line);
}

function collectCodexDiscoveryTitle(state: CodexDiscoveryState, line: CodexLine): void {
  if (state.finalTitle) {
    return;
  }

  const payloadType = stringValue(line.payload?.type);

  if (!state.pendingTitle) {
    if (line.type === "response_item" && payloadType === "message") {
      if (stringValue(line.payload?.role) === "user") {
        const text = extractCodexMessageText(line.payload?.content, "input_text");
        if (text && !isWrapperOnlyCodexText(text)) {
          state.pendingTitle = {
            text,
            normalized: normalizeCodexText(text),
            timestamp: normalizeTimestamp(line.timestamp),
            adjacent: true,
          };
        }
      }
      return;
    }

    if (line.type === "event_msg" && payloadType === "user_message") {
      const text = stringValue(line.payload?.message);
      if (text) {
        state.finalTitle = text;
      }
    }
    return;
  }

  if (line.type === "event_msg" && payloadType === "user_message") {
    const text = stringValue(line.payload?.message);
    if (text && normalizeCodexText(text) === state.pendingTitle.normalized) {
      const eventTimestamp = normalizeTimestamp(line.timestamp);
      const sameTimestamp =
        state.pendingTitle.timestamp != null &&
        eventTimestamp != null &&
        state.pendingTitle.timestamp === eventTimestamp;
      if (sameTimestamp || state.pendingTitle.adjacent) {
        state.finalTitle = text;
        state.pendingTitle = null;
        return;
      }
    }
  }

  if (isIgnoredForDiscoveryTitleAdjacency(line)) {
    return;
  }

  const lineTimestamp = normalizeTimestamp(line.timestamp);
  if (
    state.pendingTitle.timestamp != null &&
    lineTimestamp != null &&
    state.pendingTitle.timestamp === lineTimestamp
  ) {
    state.pendingTitle.adjacent = false;
    return;
  }

  state.finalTitle = state.pendingTitle.text;
  state.pendingTitle = null;
}

function isIgnoredForDiscoveryTitleAdjacency(line: CodexLine): boolean {
  const payloadType = stringValue(line.payload?.type);

  if (line.type === "event_msg" && payloadType === "agent_message") {
    return true;
  }

  return isIgnoredForAdjacency(line);
}

function isCodexDiscoveryMetadataComplete(state: CodexDiscoveryState): boolean {
  return Boolean(
    state.embeddedSourceId &&
      state.sessionMetaCwd &&
      state.sessionMetaTimestamp &&
      state.finalTitle,
  );
}

function emitMalformedCodexWarning(
  source: string,
  filePath: string,
  onWarning?: (warning: ClogWarning) => void,
): void {
  onWarning?.({
    code: "malformed_jsonl",
    message: "Skipping malformed Codex CLI session file.",
    source,
    path: filePath,
    guidance: "Fix the JSONL or remove the malformed file.",
  });
}

function resolveCodexSourceId(args: {
  embeddedSourceId: string | null;
  filenameSourceId: string | null;
  onWarning?: (warning: ClogWarning) => void;
  filePath: string;
  source: string;
}): string | null {
  const { embeddedSourceId, filenameSourceId, onWarning, filePath, source } = args;

  if (embeddedSourceId && filenameSourceId && embeddedSourceId !== filenameSourceId) {
    onWarning?.({
      code: "source_id_mismatch",
      message: "Codex session ID in file contents does not match the filename suffix; using embedded ID.",
      source,
      path: filePath,
    });
    return embeddedSourceId;
  }

  if (embeddedSourceId) {
    return embeddedSourceId;
  }

  if (filenameSourceId) {
    return filenameSourceId;
  }

  onWarning?.({
    code: "missing_source_id",
    message: "Skipping Codex session because no valid UUID-shaped session ID was found.",
    source,
    path: filePath,
  });
  return null;
}

function extractCodexSourceIdFromFilename(filePath: string): string | null {
  const match = path.basename(filePath).match(UUID_SUFFIX_REGEX);
  return match?.[1] ?? null;
}

function isUuidLike(value: string): boolean {
  return UUID_REGEX.test(value);
}

function extractCodexMessageText(
  content: unknown,
  expectedType: "input_text" | "output_text",
): string | null {
  if (!Array.isArray(content)) {
    return null;
  }

  const parts = content
    .filter(
      (block): block is { type?: string; text?: string } =>
        typeof block === "object" && block !== null,
    )
    .filter((block) => block.type === expectedType && typeof block.text === "string")
    .map((block) => normalizeCodexProjectedText(block.text ?? "", expectedType))
    .filter(Boolean);

  return parts.length > 0 ? parts.join("\n\n") : null;
}

function normalizeCodexProjectedText(
  text: string,
  expectedType: "input_text" | "output_text",
): string {
  if (expectedType !== "input_text") {
    return text.trim();
  }

  return stripCodexUserWrappers(text).trim();
}

function stripCodexUserWrappers(text: string): string {
  let remaining = text.trim();
  let changed = true;

  while (changed) {
    changed = false;

    const withoutAgentsPrefix = remaining.replace(AGENTS_INSTRUCTIONS_PREFIX_REGEX, "");
    if (withoutAgentsPrefix !== remaining) {
      remaining = withoutAgentsPrefix.trimStart();
      changed = true;
    }

    for (const wrapper of KNOWN_WRAPPER_BLOCKS) {
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

  return remaining;
}

function isWrapperOnlyCodexText(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed) {
    return false;
  }

  let remaining = trimmed;
  let matchedAny = false;

  for (const wrapper of KNOWN_WRAPPER_BLOCKS) {
    const regex = new RegExp(`<${wrapper}>[\\s\\S]*?<\\/${wrapper}>`, "g");
    const next = remaining.replace(regex, () => {
      matchedAny = true;
      return "";
    });
    remaining = next;
  }

  return matchedAny && remaining.trim() === "";
}

function hasNearbyCanonicalUserDuplicate(
  lines: CodexLine[],
  eventIndex: number,
  text: string,
): boolean {
  const normalized = normalizeCodexText(text);
  const eventTimestamp = normalizeTimestamp(lines[eventIndex]?.timestamp);

  for (const [index, line] of lines.entries()) {
    if (line.type !== "response_item" || stringValue(line.payload?.type) !== "message") {
      continue;
    }

    if (stringValue(line.payload?.role) !== "user") {
      continue;
    }

    const candidate = extractCodexMessageText(line.payload?.content, "input_text");
    if (!candidate || normalizeCodexText(candidate) !== normalized) {
      continue;
    }

    const candidateTimestamp = normalizeTimestamp(line.timestamp);
    if (candidateTimestamp && eventTimestamp && candidateTimestamp === eventTimestamp) {
      return true;
    }

    const previous = previousRelevantIndex(lines, eventIndex);
    const next = nextRelevantIndex(lines, eventIndex);
    if (index === previous || index === next) {
      return true;
    }
  }

  return false;
}

function previousRelevantIndex(lines: CodexLine[], index: number): number {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    if (!isIgnoredForAdjacency(lines[cursor])) {
      return cursor;
    }
  }

  return -1;
}

function nextRelevantIndex(lines: CodexLine[], index: number): number {
  for (let cursor = index + 1; cursor < lines.length; cursor += 1) {
    if (!isIgnoredForAdjacency(lines[cursor])) {
      return cursor;
    }
  }

  return -1;
}

function isIgnoredForAdjacency(line: CodexLine): boolean {
  const payloadType = stringValue(line.payload?.type);

  if (line.type === "session_meta" || line.type === "turn_context") {
    return true;
  }

  if (line.type === "event_msg" && payloadType === "token_count") {
    return true;
  }

  if (line.type === "response_item" && payloadType === "reasoning") {
    return true;
  }

  if (line.type === "response_item" && payloadType === "message") {
    const role = stringValue(line.payload?.role);

    if (role === "developer") {
      return true;
    }

    if (role === "user") {
      return !extractCodexMessageText(line.payload?.content, "input_text");
    }

    if (role === "assistant") {
      return !extractCodexMessageText(line.payload?.content, "output_text");
    }

    return true;
  }

  return line.type !== "response_item" && line.type !== "event_msg";
}

function summarizeCodexArguments(parsed: unknown, raw?: string | null): string {
  if (parsed !== undefined) {
    const json = JSON.stringify(parsed);
    return json.length <= 120 ? json : `${json.slice(0, 117)}...`;
  }

  if (raw) {
    return raw.length <= 120 ? raw : `${raw.slice(0, 117)}...`;
  }

  return "{}";
}

function summarizeCodexToolResult(args: {
  toolName: string;
  functionCallOutput: string | null;
  exec?: ExecCommandEndInfo;
  isFallbackExec: boolean;
}): string {
  const { toolName, functionCallOutput, exec, isFallbackExec } = args;
  const outputPresent = functionCallOutputPresent(toolName, functionCallOutput);

  if (exec?.exitCode != null && exec.exitCode !== 0) {
    return `${toolName}: exit ${exec.exitCode}`;
  }

  if (functionCallOutput !== null) {
    if (exec?.exitCode === 0) {
      return `${toolName}: ${outputPresent ? "output" : "completed"}`;
    }

    return `${toolName}: ${outputPresent ? "output" : "completed"}`;
  }

  if (!exec) {
    return `${toolName}: ${isFallbackExec ? "completed" : "output"}`;
  }

  if (exec.exitCode === 0) {
    return `${toolName}: ${exec.outputPresent ? "output" : "completed"}`;
  }

  if (exec.status) {
    return `${toolName}: ${exec.status}`;
  }

  return `${toolName}: ${exec.outputPresent ? "output" : "completed"}`;
}

function functionCallOutputPresent(toolName: string, output: string | null): boolean {
  if (!output) {
    return false;
  }

  if (toolName === "exec_command") {
    const marker = "Output:\n";
    const markerIndex = output.indexOf(marker);
    if (markerIndex === -1) {
      return output.trim().length > 0;
    }

    return output.slice(markerIndex + marker.length).trim().length > 0;
  }

  return output.trim().length > 0;
}

function codexFallbackOutputPresent(payload: Record<string, unknown>): boolean {
  const formatted = stringValue(payload.formatted_output);
  if (formatted?.trim()) {
    return true;
  }

  const aggregated = stringValue(payload.aggregated_output);
  if (aggregated?.trim()) {
    return true;
  }

  return Boolean(stringValue(payload.stdout)?.trim() || stringValue(payload.stderr)?.trim());
}

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function numberValue(value: unknown): number | null {
  return typeof value === "number" ? value : null;
}

function normalizeTimestamp(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null;
}

function truncateTitle(value: string): string {
  return value.length <= 100 ? value : value.slice(0, 100);
}

function normalizeCodexText(value: string): string {
  return value.replaceAll("\r\n", "\n").trim();
}

function tryParseJson(
  raw: string | null,
): { ok: true; value: unknown } | { ok: false } {
  if (!raw) {
    return { ok: false };
  }

  try {
    return { ok: true, value: JSON.parse(raw) };
  } catch {
    return { ok: false };
  }
}

async function readCodexLines(filePath: string): Promise<CodexLine[]> {
  const raw = await fs.readFile(filePath, "utf8");

  return raw
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const parsed = recordValue(JSON.parse(line));
      if (!parsed) {
        throw new SyntaxError("Codex JSONL records must be objects.");
      }
      return parsed as CodexLine;
    });
}
