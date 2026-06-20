import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { isGitConversation, isNonLocalConversation, listConversations } from "../db/index.js";
import type { Config } from "../config/schema.js";
import type { ConversationMeta, ConversationState, Message } from "../models/conversation.js";
import { pathExists } from "../utils/fs.js";
import { ClogError, UsageError } from "../utils/errors.js";
import {
  getScanWarningsForCommand,
  parseConversationMessages,
  renderWarnings,
  resolveContentPath,
} from "./common.js";
import { collectProjectDrainTargets } from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";

type DrainFormat = "json" | "md";

interface DrainOptions {
  to?: string;
  toDir?: string;
  format?: string;
  raw?: boolean;
  force?: boolean;
  refresh?: boolean;
  state?: string;
  project?: string;
  author?: string;
  tag?: string;
  origin?: string;
}

interface DrainExport {
  id: string;
  source: string;
  title: string;
  summary: string;
  summaryKind: ConversationMeta["summaryKind"];
  extraction: ConversationMeta["summaryExtraction"];
  author: string;
  projectName: string | null;
  tags: string[];
  slug: string | null;
  createdAt: string;
  savedAt: string | null;
  state: ConversationState;
  messages: Message[];
}

export function buildDrainCommand(): Command {
  return new Command("drain")
    .description("Export conversations as JSON, markdown, or raw source")
    .argument("[selectors...]", "Conversation IDs or project selectors to export")
    .option("-o, --to <path>", "Write one exported conversation to this file path")
    .option("--to-dir <dir>", "Write one file per conversation to this directory")
    .option("-f, --format <fmt>", "Output format: json or md")
    .option("--raw", "Emit the exact underlying source file")
    .option("--force", "Overwrite an existing output file or directory entry")
    .option("--refresh", "Refresh local discovery before resolving the export set")
    .option("-s, --state <state>", "Exact state filter: discovered or saved")
    .option("-p, --project <name>", "Exact project metadata filter")
    .option("-a, --author <name>", "Exact author metadata filter")
    .option("-t, --tag <tag>", "Exact tag metadata filter")
    .option("--origin <origin>", "Exact origin filter: local or remote")
    .action(async (selectors: string[], options: DrainOptions) => {
      await runDrainCommand(selectors, options);
    });
}

async function runDrainCommand(selectors: string[], options: DrainOptions): Promise<void> {
  const format = parseFormat(options.format);
  validateDrainOptions(selectors, options, format);
  const hasFilters = hasFilterOptions(options);

  const config = await loadConfig();

  if (options.refresh) {
    const scanResult = await scanLocalSources(config);
    renderWarnings(getScanWarningsForCommand(scanResult));
  }

  const conversations = await resolveDrainConversations(selectors, options, config);
  if (conversations.length === 0) {
    if (selectors.length > 0 && hasFilters) {
      throw new ClogError(
        "No conversations match the requested export. The supplied ID(s) and filter(s) did not overlap.",
      );
    }

    throw new ClogError(
      "No conversations match the requested export. Try 'clog list' with the same filters to inspect the current set.",
    );
  }

  if (options.toDir) {
    await drainToDirectory(conversations, {
      config,
      format,
      raw: options.raw === true,
      force: options.force === true,
      targetDir: options.toDir,
    });
    return;
  }

  if (options.to) {
    await drainToFile(conversations, {
      config,
      format,
      raw: options.raw === true,
      force: options.force === true,
      targetPath: options.to,
    });
    return;
  }

  await drainToStdout(conversations, {
    config,
    format,
    raw: options.raw === true,
    hasFilters,
  });
}

function validateDrainOptions(
  selectors: string[],
  options: DrainOptions,
  format: DrainFormat,
): void {
  if (options.raw && options.format != null) {
    throw new UsageError("--raw cannot be combined with --format.");
  }

  if (options.to && options.toDir) {
    throw new UsageError("--to and --to-dir cannot be combined.");
  }

  if (options.force && !options.to && !options.toDir) {
    throw new UsageError("--force requires --to <path> or --to-dir <dir>.");
  }

  if (!options.to && !options.toDir && selectors.length === 0 && !hasFilterOptions(options)) {
    throw new UsageError("clog drain requires a conversation ID, a filter, --to <path>, or --to-dir <dir>.");
  }

  if (options.state != null && !isConversationState(options.state)) {
    throw new UsageError(
      `--state must be "discovered" or "saved", got "${options.state}".`,
    );
  }

  if (options.origin != null) {
    parseOriginFilter(options.origin);
  }

  if (options.raw && format !== "json") {
    throw new UsageError("--raw cannot be combined with --format.");
  }
}

