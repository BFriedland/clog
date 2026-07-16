import fs from "node:fs/promises";
import path from "node:path";

import { Command, Option } from "commander";

import { isSourceParseSupported } from "../adapters/registry.js";
import { loadConfig } from "../config/index.js";
import type { Config } from "../config/schema.js";
import { listConversations } from "../db/index.js";
import {
  createDeterministicPairArchive,
  validateArchiveEntryName,
  validateArchivePathComponent,
} from "../interchange/archive.js";
import {
  conversationToPairMetadata,
  pairMetadataSchema,
  writePair,
} from "../interchange/pairs.js";
import type { ConversationMeta } from "../models/conversation.js";
import { publishArchiveAtomic, assertArchivePublicationDestination } from "../utils/archive-publication.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { pathExists } from "../utils/fs.js";
import { withPrivateTempDirectory } from "../utils/private-temp.js";
import {
  confirm,
  getScanWarningsForCommand,
  parseConversationMessages,
  renderWarnings,
} from "./common.js";
import { readConversationRaw } from "./conversation-renderers.js";
import { collectProjectDrainTargets } from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";

type DrainFormat = "archive" | "pair";

interface DrainOptions {
  output?: string;
  format?: string;
  force?: boolean;
  includeImported?: boolean;
  yes?: boolean;
  refresh?: boolean;
  showAllErrors?: boolean;
  state?: string;
  project?: string;
  author?: string;
  tag?: string;
  origin?: string;
  to?: string;
  toDir?: string;
  raw?: boolean;
}

interface DrainResults {
  succeeded: number;
  failed: number;
  skippedUnsaved: number;
}

export function buildDrainCommand(): Command {
  return new Command("drain")
    .description("Export saved conversations as a zip archive or unpacked pair files")
    .argument("[selectors...]", "Conversation IDs or project selectors to export")
    .option("-o, --output <path>", "Archive file or unpacked pair-directory destination")
    .option("-f, --format <fmt>", "Output format: archive or pair", "archive")
    .option("--force", "Replace eligible existing output")
    .option(
      "--include-imported",
      "Include imported conversations when no selector or filter is supplied",
    )
    .option(
      "--yes",
      "Export saved local conversations without prompting when no selector or filter is supplied",
    )
    .option("--refresh", "Refresh local discovery before resolving the export set")
    .option("--show-all-errors", "Show every per-conversation export failure")
    .option("-p, --project <name>", "Exact project metadata filter")
    .option("-a, --author <name>", "Exact author metadata filter")
    .option("-t, --tag <tag>", "Exact tag metadata filter")
    .option("--origin <origin>", "Exact origin filter: local or remote")
    .addOption(new Option("--to <path>").hideHelp())
    .addOption(new Option("--to-dir <dir>").hideHelp())
    .addOption(new Option("--raw").hideHelp())
    .addOption(new Option("-s, --state <state>").hideHelp())
    .action(async (selectors: string[], options: DrainOptions) => {
      await runDrainCommand(selectors, options);
    });
}

async function runDrainCommand(
  selectors: string[],
  options: DrainOptions,
): Promise<void> {
  validateRemovedOptions(selectors, options);
  const format = parseFormat(options.format);
  validateDrainOptions(selectors, options, format);
  const bare = isBareDrain(selectors, options);

  if (bare && !options.yes && !process.stdin.isTTY) {
    throw new UsageError(
      "Bare clog drain requires confirmation. Add a conversation or project selector, add a selection filter, or use --yes.",
    );
  }

  const config = await loadConfig();
  if (options.refresh) {
    const scanResult = await scanLocalSources(config);
    renderWarnings(getScanWarningsForCommand(scanResult));
  }

  const resolved = await resolveDrainConversations(selectors, options, {
    bare,
  });
  if (resolved.conversations.length === 0) {
    if (resolved.skippedUnsaved > 0) {
      throw new ClogError(
        `No saved conversations to export. ${resolved.skippedUnsaved} matching conversation${
          resolved.skippedUnsaved === 1 ? " is" : "s are"
        } unsaved; save ${
          resolved.skippedUnsaved === 1 ? "it" : "them"
        } first with 'clog save', then retry.`,
      );
    }

    if (selectors.length > 0 && hasFilterOptions(options)) {
      throw new ClogError(
        "No conversations match the requested export. The supplied ID(s) and filter(s) did not overlap.",
      );
    }

    throw new ClogError(
      "No conversations match the requested export. Try 'clog list' with the same filters to inspect the current set.",
    );
  }

  const destination = format === "pair"
    ? options.output!
    : options.output ?? "./clog-export.zip";

  if (bare) {
    if (format === "pair") {
      await assertPairDestinationBeforeConfirmation(destination);
    } else {
      await assertArchivePublicationDestination(destination, {
        force: options.force === true,
      });
    }

    if (!options.yes) {
      const accepted = await confirm(
        `Export ${resolved.conversations.length} saved local conversation${
          resolved.conversations.length === 1 ? "" : "s"
        } to ${destination}?`,
      );
      if (!accepted) {
        process.stdout.write("Operation cancelled.\n");
        return;
      }
    }
  }

  if (format === "pair") {
    await drainPairsToDirectory(resolved.conversations, {
      config,
      force: options.force === true,
      targetDir: destination,
      skippedUnsaved: resolved.skippedUnsaved,
      showAllErrors: options.showAllErrors === true,
    });
    return;
  }

  await drainToArchive(resolved.conversations, {
    config,
    destination,
    force: options.force === true,
    skippedUnsaved: resolved.skippedUnsaved,
    showAllErrors: options.showAllErrors === true,
  });
}

