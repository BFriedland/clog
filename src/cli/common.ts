import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadConfig } from "../config/index.js";
import type { Config } from "../config/schema.js";
import type { LocalDiscoveryCandidate } from "../conversations/view.js";
import {
  classifyAdapterVersion,
  type Transcript,
} from "../adapters/adapter.js";
import {
  classifyInstalledRelationshipInspectionVersion,
  classifyInstalledTranscriptProjectionVersion,
} from "../adapters/registry.js";
import {
  type LocalConversation,
  requireLocalConversation,
} from "../conversations/write-guards.js";
import {
  getConversationById,
  resolveConversationId,
} from "../db/index.js";
import type { ConversationMeta, Message } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { isAggregatableWarningCode } from "../models/warnings.js";
import { ClogError, UsageError } from "../utils/errors.js";
import {
  getImportConversationPath,
  getRawConversationPath,
  getRawSourceDir,
  normalizeUserPath,
} from "../utils/paths.js";
import { getAdapter } from "../adapters/registry.js";
import { colorizeStateLabel, colorizeUserMessage } from "./colors.js";
import type { ScanResult } from "./scan.js";

const VERBOSE_WARNINGS_GUIDANCE = 'Run "clog status --verbose-warnings" for the full list';

class SourceFileMissingError extends ClogError {
  constructor(conversationId: string) {
    super(
      `Source file is missing for ${conversationId}. Run "clog status" to refresh discovery.`,
    );
    this.name = "SourceFileMissingError";
  }
}

class ConversationContentUnavailableError extends ClogError {
  constructor(message: string) {
    super(message);
    this.name = "ConversationContentUnavailableError";
  }
}

export interface DisplayRow {
  id: string;
  createdAt: string;
  state: string;
  source: string;
  projectName: string | null;
  author?: string | null;
  title: string;
  dim?: boolean;
}

export type DisplayColumnKey =
  | "id"
  | "date"
  | "state"
  | "source"
  | "project"
  | "author"
  | "title";

export async function resolveConversationOrFail(
  inputId: string,
): Promise<ConversationMeta> {
  if (inputId.startsWith("project:")) {
    throw new UsageError(
      `This command only accepts conversation IDs. Project selectors like "${inputId}" are not allowed here.`,
    );
  }

  const resolved = await resolveConversationId(inputId);
  const conversation = await getConversationById(resolved.id);

  if (!conversation) {
    throw new ClogError(`Conversation "${inputId}" not found.`);
  }

  return conversation;
}

export async function resolveManyConversationsOrFail(
  inputIds: string[],
): Promise<ConversationMeta[]> {
  return Promise.all(inputIds.map((id) => resolveConversationOrFail(id)));
}

export function assertNotRemote(
  conversation: ConversationMeta,
  command: string,
): asserts conversation is LocalConversation {
  requireLocalConversation(conversation, command);
}

export function assertNoneRemote(
  conversations: ConversationMeta[],
  command: string,
): asserts conversations is LocalConversation[] {
  for (const conversation of conversations) {
    assertNotRemote(conversation, command);
  }
}

export function resolveContentPath(conversation: ConversationMeta): string {
  if (conversation.state === "unsaved") {
    return conversation.sourcePath;
  }

  if (!conversation.filePath) {
    throw new ClogError(`Conversation ${conversation.id} has no curated raw file.`);
  }

  return conversation.filePath;
}

export async function parseConversationMessages(
  config: Config,
  conversation: ConversationMeta,
): Promise<Message[]> {
  return (await parseConversationTranscript(config, conversation)).messages;
}

async function parseConversationTranscript(
  config: Config,
  conversation: ConversationMeta,
): Promise<Transcript> {
  const adapter = getAdapter(conversation.source, config);
  const contentPath = resolveContentPath(conversation);

  if (
    conversation.state === "saved" &&
    classifyAdapterVersion(
      conversation.transcriptProjectionVersion,
      adapter.transcriptProjectionVersion,
    ) === "version_skew"
  ) {
    throw new ClogError(
      `Conversation ${conversation.id.slice(0, 8)} was saved with transcript projection version ${conversation.transcriptProjectionVersion}, but this clog build supports version ${adapter.transcriptProjectionVersion}. Use a newer clog version to read or refresh it.`,
    );
  }

  try {
    return await adapter.parseTranscript(contentPath);
  } catch (error) {
    throw wrapTranscriptContentError(error, conversation, contentPath);
  }
}

