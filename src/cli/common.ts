import fs from "node:fs/promises";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";

import { loadConfig } from "../config/index.js";
import type { Config } from "../config/schema.js";
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

export class SourceFileMissingError extends ClogError {
  constructor(conversationId: string) {
    super(
      `Source file is missing for ${conversationId}. Run "clog status" to refresh discovery.`,
    );
    this.name = "SourceFileMissingError";
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
  const adapter = getAdapter(conversation.source, config);
  const contentPath = resolveContentPath(conversation);

  try {
    return await adapter.parseMessages(contentPath);
  } catch (error) {
    throw wrapMissingContentError(error, conversation, contentPath);
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
  const adapter = getAdapter(source, config);
  try {
    return await adapter.parseMessages(filePath);
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

export function printConversationRows(conversations: ConversationMeta[]): void {
  renderConversationTable(conversations);
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

function collapseAggregatableWarnings(warnings: ClogWarning[]): ClogWarning[] {
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

export async function rawCopyMatchesSource(conversation: ConversationMeta): Promise<boolean> {
  if (!conversation.filePath) {
    return false;
  }

  return compareFileContents(conversation.sourcePath, conversation.filePath);
}

export function defaultSaveFilePath(conversation: ConversationMeta): string {
  return getRawConversationPath(conversation.source, conversation.id);
}

export async function compareFileContents(
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

export async function pathExists(filePath: string): Promise<boolean> {
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
// imports, because scan drops projectPath-less sources as undiscoverable, so an
// ordinary saved local row always has one. Scan re-attaches a live sourcePath to a
// restored row but does NOT set its projectPath (src/cli/scan.ts saved-row
// branch), which is what keeps this true after a scan. If re-attachment is ever
// completed to also set projectPath, this returns false and the save guard in
// confirmRestoredOverwriteIfNeeded stops firing.
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

export type SavedDelta = "clean" | "ready" | "source_ahead";

export async function classifySavedDelta(
  conversation: ConversationMeta,
): Promise<SavedDelta> {
  if (conversation.state !== "saved") {
    return "clean";
  }

  if (!conversation.filePath) {
    return "source_ahead";
  }

  const rawExists = await pathExists(conversation.filePath);
  if (!rawExists) {
    return "source_ahead";
  }

  if (await pathExists(conversation.sourcePath)) {
    const sourceDiffers = !(await compareFileContents(
      conversation.sourcePath,
      conversation.filePath,
    ));
    if (sourceDiffers) {
      return "source_ahead";
    }
  }

  if (!conversation.savedAt) {
    return "ready";
  }

  if (conversation.savedMessageCount == null) {
    return "ready";
  }

  const config = await loadConfig();
  const messages = await parseConversationMessages(config, conversation);
  return messages.length > conversation.savedMessageCount ? "ready" : "clean";
}

export function isSavedMetadataAhead(
  conversation: ConversationMeta,
): boolean {
  if (conversation.state !== "saved" || !conversation.savedAt) {
    return false;
  }

  const modifiedAt = Date.parse(conversation.modifiedAt);
  const savedAt = Date.parse(conversation.savedAt);
  if (Number.isNaN(modifiedAt) || Number.isNaN(savedAt)) {
    return false;
  }

  return modifiedAt > savedAt;
}

export async function isSavedReadyForResave(
  conversation: ConversationMeta,
): Promise<boolean> {
  return isSavedReadyForResaveWithDelta(
    conversation,
    await classifySavedDelta(conversation),
  );
}

export function isSavedReadyForResaveWithDelta(
  conversation: ConversationMeta,
  delta: SavedDelta,
): boolean {
  return delta === "ready" || (delta === "clean" && isSavedMetadataAhead(conversation));
}

export async function getSaveCandidate(conversation: ConversationMeta): Promise<{
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
  if (!rawExists) {
    if (await pathExists(conversation.sourcePath)) {
      return {
        path: conversation.sourcePath,
        shouldRefreshRawCopy: true,
      };
    }

    throw new ClogError(
      `Curated raw file is missing for ${conversation.id}, and the source file is unavailable. Run "clog status" to refresh discovery.`,
    );
  }

  if (!(await pathExists(conversation.sourcePath))) {
    return {
      path: conversation.filePath,
      shouldRefreshRawCopy: false,
    };
  }

  const sourceDiffers = !(await compareFileContents(
    conversation.sourcePath,
    conversation.filePath,
  ));

  if (sourceDiffers) {
    return {
      path: conversation.sourcePath,
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
    return error instanceof Error ? error : new Error(String(error));
  }

  if (conversation.state === "unsaved") {
    return new SourceFileMissingError(conversation.id);
  }

  if (conversation.filePath && attemptedPath === conversation.filePath) {
    return new ClogError(
      `Curated raw file is missing for ${conversation.id}. Run "clog save ${conversation.id.slice(0, 8)}" to recreate it from source if the source file is still available.`,
    );
  }

  return new ClogError(`Conversation content file is missing at ${attemptedPath}.`);
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