function validateRemovedOptions(
  selectors: string[],
  options: DrainOptions,
): void {
  if (options.to != null || options.toDir != null) {
    throw new UsageError(
      "--to and --to-dir were removed from clog drain. Use -o, --output <path> instead.",
    );
  }
  if (options.raw) {
    throw new UsageError(
      "--raw was removed from clog drain. Use 'clog show <id> --raw' instead.",
    );
  }
  if (options.state != null) {
    const state = options.state.trim().toLowerCase();
    if (state === "saved") {
      if (selectors.length > 0 || hasFilterOptions(options)) {
        throw new UsageError(
          "--state was removed from clog drain. Remove --state; clog drain already exports only saved conversations from an explicit selection.",
        );
      }
      throw new UsageError(
        "--state was removed from clog drain. Use --include-imported to export all saved local and imported conversations.",
      );
    }
    if (state === "unsaved") {
      throw new UsageError(
        "--state was removed from clog drain. clog drain exports saved conversations only.",
      );
    }
    throw new UsageError(
      "--state was removed from clog drain. Remove it and select conversations by ID, project, or a supported filter.",
    );
  }
}

function validateDrainOptions(
  selectors: string[],
  options: DrainOptions,
  format: DrainFormat,
): void {
  if (format === "pair" && options.output == null) {
    throw new UsageError("--format pair requires -o <dir>.");
  }

  if (options.output != null && options.output.trim().length === 0) {
    throw new UsageError("--output cannot be empty.");
  }

  parseOriginFilter(options.origin);
  for (const [flag, value] of [
    ["--project", options.project],
    ["--author", options.author],
    ["--tag", options.tag],
  ] as const) {
    if (value != null && value.trim().length === 0) {
      throw new UsageError(`${flag} cannot be empty.`);
    }
  }

  if (
    options.includeImported &&
    (selectors.length > 0 || hasFilterOptions(options))
  ) {
    throw new UsageError(
      "--include-imported cannot be combined with a conversation or project selector or a selection filter.",
    );
  }
}

interface ResolvedDrainConversations {
  conversations: ConversationMeta[];
  skippedUnsaved: number;
}

async function resolveDrainConversations(
  selectors: string[],
  options: DrainOptions,
  context: { bare: boolean },
): Promise<ResolvedDrainConversations> {
  if (context.bare || options.includeImported) {
    const origin = context.bare ? ("local" as const) : undefined;
    const conversations = await listConversations({ states: ["saved"], origin });
    const unsaved = await listConversations({ states: ["unsaved"], origin });
    return {
      conversations: dedupeAndSortConversations(conversations),
      skippedUnsaved: unsaved.length,
    };
  }

  const hasFilters = hasFilterOptions(options);
  const filteredConversations = hasFilters
    ? await listConversations({
        projectName: trimmed(options.project),
        author: trimmed(options.author),
        tag: trimmed(options.tag),
        origin: parseOriginFilter(options.origin),
      })
    : null;

  const droppedUnsaved = new Set<string>();
  const projectSelectionFilter = (conversation: ConversationMeta): boolean => {
    if (conversation.state !== "saved") {
      droppedUnsaved.add(conversation.id);
      return false;
    }
    return true;
  };

  const explicitConversations = selectors.length > 0
    ? resolveConversationSelectors({
        commandName: "clog drain",
        tokens: selectors,
        idCandidates: filteredConversations ?? (await listConversations()),
        projectCandidates: await collectProjectDrainTargets(filteredConversations),
        projectSelectionFilter,
      })
    : null;

  let conversations = explicitConversations ?? filteredConversations ?? [];
  if (!explicitConversations) {
    for (const conversation of conversations) {
      if (conversation.state !== "saved") {
        droppedUnsaved.add(conversation.id);
      }
    }
    conversations = conversations.filter((conversation) => conversation.state === "saved");
  }

  const deduped = dedupeAndSortConversations(conversations);
  const keptIds = new Set(deduped.map((conversation) => conversation.id));
  const skippedUnsaved = [...droppedUnsaved].filter((id) => !keptIds.has(id)).length;
  return { conversations: deduped, skippedUnsaved };
}