export async function filterConversationsByGrep(
  config: Config,
  needle: string,
  conversations: ConversationMeta[],
): Promise<ConversationMeta[]> {
  const lowered = needle.toLowerCase();
  const results: ConversationMeta[] = [];

  for (const conversation of conversations) {
    if (conversationMetadataMatchesGrep(conversation, lowered)) {
      results.push(conversation);
      continue;
    }

    try {
      const messages = await parseConversationMessages(config, conversation);
      if (messages.some((message) => message.content.toLowerCase().includes(lowered))) {
        results.push(conversation);
      }
    } catch {
      // Content unavailable (missing file, parse error); metadata-only match already checked.
    }
  }

  return results;
}

export function conversationMetadataMatchesGrep(
  conversation: Pick<ConversationMeta, "title" | "summary">,
  loweredNeedle: string,
): boolean {
  return (
    conversation.title.toLowerCase().includes(loweredNeedle) ||
    conversation.summary.toLowerCase().includes(loweredNeedle)
  );
}

export async function parseConversationMessagesFromPath(
  config: Config,
  source: string,
  filePath: string,
): Promise<Message[]> {
  return (
    await parseConversationTranscriptFromPath(config, source, filePath)
  ).messages;
}

export async function parseConversationTranscriptFromPath(
  config: Config,
  source: string,
  filePath: string,
): Promise<Transcript & { transcriptProjectionVersion: number }> {
  const adapter = getAdapter(source, config);
  try {
    return {
      ...(await adapter.parseTranscript(filePath)),
      transcriptProjectionVersion: adapter.transcriptProjectionVersion,
    };
  } catch (error) {
    throw wrapMissingPathError(error, filePath);
  }
}

export async function ensureRawCopy(
  conversation: ConversationMeta,
): Promise<string> {
  const destination = getRawConversationPath(conversation.source, conversation.id);
  await fs.mkdir(getRawSourceDir(conversation.source), { recursive: true });

  try {
    await fs.copyFile(conversation.sourcePath, destination);
  } catch (error) {
    throw wrapMissingContentError(error, conversation, conversation.sourcePath);
  }

  return destination;
}

export async function confirm(message: string): Promise<boolean> {
  if (!process.stdin.isTTY) {
    return false;
  }

  const rl = readline.createInterface({ input, output });
  try {
    const answer = await rl.question(`${message} [y/N] `);
    return answer.trim().toLowerCase() === "y";
  } finally {
    rl.close();
  }
}

export function renderWarnings(warnings: ClogWarning[]): void {
  if (warnings.length === 0) {
    return;
  }

  for (const warning of warnings) {
    const details = [
      warning.source ? `source=${warning.source}` : null,
      warning.diagnostic ? `diagnostic=${warning.diagnostic}` : null,
      warning.path ? `path=${warning.path}` : null,
      warning.paths ? `paths=${warning.paths.join(", ")}` : null,
      warning.guidance ? `hint: ${warning.guidance}` : null,
    ].filter(Boolean);

    const suffix = details.length > 0 ? ` (${details.join("; ")})` : "";
    process.stderr.write(`warning: ${warning.message}${suffix}\n`);
  }
}

export function getScanWarningsForCommand(
  scanResult: ScanResult,
  options: { suppressUndiscoverable?: boolean; verbose?: boolean } = {},
): ClogWarning[] {
  const baseWarnings = options.verbose
    ? [...scanResult.warnings]
    : collapseAggregatableWarnings(scanResult.warnings);

  if (!options.suppressUndiscoverable && scanResult.counts.undiscoverable > 0) {
    baseWarnings.push({
      code: "path_filter_without_project",
      message: `Skipped ${scanResult.counts.undiscoverable} conversation(s): project path missing: these conversation files have no cwd metadata.`,
      guidance: 'Run "clog status --undiscoverable" for details.',
    });
  }

  return baseWarnings;
}