async function resolveDrainConversations(
  selectors: string[],
  options: DrainOptions,
  config: Config,
): Promise<ConversationMeta[]> {
  const hasFilters = hasFilterOptions(options);
  const defaultScope = selectors.length === 0 && !hasFilters;
  const stateFilter = options.state as ConversationState | undefined;
  const states: ConversationState[] | undefined = stateFilter
    ? [stateFilter]
    : defaultScope
      ? ["saved"]
      : undefined;

  const filteredConversations = hasFilters || defaultScope
    ? await listConversations({
        states,
        projectName: options.project,
        author: options.author,
        tag: options.tag,
        origin: defaultScope && !config.author.trim()
          ? "local"
          : parseOriginFilter(options.origin),
        curatedDefault:
          defaultScope && config.author.trim().length > 0 ? { author: config.author.trim() } : null,
      })
    : null;

  const explicitConversations = selectors.length > 0
    ? resolveConversationSelectors({
        commandName: "clog drain",
        tokens: selectors,
        idCandidates: filteredConversations ?? (await listConversations()),
        projectCandidates: await collectProjectDrainTargets(filteredConversations),
      })
    : null;

  let conversations: ConversationMeta[];
  if (explicitConversations) {
    conversations = explicitConversations;
  } else {
    conversations = filteredConversations ?? [];
  }

  return dedupeAndSortConversations(conversations);
}

async function drainToStdout(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    format: DrainFormat;
    raw: boolean;
    hasFilters: boolean;
  },
): Promise<void> {
  if (options.raw) {
    if (conversations.length !== 1) {
      throw new UsageError("Raw stdout requires exactly one conversation.");
    }

    const payload = await readRawPayload(conversations[0]);
    process.stdout.write(payload);
    return;
  }

  if (options.format === "md") {
    if (conversations.length !== 1) {
      throw new UsageError("Markdown stdout requires exactly one conversation.");
    }

    const payload = await renderMarkdownExport(options.config, conversations[0]);
    process.stdout.write(payload);
    return;
  }

  const exports = await Promise.all(
    conversations.map((conversation) => buildDrainExport(options.config, conversation)),
  );
  const payload =
    !options.hasFilters && conversations.length === 1
      ? serializeJsonWithTrailingNewline(exports[0])
      : serializeJsonWithTrailingNewline(exports);
  process.stdout.write(payload);
}

async function drainToFile(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    format: DrainFormat;
    raw: boolean;
    force: boolean;
    targetPath: string;
  },
): Promise<void> {
  if (conversations.length !== 1) {
    throw new UsageError(
      "Single-file output requires exactly one conversation. Use --to-dir <dir> for multi-conversation export.",
    );
  }

  const parentDir = path.dirname(options.targetPath);
  if (!(await pathExists(parentDir))) {
    throw new ClogError(`Parent directory does not exist: ${parentDir}`);
  }

  if (!options.force && (await pathExists(options.targetPath))) {
    throw new ClogError(`Output file already exists: ${options.targetPath}`);
  }

  const conversation = conversations[0];
  const payload = options.raw
    ? await readRawPayload(conversation)
    : options.format === "md"
      ? await renderMarkdownExport(options.config, conversation)
      : serializeJsonWithTrailingNewline(
          await buildDrainExport(options.config, conversation),
        );

  await fs.writeFile(options.targetPath, payload);
}

