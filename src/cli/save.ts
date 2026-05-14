import chalk from "chalk";
import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import {
  listConversations,
  listConversationsNeedingIndex,
  updateConversation,
} from "../db/index.js";
import { isUnsummarized, type ConversationMeta } from "../models/conversation.js";
import { maybeAutoIndexConversations } from "../search/coherence.js";
import { searchAvailable } from "../search/deps.js";
import { nowIso } from "../utils/time.js";
import {
  assertNoneRemote,
  defaultSaveFilePath,
  ensureRawCopy,
  getSaveCandidate,
  parseConversationMessages,
  parseConversationMessagesFromPath,
} from "./common.js";
import { collectBareSaveTargets, collectProjectSaveTargets } from "./project-targets.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildSaveCommand(): Command {
  return new Command("save")
    .description("Save conversations")
    .argument("[selectors...]")
    .action(async (selectors: string[]) => {
      const config = await loadConfig();
      const conversations =
        selectors.length > 0
          ? resolveConversationSelectors({
              commandName: "clog save",
              tokens: selectors,
              idCandidates: await listConversations(),
              projectCandidates: await collectProjectSaveTargets(),
            })
          : await collectBareSaveTargets();

      if (conversations.length === 0) {
        process.stdout.write('No staged conversations. Use "clog add <id>" to stage conversations first.\n');
        await maybePrintUnindexedHint(config);
        return;
      }

      assertNoneRemote(conversations, "clog save");

      const savedConversations: ConversationMeta[] = [];
      const showProgress = process.stdout.isTTY && conversations.length > 1;

      for (const [index, conversation] of conversations.entries()) {
        if (
          selectors.length > 0 &&
          conversation.state !== "discovered" &&
          conversation.state !== "staged" &&
          conversation.state !== "saved"
        ) {
          throw new Error(`Conversation ${conversation.id} cannot be saved.`);
        }

        const candidate = await getSaveCandidate(conversation);
        const rawPath =
          conversation.state === "discovered" || !conversation.filePath
            ? defaultSaveFilePath(conversation)
            : conversation.filePath;

        if (candidate.shouldRefreshRawCopy) {
          await ensureRawCopy(conversation);
        }

        const parsePath =
          candidate.shouldRefreshRawCopy && conversation.state === "discovered"
            ? rawPath
            : candidate.shouldRefreshRawCopy
              ? rawPath
              : candidate.path;

        const messages =
          parsePath === resolveFilePathOrFallback(conversation, rawPath)
            ? await parseConversationMessages(config, {
                ...conversation,
                filePath: parsePath,
                state: conversation.state === "discovered" ? "staged" : conversation.state,
              })
            : await parseConversationMessagesFromPath(config, conversation.source, parsePath);
        const timestamp = nowIso();

        const savedConversation = {
          ...conversation,
          filePath: rawPath,
          state: "saved" as const,
          saveVersion: conversation.saveVersion + 1,
          savedAt: timestamp,
          modifiedAt: timestamp,
          savedMessageCount: messages.length,
          indexedAt: null,
        };

        await updateConversation(savedConversation);
        savedConversations.push(savedConversation);

        if (showProgress) {
          process.stdout.write(
            `\r${index + 1}/${conversations.length} conversations saved locally...`,
          );
        }
      }

      if (showProgress) {
        process.stdout.write("\n");
      }

      if (showProgress && (await searchAvailable())) {
        process.stdout.write(
          'Indexing conversations for vector search. Safe to interrupt; run "clog index" to resume.\n',
        );
      }

      const indexedFailures = await maybeAutoIndexConversations(
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

      for (const failedId of indexedFailures) {
        process.stderr.write(
          `warning: saved ${failedId.slice(0, 8)} but failed to index it for search\n`,
        );
      }

      process.stdout.write(`Saved ${conversations.length} conversation(s).\n`);
      await maybePrintUnindexedHint(config);
      await maybePrintSummarizationHint();
    });
}

export async function maybePrintSummarizationHint(): Promise<void> {
  const saved = await listConversations({
    states: ["saved"],
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

function resolveFilePathOrFallback(
  conversation: { filePath: string | null },
  fallback: string,
): string {
  return conversation.filePath ?? fallback;
}

async function maybePrintUnindexedHint(
  config: Awaited<ReturnType<typeof loadConfig>>,
): Promise<void> {
  if (!config.search) {
    return;
  }

  const count = (await listConversationsNeedingIndex()).length;
  if (count === 0) {
    return;
  }

  process.stdout.write(
    `hint: ${chalk.bold(`${count} saved conversation(s) still unindexed.`)} Run \`clog index\` to finish.\n`,
  );
}
