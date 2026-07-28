import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import {
  classifyInstalledRelationshipInspectionVersion,
  classifyInstalledTranscriptProjectionVersion,
  getAdapter,
} from "../adapters/registry.js";
import {
  attachCurrentSourceCandidate,
  attachCurrentRelationshipInspection,
  findScanCandidateForConversation,
  isSourceDiscoveryComplete,
  listConversationView,
  resolveConversationView,
  type LocalScanSnapshot,
} from "../conversations/view.js";
import {
  insertFirstSavedConversation,
  listConversations,
  saveLocalConversation,
} from "../db/index.js";
import {
  isUnsummarized,
  preserveConfirmedRelationship,
  type ConversationMeta,
  type SavedConversationMeta,
} from "../models/conversation.js";
import {
  listIndexEligibleConversationsNeedingIndex,
  maybeAutoIndexConversations,
} from "../search/coherence.js";
import { searchAvailable } from "../search/deps.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { parseSourceQualifiedId } from "../utils/source-keys.js";
import { nowIso } from "../utils/time.js";
import {
  assertNoneRemote,
  confirm,
  defaultSaveFilePath,
  ensureRawCopy,
  getScanWarningsForCommand,
  getSaveCandidate,
  isLikelyRestoredLocalConversation,
  pathsIdentifySameManagedCopy,
  parseConversationTranscriptFromPath,
  renderWarnings,
} from "./common.js";
import {
  collectAllSaveTargets,
  collectBareSaveTargets,
  collectProjectSaveTargets,
} from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";
import { normalizeTags } from "./tag.js";

export function buildSaveCommand(): Command {
  return new Command("save")
    .description("Save conversations")
    .argument("[selectors...]", "Conversation IDs or project names to save")
    .option("--all", "Save all unsaved conversations and saved pending changes")
    .action(async (selectors: string[], options: { all?: boolean }) => {
      if (options.all && selectors.length > 0) {
        throw new UsageError(
          "Cannot combine --all with selectors. Use either 'clog save --all' or 'clog save <selector...>'.",
        );
      }

      const config = await loadConfig();
      const scanResult = options.all || selectors.length > 0
        ? await scanLocalSources(config)
        : undefined;
      if (scanResult) {
        renderWarnings(getScanWarningsForCommand(scanResult));
      }

      const selection = options.all
        ? {
            conversations: await collectAllSaveTargets(scanResult!),
            directSavedIds: new Set<string>(),
          }
        : selectors.length > 0
          ? await resolveSaveSelectors(selectors, scanResult!)
          : {
              conversations: await collectBareSaveTargets(),
              directSavedIds: new Set<string>(),
            };
      const { conversations, directSavedIds } = selection;

      if (conversations.length === 0) {
        process.stdout.write('No conversations need saving. Use "clog save <id>" or "clog save <project>" to save unsaved conversations.\n');
        await maybePrintUnindexedHint(config);
        return;
      }

      assertNoneRemote(conversations, "clog save");

      const savedConversations: ConversationMeta[] = [];
      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, originalConversation] of conversations.entries()) {
        const liveCandidate = scanResult
          ? findScanCandidateForConversation(originalConversation, scanResult)
          : undefined;
        const sourceCurrentConversation = scanResult
          ? {
              ...attachCurrentSourceCandidate(
                originalConversation,
                scanResult,
              ),
              ...(liveCandidate
                ? { createdAt: liveCandidate.metadata.createdAt }
                : {}),
            }
          : originalConversation;
        const conversation = attachCurrentRelationshipInspection(
          sourceCurrentConversation,
          liveCandidate,
        );

        if (
          conversation.state === "saved" &&
          directSavedIds.has(conversation.id) &&
          liveCandidate == null
        ) {
          throwDirectSavedSourceUnavailable(conversation, scanResult!);
        }

        if (
          conversation.state === "saved" &&
          (
            classifyInstalledTranscriptProjectionVersion(
              conversation.source,
              conversation.transcriptProjectionVersion,
            ) === "version_skew" ||
            classifyInstalledRelationshipInspectionVersion(
              conversation.source,
              conversation.relationshipInspection.version,
            ) === "version_skew"
          )
        ) {
          throw new ClogError(
            `Conversation ${conversation.id.slice(0, 8)} was saved by a newer clog version. Upgrade clog before refreshing it.`,
          );
        }

        if (conversation.state === "unsaved") {
          const rawPath = defaultSaveFilePath(conversation);
          const saved = await insertFirstSavedConversation(
            conversation,
            async (): Promise<SavedConversationMeta> => {
              await ensureRawCopy(conversation);
              const transcript = await parseConversationTranscriptFromPath(
                config,
                conversation.source,
                rawPath,
              );
              const timestamp = nowIso();
              return {
                ...conversation,
                author: config.author,
                tags: normalizeTags(config.defaultTags),
                discoveredAt: timestamp,
                filePath: rawPath,
                state: "saved",
                saveVersion: 1,
                savedAt: timestamp,
                modifiedAt: timestamp,
                savedMessageCount: transcript.messages.length,
                transcriptProjectionVersion:
                  transcript.transcriptProjectionVersion,
                indexedAt: null,
              };
            },
          );
          savedConversations.push(saved);
        } else {
          const candidate = liveCandidate === undefined
            ? await getSaveCandidate(conversation)
            : await getSaveCandidate(conversation, liveCandidate);
          const relationshipCurrentConversation =
            await reinspectSavedRelationshipsIfNeeded(
              conversation,
              candidate.path,
              config,
            );
          const rawPath =
            !relationshipCurrentConversation.filePath
              ? defaultSaveFilePath(relationshipCurrentConversation)
              : relationshipCurrentConversation.filePath;

          if (
            !(await confirmRestoredOverwriteIfNeeded(
              relationshipCurrentConversation,
              candidate,
            ))
          ) {
            continue;
          }

          if (candidate.shouldRefreshRawCopy) {
            await ensureRawCopy(relationshipCurrentConversation);
          }

          const parsePath = candidate.shouldRefreshRawCopy ? rawPath : candidate.path;
          const transcript = await parseConversationTranscriptFromPath(
            config,
            conversation.source,
            parsePath,
          );
          const timestamp = nowIso();
          const savedConversation: SavedConversationMeta = {
            ...relationshipCurrentConversation,
            filePath: rawPath,
            saveVersion: relationshipCurrentConversation.saveVersion + 1,
            savedAt: timestamp,
            modifiedAt: timestamp,
            savedMessageCount: transcript.messages.length,
            transcriptProjectionVersion:
              transcript.transcriptProjectionVersion,
            indexedAt: null,
          };

          const saved = await saveLocalConversation(savedConversation, {
            command: "clog save",
          });
          savedConversations.push(saved);
        }

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations saved locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
      }

      process.stdout.write(`Saved ${savedConversations.length} conversation(s).\n`);
      await printSaveIndexingOutcome(config, savedConversations);
      await maybePrintUnindexedHint(config);
      await maybePrintSummarizationHint();
    });
}