interface AggregatableWarningGroup {
  first: ClogWarning;
  count: number;
}

type WarningOutputItem =
  | { kind: "warning"; warning: ClogWarning }
  | { kind: "group"; group: AggregatableWarningGroup };

export function collapseAggregatableWarnings(
  warnings: ClogWarning[],
): ClogWarning[] {
  const groups = new Map<string, AggregatableWarningGroup>();
  const output: WarningOutputItem[] = [];

  for (const warning of warnings) {
    if (!isAggregatableWarningCode(warning.code)) {
      output.push({ kind: "warning", warning });
      continue;
    }

    const key = getAggregatableWarningKey(warning);
    const group = groups.get(key);
    if (group) {
      group.count += 1;
    } else {
      const newGroup = { first: warning, count: 1 };
      groups.set(key, newGroup);
      output.push({ kind: "group", group: newGroup });
    }
  }

  return output.map((item) => {
    if (item.kind === "warning") {
      return item.warning;
    }

    const { first, count } = item.group;
    if (count < 2) {
      return first;
    }

    return {
      code: first.code,
      message: `${first.message} (${count} occurrences)`,
      ...(first.diagnostic ? { diagnostic: first.diagnostic } : {}),
      guidance: addVerboseWarningsGuidance(first.guidance),
    };
  });
}

function addVerboseWarningsGuidance(guidance: string | undefined): string {
  return guidance ? `${guidance} ${VERBOSE_WARNINGS_GUIDANCE}` : VERBOSE_WARNINGS_GUIDANCE;
}

function getAggregatableWarningKey(warning: ClogWarning): string {
  return JSON.stringify([
    warning.code,
    warning.source ?? null,
    warning.diagnostic ?? null,
    warning.message,
    warning.guidance ?? null,
  ]);
}

export function applyHeadTail<T>(
  items: T[],
  options: { head?: number; tail?: number },
): T[] {
  if (options.head != null && options.tail != null) {
    throw new ClogError("Cannot combine --head and --tail.");
  }

  if (options.head != null) {
    return items.slice(0, options.head);
  }

  if (options.tail != null) {
    return items.slice(Math.max(0, items.length - options.tail));
  }

  return items;
}

export function renderMessages(
  messages: Message[],
  options: { colorUserMessages?: boolean } = {},
): string {
  return messages
    .map((message) => {
      const role = message.role.toUpperCase();
      const rendered = `[${role}] ${message.content}`;
      if (options.colorUserMessages && message.role === "user") {
        return colorizeUserMessage(rendered);
      }

      return rendered;
    })
    .join("\n\n");
}

export function formatForSingleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

export function renderConversationTable(
  conversations: ConversationMeta[],
  options: {
    emptyMessage?: string;
    includeState?: boolean;
    includeSource?: boolean;
    stateLabelMode?: boolean;
    columns?: DisplayColumnKey[];
  } = {},
): void {
  if (conversations.length === 0) {
    process.stdout.write(`${options.emptyMessage ?? "No conversations found."}\n`);
    return;
  }

  renderDisplayTable(
    conversations.map((conversation) => ({
      id: conversation.id,
      createdAt: conversation.createdAt,
      state: conversation.state,
      source: conversation.source,
      projectName: conversation.projectName,
      author: conversation.author,
      title: conversation.title,
    })),
    options,
  );
}

