import fs from "node:fs/promises";
import path from "node:path";

import { glob } from "glob";

import type { Config } from "../config/schema.js";
import type { Message } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { normalizeUserPath } from "../utils/paths.js";
import type { DiscoverOptions, DiscoveredConversation, SourceAdapter } from "./adapter.js";

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

const UUID_SUFFIX_REGEX =
  /([0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12})\.jsonl$/;

const KNOWN_WRAPPER_BLOCKS = ["environment_context", "user_shell_command"];
const AGENTS_INSTRUCTIONS_PREFIX_REGEX =
  /^# AGENTS\.md instructions for [^\n]+\n\n<INSTRUCTIONS>[\s\S]*?<\/INSTRUCTIONS>\s*/;

export class CodexCliAdapter implements SourceAdapter {
  readonly name = "codex-cli";

  constructor(private readonly config: Config) {}

  async *discover(options: DiscoverOptions = {}): AsyncIterable<DiscoveredConversation> {
    for (const sessionsDir of await this.getSessionsDirs(options.onWarning)) {
      const filePaths = await glob("**/*.jsonl", {
        cwd: sessionsDir,
        absolute: true,
        nodir: true,
      });

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

  async parseMessages(filePath: string): Promise<Message[]> {
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

    return messages;
  }

  watchPaths(): string[] {
    return this.config.sources["codex-cli"].paths.map(normalizeUserPath);
  }

  private async getSessionsDirs(
    onWarning?: (warning: ClogWarning) => void,
  ): Promise<string[]> {
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
        onWarning?.({
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
    const lines = await readCodexLines(filePath).catch(() => null);

    if (!lines) {
      onWarning?.({
        code: "malformed_jsonl",
        message: "Skipping malformed Codex CLI session file.",
        source: this.name,
        path: filePath,
        guidance: "Fix the JSONL or remove the malformed file.",
      });
      return null;
    }

    const fileStat = await fs.stat(filePath);
    const filenameSourceId = extractCodexSourceIdFromFilename(filePath);

    let embeddedSourceId: string | null = null;
    let createdAt: string | null = null;
    let firstTopLevelTimestamp: string | null = null;
    let projectPath: string | null = null;
    let titleFromEvent: string | null = null;
    let titleFromCanonical: string | null = null;

    for (const line of lines) {
      if (!firstTopLevelTimestamp) {
        firstTopLevelTimestamp = normalizeTimestamp(line.timestamp);
      }

      if (line.type === "session_meta") {
        const id = stringValue(line.payload?.id);
        if (id) {
          if (isUuidLike(id)) {
            embeddedSourceId = id;
          } else {
            onWarning?.({
              code: "missing_source_id",
              message: "Codex session_meta payload.id is not a valid UUID.",
              source: this.name,
              path: filePath,
            });
          }
        }

        if (!projectPath) {
          projectPath = stringValue(line.payload?.cwd);
        }

        if (!createdAt) {
          createdAt = stringValue(line.payload?.timestamp);
        }
      }

      if (line.type === "turn_context" && !projectPath) {
        projectPath = stringValue(line.payload?.cwd);
      }

      if (!titleFromCanonical && line.type === "response_item" && stringValue(line.payload?.type) === "message") {
        if (stringValue(line.payload?.role) === "user") {
          const text = extractCodexMessageText(line.payload?.content, "input_text");
          if (text && !isWrapperOnlyCodexText(text)) {
            titleFromCanonical = text;
          }
        }
      }

      if (!titleFromEvent && line.type === "event_msg" && stringValue(line.payload?.type) === "user_message") {
        const text = stringValue(line.payload?.message);
        if (text) {
          titleFromEvent = text;
        }
      }
    }

    const sourceId = resolveCodexSourceId({
      embeddedSourceId,
      filenameSourceId,
      onWarning,
      filePath,
      source: this.name,
    });

    if (!sourceId) {
      return null;
    }

    const title = truncateTitle(titleFromEvent ?? titleFromCanonical ?? "(untitled)");

    return {
      sourceId,
      sourcePath: filePath,
      metadata: {
        title,
        summary: "",
        projectName: projectPath ? path.basename(projectPath) : null,
        projectPath,
        slug: null,
        createdAt: createdAt ?? firstTopLevelTimestamp ?? fileStat.mtime.toISOString(),
      },
    };
  }
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
  return UUID_SUFFIX_REGEX.test(`${value}.jsonl`);
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
    .map((line) => JSON.parse(line) as CodexLine);
}