async function drainToDirectory(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    format: DrainFormat;
    raw: boolean;
    force: boolean;
    targetDir: string;
  },
): Promise<void> {
  try {
    await fs.mkdir(options.targetDir, { recursive: true });
  } catch (error) {
    throw new ClogError(
      `Could not create export directory ${options.targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  const filenames = assignDrainFilenames(conversations, {
    format: options.format,
    raw: options.raw,
  });

  let succeeded = 0;
  let failed = 0;

  for (const conversation of conversations) {
    const filename = filenames.get(conversation.id);
    if (!filename) {
      continue;
    }

    const destination = path.join(options.targetDir, filename);

    try {
      if (!options.force && (await pathExists(destination))) {
        throw new ClogError(`Output file already exists: ${destination}`);
      }

      const payload = options.raw
        ? await readRawPayload(conversation)
        : options.format === "md"
          ? await renderMarkdownExport(options.config, conversation)
          : serializeJsonWithTrailingNewline(
              await buildDrainExport(options.config, conversation),
            );

      await fs.writeFile(destination, payload);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      process.stderr.write(
        `error: Could not drain ${conversation.id.slice(0, 8)}@${conversation.source}: ${
          error instanceof Error ? error.message : String(error)
        }\n`,
      );
    }
  }

  const summaryTarget = options.targetDir.endsWith(path.sep)
    ? options.targetDir
    : `${options.targetDir}${path.sep}`;
  const failureSuffix = failed > 0 ? ` (${failed} failed)` : "";
  process.stderr.write(
    `Drained ${succeeded} conversation${succeeded === 1 ? "" : "s"} to ${summaryTarget}${failureSuffix}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function buildDrainExport(
  config: Config,
  conversation: ConversationMeta,
): Promise<DrainExport> {
  const messages = await parseConversationMessages(config, conversation);
  return {
    id: conversation.id,
    source: conversation.source,
    title: conversation.title,
    summary: conversation.summary,
    summaryKind: conversation.summaryKind,
    extraction: conversation.summaryExtraction,
    author: conversation.author,
    projectName: conversation.projectName,
    tags: [...conversation.tags],
    slug: conversation.slug,
    createdAt: conversation.createdAt,
    savedAt: conversation.savedAt,
    state: conversation.state,
    messages,
  };
}

async function renderMarkdownExport(
  config: Config,
  conversation: ConversationMeta,
): Promise<string> {
  const exported = await buildDrainExport(config, conversation);
  const frontmatterLines = ["---"];
  frontmatterLines.push(`id: ${quoteYamlString(exported.id)}`);
  frontmatterLines.push(`source: ${quoteYamlString(exported.source)}`);
  frontmatterLines.push(`title: ${quoteYamlString(exported.title)}`);
  if (exported.summary !== "") {
    frontmatterLines.push(`summary: ${quoteYamlString(exported.summary)}`);
  }
  if (exported.summaryKind !== "none") {
    frontmatterLines.push(`summaryKind: ${quoteYamlString(exported.summaryKind)}`);
  }
  if (exported.extraction != null) {
    frontmatterLines.push(
      `extraction: ${quoteYamlString(JSON.stringify(exported.extraction))}`,
    );
  }
  frontmatterLines.push(`author: ${quoteYamlString(exported.author)}`);
  if (exported.projectName != null) {
    frontmatterLines.push(`project: ${quoteYamlString(exported.projectName)}`);
  }
  if (exported.tags.length > 0) {
    frontmatterLines.push(
      `tags: [${exported.tags.map((tag) => quoteYamlString(tag)).join(", ")}]`,
    );
  }
  if (exported.slug != null) {
    frontmatterLines.push(`slug: ${quoteYamlString(exported.slug)}`);
  }
  frontmatterLines.push(`created: ${quoteYamlString(exported.createdAt)}`);
  if (exported.savedAt != null) {
    frontmatterLines.push(`saved: ${quoteYamlString(exported.savedAt)}`);
  }
  frontmatterLines.push(`state: ${quoteYamlString(exported.state)}`);
  frontmatterLines.push(`messages: ${exported.messages.length}`);
  frontmatterLines.push("---");

  const transcript = exported.messages
    .map((message) => renderMarkdownMessage(message))
    .join("\n\n");

  return `${frontmatterLines.join("\n")}\n${transcript}${transcript ? "\n" : ""}`;
}

function renderMarkdownMessage(message: Message): string {
  const heading = getMarkdownHeading(message);
  const block = renderMarkdownMessageBlock(message);
  return block ? `${heading}\n\n${block}` : heading;
}

function getMarkdownHeading(message: Message): string {
  if (message.role === "user") {
    return "## User";
  }
  if (message.role === "assistant") {
    return "## Assistant";
  }
  if (message.role === "tool_use") {
    return message.toolName ? `## Tool Use: ${message.toolName}` : "## Tool Use";
  }
  return message.toolName ? `## Tool Result: ${message.toolName}` : "## Tool Result";
}

function renderMarkdownMessageBlock(message: Message): string | null {
  if (message.role === "tool_use") {
    if (message.toolInput === undefined) {
      return null;
    }
    if (typeof message.toolInput === "string") {
      return renderFencedBlock("text", message.toolInput);
    }
    return renderFencedBlock("json", serializeJsonWithoutTrailingNewline(message.toolInput));
  }

  return renderFencedBlock("text", message.content);
}

function renderFencedBlock(info: string, content: string): string {
  const maxRun = Math.max(...Array.from(content.matchAll(/`+/g), (match) => match[0].length), 0);
  const fence = "`".repeat(Math.max(3, maxRun + 1));
  return `${fence}${info ? info : ""}\n${content}\n${fence}`;
}

async function readRawPayload(conversation: ConversationMeta): Promise<Buffer> {
  const contentPath = resolveContentPath(conversation);

  try {
    return await fs.readFile(contentPath);
  } catch (error) {
    if (
      error != null &&
      typeof error === "object" &&
      "code" in error &&
      (error as NodeJS.ErrnoException).code === "ENOENT"
    ) {
      if (conversation.state === "discovered") {
        throw new ClogError(
          `Source file is missing for ${conversation.id}. Run "clog status" to refresh discovery.`,
        );
      }

      if (isGitConversation(conversation)) {
        throw new ClogError(
          `Remote checkout file is missing for ${conversation.id}. Run "clog refresh" to inspect the checkout, or "clog sync pull" to re-sync it.`,
        );
      }

      if (isNonLocalConversation(conversation)) {
        throw new ClogError(
          `Imported content file is missing for ${conversation.id}. Remove the imported row and import it again from its source.`,
        );
      }

      throw new ClogError(
        `Curated raw file is missing for ${conversation.id}. Run "clog save ${conversation.id.slice(0, 8)}" to recreate it from source if the source file is still available.`,
      );
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}

function serializeJsonWithTrailingNewline(value: unknown): string {
  return `${serializeJsonWithoutTrailingNewline(value)}\n`;
}

function serializeJsonWithoutTrailingNewline(value: unknown): string {
  return JSON.stringify(canonicalizeJson(value), null, 2);
}

function canonicalizeJson(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map((entry) => canonicalizeJson(entry));
  }

  if (value != null && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>);
    const orderedKeys = isDrainMessageObject(value)
      ? ["role", "content", "timestamp", "toolName", "toolInput"].filter((key) =>
          Object.hasOwn(value as object, key),
        )
      : isDrainExportObject(value)
        ? [
            "id",
            "source",
            "title",
            "summary",
            "summaryKind",
            "extraction",
            "author",
            "projectName",
            "tags",
            "slug",
            "createdAt",
            "savedAt",
            "state",
            "messages",
          ]
        : entries.map(([key]) => key).sort((left, right) => left.localeCompare(right));

    return Object.fromEntries(
      orderedKeys.map((key) => [key, canonicalizeJson((value as Record<string, unknown>)[key])]),
    );
  }

  return value;
}

function isDrainMessageObject(value: unknown): value is Record<string, unknown> {
  return (
    value != null &&
    typeof value === "object" &&
    "role" in value &&
    "content" in value &&
    "timestamp" in value
  );
}

function isDrainExportObject(value: unknown): value is DrainExport {
  return (
    value != null &&
    typeof value === "object" &&
    "id" in value &&
    "source" in value &&
    "messages" in value
  );
}

function quoteYamlString(value: string): string {
  return `"${value
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/"/g, '\\"')}"`;
}

function assignDrainFilenames(
  conversations: ConversationMeta[],
  options: { format: DrainFormat; raw: boolean },
): Map<string, string> {
  const extension = options.raw ? "jsonl" : options.format;
  const names = new Map<string, string>();

  for (const conversation of conversations) {
    names.set(conversation.id, `${conversation.id}.${extension}`);
  }

  return names;
}

function dedupeAndSortConversations(conversations: ConversationMeta[]): ConversationMeta[] {
  const seen = new Set<string>();
  const deduped: ConversationMeta[] = [];

  for (const conversation of conversations) {
    if (seen.has(conversation.id)) {
      continue;
    }
    seen.add(conversation.id);
    deduped.push(conversation);
  }

  deduped.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt.localeCompare(right.createdAt);
    }
    if (left.source !== right.source) {
      return left.source.localeCompare(right.source);
    }
    return left.id.localeCompare(right.id);
  });

  return deduped;
}

function parseFormat(value?: string): DrainFormat {
  if (value == null) {
    return "json";
  }
  if (value === "json" || value === "md") {
    return value;
  }
  throw new UsageError(`--format must be "json" or "md", got "${value}".`);
}

function parseOriginFilter(value?: string): "local" | "remote" | undefined {
  if (!value) {
    return undefined;
  }

  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "remote") {
    return normalized;
  }

  throw new UsageError(`--origin must be "local" or "remote", got "${value}".`);
}

function hasFilterOptions(options: DrainOptions): boolean {
  return Boolean(
    options.state ?? options.project ?? options.author ?? options.tag ?? options.origin,
  );
}

function isConversationState(value: string): value is ConversationState {
  return value === "discovered" || value === "saved";
}
