import chalk from "chalk";
import { Command } from "commander";

import { getEnabledAdapters } from "../adapters/registry.js";
import { loadConfig } from "../config/index.js";
import { listConversations } from "../db/index.js";
import { checkStaleness } from "../sync/staleness.js";
import {
  conversationMetadataMatchesGrep,
  filterConversationsByGrep,
  getScanWarningsForCommand,
  renderConversationTable,
  renderDisplayTable,
  renderWarnings,
  type DisplayColumnKey,
  type DisplayRow,
} from "./common.js";
import type { Config } from "../config/schema.js";
import { scanLocalSources } from "./scan.js";
import {
  conversationMatchesAnyClogIgnoreRule,
  pathMatchesBoundary,
  readClogIgnoreRules,
} from "./clogignore.js";
import { ClogError } from "../utils/errors.js";

export function buildListCommand(): Command {
  const command = new Command("list").description("List conversations");

  command
    .option("-s, --state <state>")
    .option("-p, --project <name>")
    .option("-a, --author <name>")
    .option("-t, --tag <tag>")
    .option("-g, --grep <text>")
    .option("-c, --columns <cols>")
    .option("--origin <origin>", "local or remote")
    .option("--all")
    .action(async (options) => {
      const config = await loadConfig();
      const scanResult = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanResult));
      const columns = parseColumnsOption(options.columns);
      const hasFilters = Boolean(
        options.state ||
          options.project ||
          options.author ||
          options.tag ||
          options.grep ||
          options.origin ||
          columns,
      );

      const originFilter = parseOriginFilter(options.origin);

      // Default filter (no --all, no explicit --origin, no explicit --author):
      // curated-by-default — show local curated + this author's remote curated.
      const curatedDefault =
        !options.all && !options.origin && !options.author && config.author.trim().length > 0
          ? { author: config.author.trim() }
          : null;

      let conversations = await listConversations({
        states: options.state
          ? [options.state]
          : options.all
            ? undefined
            : ["staged", "saved"],
        projectName: options.project,
        author: options.author,
        tag: options.tag,
        origin: originFilter,
        curatedDefault,
      });

      if (options.grep) {
        conversations = await filterConversationsByGrep(config, options.grep, conversations);
      }

      if (!options.all) {
        renderConversationTable(conversations, {
          emptyMessage: hasFilters
            ? "No conversations found."
            : 'No staged or saved conversations. Use "clog status" or "clog list --state discovered".',
          stateLabelMode: true,
          columns,
        });

        // Team conversation hint: if a remote is configured and there are
        // remote rows NOT included in the current view, surface the count.
        if (config.remote.url && !options.origin) {
          const allRemote = await listConversations({ origin: "remote" });
          const shownIds = new Set(conversations.map((c) => c.id));
          const hidden = allRemote.filter((c) => !shownIds.has(c.id)).length;
          if (hidden > 0) {
            process.stdout.write(
              `\n${hidden} team conversation(s) available (use \`clog list --all\` to include)\n`,
            );
          }
        }
      } else {
        const ignoredRows = await discoverIgnoredDisplayRows(config, options);
        const displayRows: DisplayRow[] = [
          ...conversations.map((conversation) => ({
            id: conversation.id,
            createdAt: conversation.createdAt,
            state: conversation.state,
            source: conversation.source,
            projectName: conversation.projectName,
            author: conversation.author,
            title: conversation.title,
          })),
          ...ignoredRows,
        ].sort(compareDisplayRows);

        renderDisplayTable(displayRows, {
          emptyMessage: "No conversations found.",
          stateLabelMode: true,
          columns,
        });
      }

      if (config.remote.url) {
        const staleness = await checkStaleness();
        if (staleness.kind === "stale") {
          process.stdout.write(
            `\n${chalk.yellow(
              "Warning: remote checkout has changed outside of clog. Run `clog refresh` to reconcile.",
            )}\n`,
          );
        }
      }
    });

  return command;
}

async function discoverIgnoredDisplayRows(
  config: Config,
  options: {
    state?: string;
    project?: string;
    author?: string;
    tag?: string;
    grep?: string;
    origin?: string;
  },
): Promise<DisplayRow[]> {
  if (options.state) {
    return [];
  }

  if (options.origin === "remote") {
    return [];
  }

  if (options.author || options.tag) {
    return [];
  }

  const clogIgnoreRules = await readClogIgnoreRules();

  const rows: DisplayRow[] = [];

  for (const adapter of getEnabledAdapters(config)) {
    for await (const discovered of adapter.discover()) {
      if (!discovered.metadata.projectPath) {
        continue;
      }

      if (!passesConfigPathFilters(adapter.name, config, discovered.metadata.projectPath)) {
        continue;
      }

      if (!conversationMatchesAnyClogIgnoreRule({
        sourceId: discovered.sourceId,
        projectName: discovered.metadata.projectName,
        projectPath: discovered.metadata.projectPath,
        sourcePath: discovered.sourcePath,
      }, clogIgnoreRules)) {
        continue;
      }

      if (
        options.project &&
        discovered.metadata.projectName?.toLowerCase() !== options.project.toLowerCase()
      ) {
        continue;
      }

      if (
        options.grep &&
        !conversationMetadataMatchesGrep(
          {
            title: discovered.metadata.title,
            summary: discovered.metadata.summary,
          },
          options.grep.toLowerCase(),
        )
      ) {
        continue;
      }

      rows.push({
        id: discovered.sourceId,
        createdAt: discovered.metadata.createdAt,
        state: "ignored",
        source: adapter.name,
        projectName: discovered.metadata.projectName,
        author: null,
        title: discovered.metadata.title,
        dim: true,
      });
    }
  }

  return rows;
}

function passesConfigPathFilters(source: string, config: Config, projectPath: string): boolean {
  const sourceConfig = config.sources[source as keyof Config["sources"]];

  if (!sourceConfig) {
    return true;
  }

  if (
    sourceConfig.includePaths.length > 0 &&
    !sourceConfig.includePaths.some((entry) => pathMatchesBoundary(projectPath, entry))
  ) {
    return false;
  }

  if (sourceConfig.excludePaths.some((entry) => pathMatchesBoundary(projectPath, entry))) {
    return false;
  }

  return true;
}

function compareDisplayRows(left: DisplayRow, right: DisplayRow): number {
  if (left.createdAt !== right.createdAt) {
    return right.createdAt.localeCompare(left.createdAt);
  }

  return left.id.localeCompare(right.id);
}

function parseOriginFilter(value?: string): "local" | "remote" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "local") return "local";
  if (normalized === "remote") return "remote";
  throw new ClogError(`--origin must be "local" or "remote", got "${value}".`);
}

function parseColumnsOption(value?: string): DisplayColumnKey[] | undefined {
  if (!value) {
    return undefined;
  }

  const requested = value
    .split(",")
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (requested.length === 0) {
    throw new ClogError("Columns list cannot be empty.");
  }

  if (requested.includes("all")) {
    return ["id", "date", "state", "source", "project", "author", "title"];
  }

  const allowed = new Set<DisplayColumnKey>([
    "id",
    "date",
    "state",
    "source",
    "project",
    "author",
    "title",
  ]);

  for (const column of requested) {
    if (!allowed.has(column as DisplayColumnKey)) {
      throw new ClogError(`Unknown column "${column}".`);
    }
  }

  return [...new Set(requested)] as DisplayColumnKey[];
}