export function renderDisplayTable(
  rows: DisplayRow[],
  options: {
    emptyMessage?: string;
    includeState?: boolean;
    includeSource?: boolean;
    stateLabelMode?: boolean;
    columns?: DisplayColumnKey[];
  } = {},
): void {
  if (rows.length === 0) {
    process.stdout.write(`${options.emptyMessage ?? "No conversations found."}\n`);
    return;
  }

  const terminalWidth = getTerminalWidth();
  const explicitColumns = options.columns ?? null;
  const includeSource = explicitColumns
    ? explicitColumns.includes("source")
    : (options.includeSource ?? new Set(rows.map((row) => row.source)).size > 1);
  const includeState = explicitColumns
    ? explicitColumns.includes("state")
    : (options.includeState ?? true);
  const includeAuthor = explicitColumns
    ? explicitColumns.includes("author")
    : new Set(rows.map((row) => row.author).filter(Boolean)).size > 1;

  const columns: Array<{ key: string; width?: number; value: (row: DisplayRow) => string }> = [
    { key: "id", value: (row) => row.id.slice(0, 8) },
    { key: "date", value: (row) => formatDate(row.createdAt) },
  ];

  if (includeState) {
    columns.push({
      key: "state",
      value: (row) => row.state,
    });
  }

  if (includeSource) {
    columns.push({
      key: "source",
      value: (row) => row.source,
    });
  }

  if (includeAuthor) {
    columns.push({
      key: "author",
      value: (row) => row.author ?? "-",
    });
  }

  columns.push(
    {
      key: "project",
      value: (row) => row.projectName ?? "-",
    },
    {
      key: "title",
      value: (row) => row.title,
    },
  );

  const finalColumns =
    explicitColumns == null
      ? columns
      : explicitColumns
          .map((key) => columns.find((column) => column.key === key))
          .filter((column): column is (typeof columns)[number] => column != null);

  const separator = "";
  const computedColumns = finalColumns.map((column, index) => {
    if (column.key === "title") {
      const occupied = finalColumns
        .slice(0, index)
        .reduce((sum, prior) => sum + getColumnWidth(prior, rows), 0);
      return {
        ...column,
        width: Math.max(4, terminalWidth - occupied),
      };
    }

    return {
      ...column,
      width: getColumnWidth(column, rows),
    };
  });

  process.stdout.write(
    `${computedColumns
      .map((column) => padCell(column.key.toUpperCase(), column.width))
      .join(separator)}\n`,
  );

  for (const row of rows) {
    const line = computedColumns
      .map((column) => {
        const value = padCell(column.value(row), column.width);
        if (options.stateLabelMode && column.key === "state") {
          return colorizeStateLabel(value, {
            state: row.state as ConversationMeta["state"],
          } as ConversationMeta);
        }
        return value;
      })
      .join(separator);
    process.stdout.write(`${row.dim ? dimTextInline(line) : line}\n`);
  }
}

function getColumnWidth(
  column: { key: string; value: (row: DisplayRow) => string },
  rows: DisplayRow[],
): number {
  const headerWidth = column.key.toUpperCase().length;
  const contentWidth = rows.reduce((maxWidth, row) => {
    const rendered = formatForSingleLine(column.value(row));
    return Math.max(maxWidth, rendered.length);
  }, 0);

  return Math.max(headerWidth, contentWidth) + 1;
}

function padCell(value: string, width: number): string {
  const singleLine = formatForSingleLine(value);
  if (singleLine.length <= width) {
    return singleLine.padEnd(width);
  }

  if (width <= 3) {
    return singleLine.slice(0, width);
  }

  return `${singleLine.slice(0, width - 3)}...`;
}

function formatDate(value: string): string {
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    return "----------";
  }

  return date.toISOString().slice(0, 10);
}

function dimTextInline(value: string): string {
  return `\u001b[2m${value}\u001b[22m`;
}