async function reinspectSavedRelationshipsIfNeeded(
  conversation: SavedConversationMeta,
  inspectionPath: string,
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<SavedConversationMeta> {
  const versionClassification =
    classifyInstalledRelationshipInspectionVersion(
      conversation.source,
      conversation.relationshipInspection.version,
    );
  if (versionClassification === "current") {
    return conversation;
  }
  if (versionClassification === "version_skew") {
    throw new ClogError(
      `Conversation ${conversation.id.slice(0, 8)} was saved by a newer clog version. Upgrade clog before refreshing it.`,
    );
  }

  const inspection = await getAdapter(
    conversation.source,
    config,
  ).inspectRelationships(inspectionPath);
  const refreshedInspection = preserveConfirmedRelationship(
    conversation,
    inspection,
  );
  return {
    ...conversation,
    relationshipInspection: {
      status: refreshedInspection.status,
      version: refreshedInspection.version,
      diagnostic: refreshedInspection.diagnostic,
    },
    relationships: refreshedInspection.relationships,
  };
}

// A save that would replace filled/restored content with a live local source
// version must confirm before overwriting the managed copy. The command attaches
// the matching scan candidate's sourcePath to the saved row in memory while the
// restored row keeps its null projectPath, so a continued source makes
// sourcePath and filePath diverge and reaches this guard without a scan write.
// Off a TTY, confirm() returns false and leaves both the row and managed copy
// unchanged. tests/save-restored-overwrite.test.ts pins this coupling.
async function confirmRestoredOverwriteIfNeeded(
  conversation: ConversationMeta,
  candidate: { shouldRefreshRawCopy: boolean },
): Promise<boolean> {
  if (
    !candidate.shouldRefreshRawCopy ||
    !isLikelyRestoredLocalConversation(conversation) ||
    pathsIdentifySameManagedCopy(conversation.sourcePath, conversation.filePath)
  ) {
    return true;
  }

  const accepted = await confirm(
    `Conversation ${conversation.id.slice(0, 8)} was restored from pair files. Refreshing it will overwrite the managed raw copy with the live local source file. Continue?`,
  );
  if (!accepted) {
    process.stdout.write(
      `Skipped ${conversation.id.slice(0, 8)}; restored content was left unchanged.\n`,
    );
  }
  return accepted;
}

async function printSaveIndexingOutcome(
  config: Awaited<ReturnType<typeof loadConfig>>,
  savedConversations: ConversationMeta[],
): Promise<void> {
  if (savedConversations.length === 0) {
    return;
  }

  if (!config.search) {
    process.stdout.write("Search indexing is not configured; no indexing necessary.\n");
    return;
  }

  if (!(await searchAvailable())) {
    process.stdout.write(
      "Search indexing is unavailable; saved conversation(s) were left unindexed.\n",
    );
    return;
  }

  process.stdout.write(
    'Indexing saved content for vector search. Safe to interrupt; run "clog index" to resume.\n',
  );

  const showProgress = process.stdout.isTTY && savedConversations.length > 1;
  const indexing = await maybeAutoIndexConversations(
    savedConversations,
    showProgress
      ? (completed, total) => {
          process.stdout.write(`\r${completed}/${total} conversations indexed for vector search...`);
          if (completed === total) {
            process.stdout.write("\n");
          }
        }
      : undefined,
  );

  for (const failedId of indexing.failedIds) {
    process.stderr.write(
      `warning: saved ${failedId.slice(0, 8)} but failed to index it for search\n`,
    );
  }

  const indexedCount = indexing.indexedIds.length;
  process.stdout.write(
    `Indexed ${indexedCount}/${savedConversations.length} conversation(s) for vector search.\n`,
  );
  if (indexing.skippedIds.length > 0) {
    process.stdout.write(
      `Skipped ${indexing.skippedIds.length} superseded conversation(s); current branches remain searchable.\n`,
    );
  }
}

async function resolveSaveSelectors(
  selectors: string[],
  scanSnapshot: LocalScanSnapshot,
): Promise<{ conversations: ConversationMeta[]; directSavedIds: Set<string> }> {
  const projectTargets = await collectProjectSaveTargets(scanSnapshot);
  const projectTargetIds = new Set(projectTargets.map((conversation) => conversation.id));
  const idCandidates = await listConversationView(
    { states: ["saved", "unsaved"] },
    scanSnapshot,
  );
  const projectCandidates = await listConversationView(
    { states: ["saved", "unsaved"], origin: "local" },
    scanSnapshot,
  );

  const directSavedIds = new Set<string>();
  for (const token of selectors) {
    if (token.startsWith("project:")) {
      continue;
    }
    const parsed = parseSourceQualifiedId(token.trim());
    if (!parsed.ok) {
      continue;
    }
    const projectMatches = projectCandidates.filter(
      (conversation) =>
        conversation.projectName?.toLowerCase() === token.trim().toLowerCase(),
    );
    if (projectMatches.length === 0) {
      const resolved = await resolveConversationView(token, {
        states: ["saved", "unsaved"],
        scanSnapshot,
      });
      if (resolved.state === "saved") {
        directSavedIds.add(resolved.id);
      }
    }
  }

  const conversations = await resolveConversationSelectors({
    commandName: "clog save",
    tokens: selectors,
    idCandidates,
    projectCandidates,
    projectSelectionFilter: (conversation) => projectTargetIds.has(conversation.id),
  });

  return { conversations, directSavedIds };
}

function throwDirectSavedSourceUnavailable(
  conversation: ConversationMeta,
  scanSnapshot: LocalScanSnapshot,
): never {
  const shortId = conversation.id.slice(0, 8);
  if (!isSourceDiscoveryComplete(conversation.source, scanSnapshot)) {
    throw new ClogError(
      `Could not determine whether the live source for conversation ${shortId} is available because ${conversation.source} discovery did not complete. Retry after checking the source directory.`,
    );
  }

  throw new ClogError(
    `The live source for conversation ${shortId} is unavailable or disabled. The saved copy was left unchanged. Restore or enable the ${conversation.source} source and run 'clog save ${shortId}' again, or use 'clog show ${shortId}' to inspect the saved copy.`,
  );
}

export async function maybePrintSummarizationHint(): Promise<void> {
  const saved = await listConversations({
    origin: "local",
  });

  const unsummarized = saved.filter(isUnsummarized);

  if (unsummarized.length === 0) {
    return;
  }

  process.stdout.write(
    `\n${chalk.bold(`${unsummarized.length} saved conversation(s) don't have structured summaries.`)} Run \`clog talk\` to start an agent session.\n`,
  );
}

async function maybePrintUnindexedHint(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.search) {
    return;
  }

  const count = (await listIndexEligibleConversationsNeedingIndex({
    indexAllBranches: config.search.indexAllBranches,
  })).length;
  if (count === 0) {
    return;
  }

  process.stdout.write(
    `hint: ${chalk.bold(`${count} saved conversation(s) still unindexed.`)} Run \`clog index\` to finish.\n`,
  );
}
