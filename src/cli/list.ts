import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import {
  buildFullConversationGraphStatusMap,
  buildCurrentGraphRelationshipOverride,
  buildRelatedConversationView,
  composeConversationView,
  isInDefaultLiteralSearchScope,
  type FullConversationGraphStatus,
  type LocalScanSnapshot,
} from "../conversations/view.js";
import { gitOriginFilter, listConversations } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import type {
  RelatedConversationInput,
  RelatedConversationRelationshipOverride,
  RelationshipGraphWarning,
} from "../relationships/graph.js";
import { conversationIdentityKey } from "../relationships/graph.js";
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
import { scanLocalSources } from "./scan.js";
import { ClogError } from "../utils/errors.js";

export function buildListCommand(): Command {
  const command = new Command("list")
    .description("List conversations")
    .addHelpText(
      "after",
      "\nRelated branches collapse only for this read-only view. " +
        "Use --all-branches to inspect every branch and superseded generation; " +
        "commands that save, edit, drain, or remove conversations still act on concrete conversation IDs.\n",
    );

  command
    .option("-s, --state <state>", "Filter by state: saved or unsaved")
    .option("-p, --project <name>", "Filter by project")
    .option("-a, --author <name>", "Filter by author")
    .option("-t, --tag <tag>", "Filter by tag")
    .option("-g, --grep <text>", "Filter by text in title, summary, or content")
    .option("-c, --columns <cols>", "Comma-separated columns to display")
    .option("--origin <origin>", "Filter by origin: local or remote")
    .option("--all", "Include unsaved and ignored conversations, plus imported conversations from other authors")
    .option("--all-branches", "Show and search every branch and superseded generation")
    .action(async (options) => {
      const config = await loadConfig();
      const columns = parseColumnsOption(options.columns);
      const stateFilter = parseStateFilter(options.state);
      const scanResult = options.all || stateFilter === "unsaved"
        ? await scanLocalSources(config)
        : undefined;
      if (scanResult) {
        renderWarnings(getScanWarningsForCommand(scanResult));
      }
      const hasFilters = Boolean(
        options.state ||
          options.project ||
          options.author ||
          options.tag ||
          options.grep ||
          options.origin ||
          columns,
      );

      const authorName = config.author.trim();
      const fallbackToLocalOnly =
        !options.all && !options.origin && !options.author && authorName.length === 0;
      const originFilter = fallbackToLocalOnly ? "local" : parseOriginFilter(options.origin);

      // Default filter (no --all, no explicit --origin, no explicit --author):
      // curated-by-default — show local curated + this author's remote curated.
      const curatedDefault =
        !options.all && !options.origin && !options.author && authorName.length > 0
          ? { author: authorName }
          : null;

      const requestedStates: Array<"saved" | "unsaved"> | undefined = stateFilter
        ? [stateFilter]
        : options.all
          ? undefined
          : ["saved"];
      const composition = await composeConversationView({
        states: requestedStates,
        projectName: options.project,
        author: options.author,
        tag: options.tag,
        origin: originFilter,
        curatedDefault,
      }, scanResult);
      const relationshipComposition = await composeConversationView(
        { states: requestedStates },
        scanResult,
      );
      const fullGraphStatuses = buildFullConversationGraphStatusMap(
        relationshipComposition.graphUniverse,
        relationshipComposition.relationshipOverrides,
      );
      let conversations = composition.conversations;

      if (options.grep) {
        if (!options.allBranches && !options.all) {
          conversations = conversations.filter((conversation) =>
            isInDefaultLiteralSearchScope(conversation, fullGraphStatuses),
          );
        }
        conversations = await filterConversationsByGrep(
          config,
          options.grep,
          conversations,
        );
      }

      const concreteConversations = conversations;
      if (!options.all) {
        const relatedRows = buildRelatedConversationView(
          relationshipComposition.graphUniverse,
          conversations,
          {
            allBranches: options.allBranches,
            relationshipOverrides:
              relationshipComposition.relationshipOverrides,
          },
        );
        renderRelationshipWarnings(relatedRows.flatMap((row) => row.relationshipWarnings));
        const displayRows = relatedRows
          .map((related) => ({
            ...related.conversation,
            titleSuffix: options.allBranches
              ? expandedBranchNote(related, fullGraphStatuses)
              : collapsedBranchNote(related),
          }))
          .sort(compareDisplayRows);
        renderConversationTable(
          displayRows,
          {
            emptyMessage: hasFilters
              ? "No conversations found."
              : 'No saved conversations. Use "clog status" or "clog list --state unsaved".',
            stateLabelMode: true,
            columns,
          },
        );
        renderCollapsedBranchHint(relatedRows, options.allBranches);

        // Team conversation hint: if a remote is configured and there are
        // remote rows NOT included in the current view, surface the count.
        if (config.remote.url && !options.origin) {
          const allRemote = await listConversations({
            origin: gitOriginFilter(config.remote.url),
          });
          const shownIds = new Set(concreteConversations.map((c) => c.id));
          const hidden = allRemote.filter((c) => !shownIds.has(c.id)).length;
          if (hidden > 0) {
            process.stdout.write(
              `\n${hidden} team conversation(s) available (use \`clog list --all\` to include)\n`,
            );
          }
        }
      } else {
        const visibleIgnoredRows = discoverIgnoredDisplayRows(
          scanResult!,
          options,
        );
        const allIgnoredRows = discoverIgnoredDisplayRows(scanResult!, {});
        const mergedGraphRows = mergeRelatedDisplayRows([
          ...relationshipComposition.graphUniverse.map(conversationToDisplayRow),
          ...allIgnoredRows,
        ], relationshipComposition.relationshipOverrides);
        const visibleIdentityKeys = new Set(
          [
            ...conversations.map(conversationIdentityKey),
            ...visibleIgnoredRows.map(conversationIdentityKey),
          ],
        );
        const mergedGraphStatuses = buildFullConversationGraphStatusMap(
          mergedGraphRows.rows,
          mergedGraphRows.relationshipOverrides,
        );
        let visibleRows = mergedGraphRows.rows.filter((row) =>
          visibleIdentityKeys.has(conversationIdentityKey(row)),
        );
        if (options.grep && !options.allBranches) {
          visibleRows = visibleRows.filter((row) =>
            isInDefaultLiteralSearchScope(row, mergedGraphStatuses),
          );
        }
        const relatedRows = buildRelatedConversationView(
          mergedGraphRows.rows,
          visibleRows,
          {
            allBranches: options.allBranches,
            relationshipOverrides: mergedGraphRows.relationshipOverrides,
          },
        );
        renderRelationshipWarnings(relatedRows.flatMap((row) => row.relationshipWarnings));
        const displayRows = relatedRows
          .map((related) =>
            toDisplayRow(
              related,
              options.allBranches,
              mergedGraphStatuses,
            ))
          .sort(compareDisplayRows);

        renderDisplayTable(displayRows, {
          emptyMessage: "No conversations found.",
          stateLabelMode: true,
          columns,
        });
        renderCollapsedBranchHint(relatedRows, options.allBranches);
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

function discoverIgnoredDisplayRows(
  scanSnapshot: LocalScanSnapshot,
  options: {
    state?: string;
    project?: string;
    author?: string;
    tag?: string;
    grep?: string;
    origin?: string;
  },
): RelatedDisplayRow[] {
  if (options.state) {
    return [];
  }

  if (options.origin === "remote") {
    return [];
  }

  if (options.author || options.tag) {
    return [];
  }

  const rows: RelatedDisplayRow[] = [];

  for (const discovered of scanSnapshot.ignoredCandidates) {
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
        sourceId: discovered.sourceId,
        createdAt: discovered.metadata.createdAt,
        state: "ignored",
        source: discovered.source,
        sourceMtime: discovered.sourceMtime,
        originKind: "local",
        relationships: discovered.relationships,
        relationshipInspection: discovered.relationshipInspection,
        projectName: discovered.metadata.projectName,
        author: null,
        title: discovered.metadata.title,
        dim: true,
      });
  }

  return rows;
}

interface RelatedDisplayRow extends DisplayRow, RelatedConversationInput {
  relationshipInspection: ConversationMeta["relationshipInspection"];
}

function conversationToDisplayRow(
  conversation: ConversationMeta,
): RelatedDisplayRow {
  return {
    id: conversation.id,
    sourceId: conversation.sourceId,
    createdAt: conversation.createdAt,
    state: conversation.state,
    source: conversation.source,
    sourceMtime: conversation.sourceMtime,
    originKind: conversation.originKind,
    relationships: conversation.relationships,
    relationshipInspection: conversation.relationshipInspection,
    projectName: conversation.projectName,
    author: conversation.author,
    title: conversation.title,
  };
}

function mergeRelatedDisplayRows(
  rows: RelatedDisplayRow[],
  relationshipOverrides: readonly RelatedConversationRelationshipOverride[],
): {
  rows: RelatedDisplayRow[];
  relationshipOverrides: RelatedConversationRelationshipOverride[];
} {
  const rowsByIdentity = new Map<string, RelatedDisplayRow>();
  const overridesByIdentity = new Map(
    relationshipOverrides.map((override) => [
      conversationIdentityKey(override),
      override,
    ] as const),
  );

  for (const row of rows) {
    const key = conversationIdentityKey(row);
    const existing = rowsByIdentity.get(key);
    if (!existing) {
      rowsByIdentity.set(key, row);
      continue;
    }

    const saved = [existing, row].find(
      (candidate) =>
        candidate.state === "saved" && candidate.originKind === "local",
    );
    const ignored = [existing, row].find(
      (candidate) => candidate.state === "ignored",
    );
    if (saved && ignored) {
      const override = buildCurrentGraphRelationshipOverride(saved, ignored);
      if (override) {
        overridesByIdentity.set(key, override);
      }
      rowsByIdentity.set(key, {
        ...saved,
        sourceMtime: ignored.sourceMtime,
      });
      continue;
    }

    const ordered = [existing, row].sort(compareCanonicalDisplayRows);
    rowsByIdentity.set(key, ordered[0]!);
    overridesByIdentity.set(key, {
      source: ordered[0]!.source,
      sourceId: ordered[0]!.sourceId,
      relationships: ordered.flatMap((candidate) => candidate.relationships),
    });
  }

  return {
    rows: [...rowsByIdentity.values()].sort(compareDisplayRows),
    relationshipOverrides: [...overridesByIdentity.values()],
  };
}

function compareCanonicalDisplayRows(
  left: RelatedDisplayRow,
  right: RelatedDisplayRow,
): number {
  return (
    displayStatePriority(left.state) - displayStatePriority(right.state) ||
    JSON.stringify(left).localeCompare(JSON.stringify(right))
  );
}

function displayStatePriority(state: string): number {
  if (state === "saved") return 0;
  if (state === "unsaved") return 1;
  if (state === "ignored") return 2;
  return 3;
}

function toDisplayRow(
  related: ReturnType<typeof buildRelatedConversationView<RelatedDisplayRow>>[number],
  allBranches: boolean | undefined,
  fullGraphStatuses: ReadonlyMap<string, FullConversationGraphStatus>,
): DisplayRow {
  const conversation = related.conversation;
  return {
    ...conversation,
    titleSuffix: allBranches
      ? expandedBranchNote(related, fullGraphStatuses)
      : collapsedBranchNote(related),
  };
}

function expandedBranchNote(
  related: ReturnType<typeof buildRelatedConversationView<RelatedDisplayRow>>[number],
  fullGraphStatuses: ReadonlyMap<string, FullConversationGraphStatus>,
): string | undefined {
  const status = fullGraphStatuses.get(
    conversationIdentityKey(related.conversation),
  );
  return status?.branchStatus === "superseded"
    ? "[superseded]"
    : parentNote(related.immediateParentIdentity);
}

function collapsedBranchNote(
  related: {
    endpointCount: number;
    relationshipCompleteness: "complete" | "incomplete" | "invalid";
  },
): string | undefined {
  const branchLabel =
    related.endpointCount >= 2 ? `${related.endpointCount} branches` : null;
  const incompleteLabel =
    related.relationshipCompleteness === "incomplete"
      ? "incomplete branch history"
      : null;
  const labels = [branchLabel, incompleteLabel].filter(Boolean);
  return labels.length > 0 ? `[${labels.join("; ")}]` : undefined;
}

function renderCollapsedBranchHint(
  rows: Array<{ endpointCount: number }>,
  allBranches: boolean | undefined,
): void {
  if (allBranches || !rows.some((row) => row.endpointCount >= 2)) {
    return;
  }

  process.stdout.write(
    "\nConversations marked with a branch count show the most recently updated branch. " +
      "Use 'clog list --all-branches' to show every branch and superseded generation.\n",
  );
}

function parentNote(
  parent: { sourceId: string } | null,
): string | undefined {
  return parent ? `[parent ${parent.sourceId.slice(0, 8)}]` : undefined;
}

function renderRelationshipWarnings(
  warnings: RelationshipGraphWarning[],
): void {
  const unique = new Map<string, RelationshipGraphWarning>();
  for (const warning of warnings) {
    unique.set(JSON.stringify(warning), warning);
  }
  renderWarnings([...unique.values()].map(toClogWarning));
}

function toClogWarning(warning: RelationshipGraphWarning): ClogWarning {
  if (warning.code === "conversation_relationship_cycle") {
    return {
      code: warning.code,
      message:
        `Branch metadata contains a cycle involving ${formatRelationshipIdentities(warning.conversations)}.`,
      guidance: "Run 'clog list --all-branches' to inspect every affected conversation.",
      relatedUuids: warning.conversations.map((conversation) => conversation.sourceId),
    };
  }
  if (warning.code === "conversation_relationship_observation_conflict") {
    return {
      code: warning.code,
      message:
        `A saved conversation and its current source file report conflicting branch metadata${formatObservedParents(warning.parents)}. Clog did not choose one version.`,
      guidance:
        "Inspect the saved conversation's branch metadata and its current source file before saving the conversation again.",
      conversation: {
        id: warning.conversation.sourceId,
        source: warning.conversation.source,
      },
      relatedUuids: warning.parents.map((parent) => parent.sourceId),
    };
  }
  if (warning.code === "conversation_relationship_parent_conflict") {
    return {
      code: warning.code,
      message:
        `A conversation has conflicting branch parents: ${formatRelationshipIdentities(warning.parents)}. Clog did not choose one parent.`,
      guidance:
        "Inspect the conversation's branch metadata in its source file before saving the conversation again.",
      conversation: {
        id: warning.conversation.sourceId,
        source: warning.conversation.source,
      },
      relatedUuids: warning.parents.map((parent) => parent.sourceId),
    };
  }
  return {
    code: warning.code,
    message:
      "A conversation identifies itself as its branch parent. Clog ignored the invalid parent relationship.",
    guidance:
      "Inspect the conversation's branch metadata in its source file before saving the conversation again.",
    conversation: {
      id: warning.conversation.sourceId,
      source: warning.conversation.source,
    },
  };
}

function formatObservedParents(
  parents: ReadonlyArray<{ source: string; sourceId: string }>,
): string {
  return parents.length > 0
    ? ` (observed parents: ${formatRelationshipIdentities(parents)})`
    : "";
}

function formatRelationshipIdentities(
  identities: ReadonlyArray<{ source: string; sourceId: string }>,
): string {
  const visible = identities
    .slice(0, 3)
    .map((identity) => `${identity.sourceId.slice(0, 8)}@${identity.source}`);
  const remaining = identities.length - visible.length;
  return remaining > 0
    ? `${visible.join(", ")}, and ${remaining} more`
    : visible.join(", ");
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

function parseStateFilter(value?: string): "unsaved" | "saved" | undefined {
  if (!value) return undefined;
  const normalized = value.trim().toLowerCase();
  if (normalized === "unsaved" || normalized === "saved") {
    return normalized;
  }
  throw new ClogError(`--state must be "unsaved" or "saved", got "${value}".`);
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