async function assertPairDestinationBeforeConfirmation(
  targetDir: string,
): Promise<void> {
  let destinationStat;
  try {
    destinationStat = await fs.stat(targetDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return;
    }
    throw new ClogError(
      `Could not inspect pair export destination ${targetDir}: ${formatError(error)}`,
    );
  }

  if (!destinationStat.isDirectory()) {
    throw new ClogError(
      `Pair export destination is not a directory: ${targetDir}`,
    );
  }
}

async function drainPairsToDirectory(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    force: boolean;
    targetDir: string;
    skippedUnsaved: number;
    showAllErrors: boolean;
  },
): Promise<void> {
  try {
    await fs.mkdir(options.targetDir, { recursive: true });
  } catch (error) {
    throw new ClogError(
      `Could not create pair export directory ${options.targetDir}: ${formatError(error)}`,
    );
  }

  const results: DrainResults = {
    succeeded: 0,
    failed: 0,
    skippedUnsaved: options.skippedUnsaved,
  };

  for (const conversation of conversations) {
    try {
      await writeConversationPair(conversation, options);
      results.succeeded += 1;
    } catch (error) {
      results.failed += 1;
      reportConversationFailure(
        conversation,
        error,
        results.failed,
        options.showAllErrors,
      );
    }
  }

  reportCollapsedConversationFailures(results.failed, options.showAllErrors);
  reportDrainSummary(results, options.targetDir, true);
}

async function drainToArchive(
  conversations: ConversationMeta[],
  options: {
    config: Config;
    destination: string;
    force: boolean;
    skippedUnsaved: number;
    showAllErrors: boolean;
  },
): Promise<void> {
  await assertArchivePublicationDestination(options.destination, {
    force: options.force,
  });

  const results: DrainResults = {
    succeeded: 0,
    failed: 0,
    skippedUnsaved: options.skippedUnsaved,
  };
  const nameValid: ConversationMeta[] = [];

  for (const conversation of conversations) {
    try {
      validateProspectiveArchiveNames(conversation);
      nameValid.push(conversation);
    } catch (error) {
      results.failed += 1;
      reportConversationFailure(
        conversation,
        error,
        results.failed,
        options.showAllErrors,
      );
    }
  }

  await withPrivateTempDirectory(async (stagingRoot) => {
    for (const conversation of nameValid) {
      try {
        await assertNoArchiveStagingCollision(conversation, stagingRoot);
        await writeConversationPair(conversation, {
          config: options.config,
          force: false,
          targetDir: stagingRoot,
          mode: 0o600,
        });
        results.succeeded += 1;
      } catch (error) {
        results.failed += 1;
        reportConversationFailure(
          conversation,
          protectPrivateStagingError(error, stagingRoot),
          results.failed,
          options.showAllErrors,
        );
      }
    }

    if (results.failed > 0) {
      reportCollapsedConversationFailures(results.failed, options.showAllErrors);
      reportDrainSummary(
        { ...results, succeeded: 0 },
        options.destination,
        false,
      );
      return;
    }

    const archive = await createDeterministicPairArchive(stagingRoot);
    await publishArchiveAtomic(options.destination, archive, {
      force: options.force,
    });
    reportDrainSummary(results, options.destination, false);
  });
}

function validateProspectiveArchiveNames(conversation: ConversationMeta): void {
  validateArchivePathComponent(conversation.source);
  validateArchivePathComponent(conversation.id);
  validateArchiveEntryName(`${conversation.source}/${conversation.id}.jsonl`);
  validateArchiveEntryName(`${conversation.source}/${conversation.id}.meta.json`);
}

