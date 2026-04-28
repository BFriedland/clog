import { Command } from "commander";

import { loadConfig } from "../config/index.js";
import { deleteConversation, listConversations, updateConversation } from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import type { ClogWarning } from "../models/warnings.js";
import { ClogError } from "../utils/errors.js";
import { nowIso } from "../utils/time.js";
import {
  ensureRawCopy,
  compareFileContents,
  getScanWarningsForCommand,
  pathExists,
  renderWarnings,
} from "./common.js";
import { collectProjectAddTargets } from "./project-targets.js";
import { scanLocalSources } from "./scan.js";
import { resolveConversationSelectors } from "./selectors.js";

export function buildAddCommand(): Command {
  return new Command("add")
    .description("Stage or refresh conversations")
    .argument("[selectors...]", "Conversation IDs or project selectors")
    .option("--all")
    .action(async (selectors: string[], options) => {
      const config = await loadConfig();
      const preScanCandidates = selectors.length > 0 ? await listConversations() : [];
      const scanResult = await scanLocalSources(config);
      renderWarnings(getScanWarningsForCommand(scanResult));

      let conversations: ConversationMeta[] = [];

      if (selectors.length > 0) {
        try {
          conversations = resolveConversationSelectors({
            commandName: "clog add",
            tokens: selectors,
            idCandidates: await listConversations(),
            projectCandidates: await collectProjectAddTargets(),
          });
        } catch (error) {
          if (
            error instanceof ClogError &&
            (error.message.startsWith("No conversation") || error.message.startsWith("No project"))
          ) {
            const missingSourceTarget = await findMissingSourceTarget(preScanCandidates, selectors);
            if (missingSourceTarget) {
              throw new Error(
                `Source file is missing for ${missingSourceTarget.id}. Run "clog status" to refresh discovery.`,
              );
            }
          }

          throw error;
        }
      }

      if (options.all) {
        conversations = await listConversations({
          states: ["discovered"],
          origin: "local",
        });
      }

      if (conversations.length === 0) {
        process.stdout.write("No conversations selected.\n");
        return;
      }

      let changed = 0;
      const warnings: ClogWarning[] = [];
      const isScanDrivenSelection = true;

      for (const conversation of conversations) {
        if (!(await pathExists(conversation.sourcePath))) {
          if (isScanDrivenSelection && conversation.state === "discovered") {
            warnings.push({
              code: "missing_source_file",
              message: `Skipping ${conversation.id.slice(0, 7)} because the source file disappeared before it could be added.`,
              source: conversation.source,
              path: conversation.sourcePath,
              guidance: "The stale discovered entry was removed. Re-run status to refresh discovery.",
            });
            await deleteConversation(conversation.id);
            continue;
          }

          throw new Error(
            `Source file is missing for ${conversation.id}. Run "clog status" to refresh discovery.`,
          );
        }

        const identical =
          conversation.state !== "discovered" &&
          conversation.filePath != null &&
          (await compareFileContents(conversation.sourcePath, conversation.filePath));

        const destination = await ensureRawCopy(conversation);

        const updated = {
          ...conversation,
          state: conversation.state === "published" ? "published" : "staged",
          filePath: destination,
          modifiedAt: identical ? conversation.modifiedAt : nowIso(),
          indexedAt:
            conversation.state === "published" && !identical ? null : conversation.indexedAt,
        } as const;

        await updateConversation(updated);
        changed += 1;
      }

      renderWarnings(warnings);
      process.stdout.write(`Added ${changed} conversation${changed === 1 ? "" : "s"}.\n`);
    });
}

async function findMissingSourceTarget(
  candidates: ConversationMeta[],
  selectors: string[],
): Promise<ConversationMeta | null> {
  for (const token of selectors) {
    if (token.startsWith("project:")) {
      continue;
    }

    const trimmed = token.trim();
    const [rawPrefix, rawSource] = trimmed.split("@", 2);
    const prefix = rawPrefix.toLowerCase();
    const source = rawSource?.toLowerCase();

    if (prefix.length < 4) {
      continue;
    }

    const matches = candidates.filter((conversation) => {
      if (source && conversation.source.toLowerCase() !== source) {
        return false;
      }

      return conversation.id.toLowerCase().startsWith(prefix);
    });

    if (matches.length !== 1) {
      continue;
    }

    if (!(await pathExists(matches[0].sourcePath))) {
      return matches[0];
    }
  }

  return null;
}
