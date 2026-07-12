import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";

import { isSourceParseSupported } from "../adapters/registry.js";
import { loadConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import { conversationToPairMetadata, pairMetadataSchema, writePair } from "../interchange/pairs.js";
import type { Config } from "../config/schema.js";
import type { ConversationMeta, ConversationState } from "../models/conversation.js";
import { pathExists } from "../utils/fs.js";
import { ClogError, UsageError } from "../utils/errors.js";
import {
  getScanWarningsForCommand,
  parseConversationMessages,
  renderWarnings,
} from "./common.js";
import {
  buildConversationExport,
  type ConversationExport,
  readConversationRaw,
  renderConversationMarkdown,
  serializeConversationJson,
} from "./conversation-renderers.js";
import { collectProjectDrainTargets } from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";

type DrainFormat = "json" | "md" | "pair";

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

export function buildDrainCommand(): Command {
  return new Command("drain")
    .description("Export conversations as JSON, markdown, pair files, or raw source")
    .argument("[selectors...]", "Conversation IDs or project selectors to export")
    .option("-o, --to <path>", "Write one exported conversation to this file path")
    .option("--to-dir <dir>", "Write one file per conversation to this directory")
    .option("-f, --format <fmt>", "Output format: json, md, or pair")
    .option("--raw", "Emit the exact underlying source file")
    .option("--force", "Overwrite an existing output file or directory entry")
    .option("--refresh", "Refresh local discovery before resolving the export set")
    .option("-s, --state <state>", "Exact state filter: unsaved or saved")
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

  const { conversations, skippedUnsaved } = await resolveDrainConversations(
    selectors,
    options,
    config,
    format,
  );
  if (conversations.length === 0) {
    if (format === "pair" && skippedUnsaved > 0) {
      throw new ClogError(
        `No saved conversations to export as pairs. ${skippedUnsaved} matching conversation${
          skippedUnsaved === 1 ? " is" : "s are"
        } unsaved; save ${
          skippedUnsaved === 1 ? "it" : "them"
        } first with 'clog save', then retry.`,
      );
    }

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
      skippedUnsaved,
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

  if (format === "pair" && !options.toDir) {
    if (options.to) {
      throw new UsageError("--format pair requires --to-dir <dir>, not --to <path>.");
    }
    throw new UsageError("--format pair requires --to-dir <dir>.");
  }

  if (!options.to && !options.toDir && selectors.length === 0 && !hasFilterOptions(options)) {
    throw new UsageError("clog drain requires a conversation ID, a filter, --to <path>, or --to-dir <dir>.");
  }

  if (options.state != null && !isConversationState(options.state)) {
    throw new UsageError(
      `--state must be "unsaved" or "saved", got "${options.state}".`,
    );
  }

  if (options.origin != null) {
    parseOriginFilter(options.origin);
  }

  if (options.raw && format !== "json") {
    throw new UsageError("--raw cannot be combined with --format.");
  }
}

interface ResolvedDrainConversations {
  conversations: ConversationMeta[];
  skippedUnsaved: number;
}

async function resolveDrainConversations(
  selectors: string[],
  options: DrainOptions,
  config: Config,
  format: DrainFormat,
): Promise<ResolvedDrainConversations> {
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

  // Pair export targets saved rows. Unsaved rows reached by a broad
  // selection (a project selector or a filter) are dropped here; an explicitly
  // named unsaved ID is left in so it surfaces as a per-conversation failure.
  const droppedUnsaved = new Set<string>();
  const projectSelectionFilter =
    format === "pair"
      ? (conversation: ConversationMeta): boolean => {
          if (conversation.state !== "saved") {
            droppedUnsaved.add(conversation.id);
            return false;
          }
          return true;
        }
      : undefined;

  const explicitConversations = selectors.length > 0
    ? resolveConversationSelectors({
        commandName: "clog drain",
        tokens: selectors,
        idCandidates: filteredConversations ?? (await listConversations()),
        projectCandidates: await collectProjectDrainTargets(filteredConversations),
        projectSelectionFilter,
      })
    : null;

  let conversations: ConversationMeta[];
  if (explicitConversations) {
    conversations = explicitConversations;
  } else {
    conversations = filteredConversations ?? [];

    if (format === "pair") {
      for (const conversation of conversations) {
        if (conversation.state !== "saved") {
          droppedUnsaved.add(conversation.id);
        }
      }
      conversations = conversations.filter(
        (conversation) => conversation.state === "saved",
      );
    }
  }

  const deduped = dedupeAndSortConversations(conversations);
  const keptIds = new Set(deduped.map((conversation) => conversation.id));
  const skippedUnsaved = [...droppedUnsaved].filter(
    (id) => !keptIds.has(id),
  ).length;

  return { conversations: deduped, skippedUnsaved };
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

    const payload = await readConversationRaw(conversations[0]);
    process.stdout.write(payload);
    return;
  }

  if (options.format === "md") {
    if (conversations.length !== 1) {
      throw new UsageError("Markdown stdout requires exactly one conversation.");
    }

    const payload = await renderParsedMarkdown(options.config, conversations[0]);
    process.stdout.write(payload);
    return;
  }

  const exports = await Promise.all(
    conversations.map((conversation) => buildParsedConversationExport(options.config, conversation)),
  );
  const payload =
    !options.hasFilters && conversations.length === 1
      ? serializeConversationJson(exports[0])
      : serializeConversationJson(exports);
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
    ? await readConversationRaw(conversation)
    : options.format === "md"
      ? await renderParsedMarkdown(options.config, conversation)
      : serializeConversationJson(
          await buildParsedConversationExport(options.config, conversation),
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
    skippedUnsaved: number;
  },
): Promise<void> {
  try {
    await fs.mkdir(options.targetDir, { recursive: true });
  } catch (error) {
    throw new ClogError(
      `Could not create export directory ${options.targetDir}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }

  if (options.format === "pair") {
    await drainPairsToDirectory(conversations, options);
    return;
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
        ? await readConversationRaw(conversation)
        : options.format === "md"
          ? await renderParsedMarkdown(options.config, conversation)
          : serializeConversationJson(
              await buildParsedConversationExport(options.config, conversation),
            );

      await fs.writeFile(destination, payload);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      reportDirectoryDrainFailure(conversation, error);
    }
  }

  reportDirectoryDrainSummary(succeeded, failed, options.targetDir, options.skippedUnsaved);
}

async function drainPairsToDirectory(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    force: boolean;
    targetDir: string;
    skippedUnsaved: number;
  },
): Promise<void> {
  let succeeded = 0;
  let failed = 0;

  for (const conversation of conversations) {
    try {
      await writeConversationPair(conversation, options);
      succeeded += 1;
    } catch (error) {
      failed += 1;
      reportDirectoryDrainFailure(conversation, error);
    }
  }

  reportDirectoryDrainSummary(succeeded, failed, options.targetDir, options.skippedUnsaved);
}

function reportDirectoryDrainFailure(
  conversation: ConversationMeta,
  error: unknown,
): void {
  process.stderr.write(
    `error: Could not drain ${conversation.id.slice(0, 8)}@${conversation.source}: ${
      error instanceof Error ? error.message : String(error)
    }\n`,
  );
}

function reportDirectoryDrainSummary(
  succeeded: number,
  failed: number,
  targetDir: string,
  skippedUnsaved = 0,
): void {
  const summaryTarget = targetDir.endsWith(path.sep)
    ? targetDir
    : `${targetDir}${path.sep}`;
  const noteParts: string[] = [];
  if (failed > 0) {
    noteParts.push(`${failed} failed`);
  }
  if (skippedUnsaved > 0) {
    noteParts.push(`${skippedUnsaved} unsaved skipped`);
  }
  const note = noteParts.length > 0 ? ` (${noteParts.join(", ")})` : "";
  process.stderr.write(
    `Drained ${succeeded} conversation${succeeded === 1 ? "" : "s"} to ${summaryTarget}${note}\n`,
  );

  if (failed > 0) {
    process.exitCode = 1;
  }
}

async function writeConversationPair(
  conversation: ConversationMeta,
  options: {
    config: Config;
    force: boolean;
    targetDir: string;
  },
): Promise<void> {
  if (conversation.state !== "saved") {
    throw new ClogError(
      "Pair export requires saved conversations. Save this conversation before exporting it as a pair.",
    );
  }

  const sourceDir = path.join(options.targetDir, conversation.source);
  const jsonlPath = path.join(sourceDir, `${conversation.id}.jsonl`);
  const metaPath = path.join(sourceDir, `${conversation.id}.meta.json`);

  if (!options.force) {
    const conflicts: string[] = [];
    if (await pathExists(jsonlPath)) {
      conflicts.push(jsonlPath);
    }
    if (await pathExists(metaPath)) {
      conflicts.push(metaPath);
    }

    if (conflicts.length > 0) {
      throw new ClogError(
        `Output pair already exists: ${conflicts.join(", ")}. Use --force to overwrite it.`,
      );
    }
  }

  const meta = pairMetadataSchema.parse(conversationToPairMetadata(conversation));
  if (isSourceParseSupported(conversation.source)) {
    await parseConversationMessages(options.config, conversation);
  }
  const rawContent = await readConversationRaw(conversation);

  await writePair({
    jsonlPath,
    metaPath,
    jsonl: rawContent,
    meta,
  });
}

async function buildParsedConversationExport(
  config: Config,
  conversation: ConversationMeta,
): Promise<ConversationExport> {
  const messages = await parseConversationMessages(config, conversation);
  return buildConversationExport(conversation, messages);
}

async function renderParsedMarkdown(
  config: Config,
  conversation: ConversationMeta,
): Promise<string> {
  const messages = await parseConversationMessages(config, conversation);
  return renderConversationMarkdown(conversation, messages);
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
  if (value === "json" || value === "md" || value === "pair") {
    return value;
  }
  throw new UsageError(`--format must be "json", "md", or "pair", got "${value}".`);
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
  return value === "unsaved" || value === "saved";
}