async function assertNoArchiveStagingCollision(
  conversation: ConversationMeta,
  stagingRoot: string,
): Promise<void> {
  // Built-in local source IDs usually come from filenames that already survived
  // the user's filesystem rules. This guard is for saved rows that came from
  // another filesystem, import path, manual DB change, or future source whose
  // exact `(source, id)` values are unique in SQLite but collide when staged as
  // archive entry paths on the current filesystem.
  for (const suffix of [".jsonl", ".meta.json"] as const) {
    const entryName = `${conversation.source}/${conversation.id}${suffix}`;
    const physicalPath = path.join(stagingRoot, ...entryName.split("/"));
    if (await pathExists(physicalPath)) {
      throw new ClogError(
        `Archive entry ${entryName} collides with another selected conversation on this filesystem. No archive was written. Export the colliding conversations separately or remove one of the saved rows; --force cannot resolve collisions inside one archive export.`,
      );
    }
  }
}

async function writeConversationPair(
  conversation: ConversationMeta,
  options: {
    config: Config;
    force: boolean;
    targetDir: string;
    mode?: number;
  },
): Promise<void> {
  if (conversation.state !== "saved") {
    throw new ClogError(
      "Pair export requires saved conversations. Save this conversation before exporting it.",
    );
  }

  const sourceDir = path.join(options.targetDir, conversation.source);
  const jsonlPath = path.join(sourceDir, `${conversation.id}.jsonl`);
  const metaPath = path.join(sourceDir, `${conversation.id}.meta.json`);

  if (!options.force) {
    const conflicts: string[] = [];
    if (await pathExists(jsonlPath)) conflicts.push(jsonlPath);
    if (await pathExists(metaPath)) conflicts.push(metaPath);
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
    mode: options.mode,
  });
}

function reportConversationFailure(
  conversation: ConversationMeta,
  error: unknown,
  failureCount: number,
  showAllErrors: boolean,
): void {
  if (failureCount > 1 && !showAllErrors) {
    return;
  }

  process.stderr.write(
    `error: Could not export ${conversation.id.slice(0, 8)}@${conversation.source}: ${formatError(error)}\n`,
  );
}

function reportCollapsedConversationFailures(
  failed: number,
  showAllErrors: boolean,
): void {
  if (failed <= 1 || showAllErrors) {
    return;
  }

  process.stderr.write(
    `error: ${failed} conversations could not be exported; only the first failure is shown. Re-run with --show-all-errors to list every failure.\n`,
  );
}

function reportDrainSummary(
  results: DrainResults,
  destination: string,
  directory: boolean,
): void {
  const displayedDestination = directory && !destination.endsWith(path.sep)
    ? `${destination}${path.sep}`
    : destination;
  const notes: string[] = [];
  if (results.failed > 0) notes.push(`${results.failed} failed`);
  if (results.skippedUnsaved > 0) {
    notes.push(`${results.skippedUnsaved} unsaved skipped`);
  }
  const note = notes.length > 0 ? ` (${notes.join(", ")})` : "";
  process.stderr.write(
    `Exported ${results.succeeded} conversation${results.succeeded === 1 ? "" : "s"} to ${displayedDestination}${note}\n`,
  );
  if (results.failed > 0) {
    process.exitCode = 1;
  }
}

function parseFormat(value?: string): DrainFormat {
  if (value == null || value === "archive") return "archive";
  if (value === "pair") return "pair";
  if (value === "json" || value === "md") {
    throw new UsageError(
      `--format ${value} was removed from clog drain. Use 'clog show <id> --${value}' instead.`,
    );
  }
  throw new UsageError(
    `--format must be "archive" or "pair", got "${value}".`,
  );
}

function parseOriginFilter(value?: string): "local" | "remote" | undefined {
  if (value == null) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "local" || normalized === "remote") return normalized;
  throw new UsageError(`--origin must be "local" or "remote", got "${value}".`);
}

function hasFilterOptions(options: DrainOptions): boolean {
  return (
    options.project !== undefined ||
    options.author !== undefined ||
    options.tag !== undefined ||
    options.origin !== undefined
  );
}

function isBareDrain(selectors: string[], options: DrainOptions): boolean {
  return (
    selectors.length === 0 &&
    !hasFilterOptions(options) &&
    !options.includeImported
  );
}

function trimmed(value?: string): string | undefined {
  return value == null ? undefined : value.trim();
}

function dedupeAndSortConversations(
  conversations: ConversationMeta[],
): ConversationMeta[] {
  const seen = new Set<string>();
  const deduped: ConversationMeta[] = [];
  for (const conversation of conversations) {
    if (seen.has(conversation.id)) continue;
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

function protectPrivateStagingError(error: unknown, stagingRoot: string): unknown {
  if (error instanceof Error && error.message.includes(stagingRoot)) {
    return new ClogError("Could not write the private staged conversation pair.");
  }
  return error;
}

function formatError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