export async function removeRawCopyIfPresent(
  conversation: Pick<ConversationMeta, "id" | "source">,
): Promise<void> {
  const rawPath = getRawConversationPath(conversation.source, conversation.id);
  try {
    await fs.rm(rawPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export async function removeImportCopyIfPresent(
  conversation: Pick<ConversationMeta, "id" | "source">,
): Promise<void> {
  const importPath = getImportConversationPath(conversation.source, conversation.id);
  try {
    await fs.rm(importPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") {
      throw error;
    }
  }
}

export function defaultSaveFilePath(conversation: ConversationMeta): string {
  return getRawConversationPath(conversation.source, conversation.id);
}

async function compareFileContents(
  leftPath: string,
  rightPath: string,
): Promise<boolean> {
  let leftContent: Buffer;
  let rightContent: Buffer;

  try {
    [leftContent, rightContent] = await Promise.all([
      fs.readFile(leftPath),
      fs.readFile(rightPath),
    ]);
  } catch (error) {
    throw wrapMissingPathError(error, leftPath, rightPath);
  }

  return leftContent.equals(rightContent);
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export function pathsIdentifySameManagedCopy(
  leftPath: string | null | undefined,
  rightPath: string | null | undefined,
): boolean {
  if (!leftPath || !rightPath) {
    return false;
  }

  return normalizeUserPath(leftPath) === normalizeUserPath(rightPath);
}

export async function hasReadableIndependentSource(
  conversation: ConversationMeta,
): Promise<boolean> {
  if (pathsIdentifySameManagedCopy(conversation.sourcePath, conversation.filePath)) {
    return false;
  }

  return pathExists(conversation.sourcePath);
}

// Heuristic for fill-restored rows: projectPath is null only for `fill --own`
// imports, because discovery drops projectPath-less source conversations and an
// ordinary saved local row therefore has one. `clog save` attaches a matching
// scan candidate's current sourcePath to the saved row in memory without copying
// candidate project metadata. The null projectPath keeps this predicate true and
// preserves the restored-content overwrite confirmation.
export function isLikelyRestoredLocalConversation(
  conversation: ConversationMeta,
): boolean {
  return (
    conversation.originKind === "local" &&
    conversation.state === "saved" &&
    conversation.filePath != null &&
    conversation.projectPath == null
  );
}

export function getTerminalWidth(): number {
  const envColumns = Number(process.env.COLUMNS);
  if (Number.isFinite(envColumns) && envColumns > 0) {
    return envColumns;
  }

  const stdoutColumns = process.stdout.columns;
  if (stdoutColumns && stdoutColumns > 0) {
    return stdoutColumns;
  }

  return 100;
}

export type SavedDelta =
  | "clean"
  | "content_unavailable"
  | "ready"
  | "source_ahead"
  | "version_skew";

export async function classifySavedDelta(
  conversation: ConversationMeta,
  liveCandidate?: LocalDiscoveryCandidate | null,
): Promise<SavedDelta> {
  if (conversation.state !== "saved") {
    return "clean";
  }

  const projectionVersion = classifyInstalledTranscriptProjectionVersion(
    conversation.source,
    conversation.transcriptProjectionVersion,
  );
  const relationshipVersion = classifyInstalledRelationshipInspectionVersion(
    conversation.source,
    conversation.relationshipInspection.version,
  );
  if (
    projectionVersion === "version_skew" ||
    relationshipVersion === "version_skew"
  ) {
    return "version_skew";
  }

  if (!conversation.filePath) {
    return "source_ahead";
  }

  const rawExists = await pathExists(conversation.filePath);
  if (!rawExists) {
    return "source_ahead";
  }

  const sourcePath =
    liveCandidate === undefined ? conversation.sourcePath : liveCandidate?.sourcePath;
  if (sourcePath && await pathExists(sourcePath)) {
    const sourceDiffers = !(await compareFileContents(
      sourcePath,
      conversation.filePath,
    ));
    if (sourceDiffers) {
      return "source_ahead";
    }
  }

  if (
    projectionVersion === "refreshable" ||
    relationshipVersion === "refreshable"
  ) {
    return "ready";
  }

  if (!conversation.savedAt) {
    return "ready";
  }

  if (conversation.savedMessageCount == null) {
    return "ready";
  }

  const config = await loadConfig();
  let messages: Message[];
  try {
    messages = await parseConversationMessages(config, conversation);
  } catch (error) {
    if (error instanceof ConversationContentUnavailableError) {
      return "content_unavailable";
    }
    throw error;
  }
  return messages.length > conversation.savedMessageCount ? "ready" : "clean";
}

export async function getSaveCandidate(conversation: ConversationMeta): Promise<{
  path: string;
  shouldRefreshRawCopy: boolean;
}>;
export async function getSaveCandidate(
  conversation: ConversationMeta,
  liveCandidate: LocalDiscoveryCandidate | null,
): Promise<{ path: string; shouldRefreshRawCopy: boolean }>;
export async function getSaveCandidate(
  conversation: ConversationMeta,
  liveCandidate?: LocalDiscoveryCandidate | null,
): Promise<{
  path: string;
  shouldRefreshRawCopy: boolean;
}> {
  if (conversation.state === "unsaved") {
    if (!(await pathExists(conversation.sourcePath))) {
      throw new SourceFileMissingError(conversation.id);
    }

    return {
      path: conversation.sourcePath,
      shouldRefreshRawCopy: true,
    };
  }

  if (!conversation.filePath) {
    throw new ClogError(`Conversation ${conversation.id} has no curated raw file.`);
  }

  const rawExists = await pathExists(conversation.filePath);
  const sourcePath =
    liveCandidate === undefined ? conversation.sourcePath : liveCandidate?.sourcePath;

  if (!rawExists) {
    if (sourcePath && await pathExists(sourcePath)) {
      return {
        path: sourcePath,
        shouldRefreshRawCopy: true,
      };
    }

    throw new ClogError(
      `Curated raw file is missing for ${conversation.id}, and the source file is unavailable. Run "clog status" to refresh discovery.`,
    );
  }

  if (!sourcePath || !(await pathExists(sourcePath))) {
    return {
      path: conversation.filePath,
      shouldRefreshRawCopy: false,
    };
  }

  const sourceDiffers = !(await compareFileContents(
    sourcePath,
    conversation.filePath,
  ));

  if (sourceDiffers) {
    return {
      path: sourcePath,
      shouldRefreshRawCopy: true,
    };
  }

  return {
    path: conversation.filePath,
    shouldRefreshRawCopy: false,
  };
}

function wrapMissingContentError(
  error: unknown,
  conversation: ConversationMeta,
  attemptedPath: string,
): Error {
  if (!isMissingFileError(error)) {
    if (isContentFileAccessError(error)) {
      return new ConversationContentUnavailableError(
        `Conversation content file cannot be read at ${attemptedPath}.`,
      );
    }
    return error instanceof Error ? error : new Error(String(error));
  }

  if (conversation.state === "unsaved") {
    return new SourceFileMissingError(conversation.id);
  }

  if (conversation.filePath && attemptedPath === conversation.filePath) {
    return new ConversationContentUnavailableError(
      `Curated raw file is missing for ${conversation.id}. Run "clog save ${conversation.id.slice(0, 8)}" to recreate it from source if the source file is still available.`,
    );
  }

  return new ConversationContentUnavailableError(
    `Conversation content file is missing at ${attemptedPath}.`,
  );
}

function wrapTranscriptContentError(
  error: unknown,
  conversation: ConversationMeta,
  attemptedPath: string,
): Error {
  if (error instanceof SyntaxError) {
    return new ConversationContentUnavailableError(
      `Conversation content file cannot be parsed at ${attemptedPath}.`,
    );
  }
  return wrapMissingContentError(error, conversation, attemptedPath);
}

function wrapMissingPathError(
  error: unknown,
  ...paths: string[]
): Error {
  if (!isMissingFileError(error)) {
    return error instanceof Error ? error : new Error(String(error));
  }

  return new ClogError(`Conversation content file is missing at ${paths.join(" or ")}.`);
}

function isMissingFileError(error: unknown): boolean {
  return (
    error != null &&
    typeof error === "object" &&
    "code" in error &&
    (error as NodeJS.ErrnoException).code === "ENOENT"
  );
}

function isContentFileAccessError(error: unknown): boolean {
  if (
    error == null ||
    typeof error !== "object" ||
    !("code" in error)
  ) {
    return false;
  }
  return ["ENOENT", "EACCES", "EPERM", "EISDIR"].includes(
    String((error as NodeJS.ErrnoException).code),
  );
}
