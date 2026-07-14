import { Command } from "commander";

import {
  isLocalConversation,
  listConversations,
  removeConversationCopies,
  type RemovedConversationCopy,
} from "../db/index.js";
import type { ConversationMeta } from "../models/conversation.js";
import { tryDeleteConversationVectors } from "../search/coherence.js";
import { ClogError, UsageError } from "../utils/errors.js";
import {
  confirm,
  hasReadableIndependentSource,
  removeImportCopyIfPresent,
  removeRawCopyIfPresent,
} from "./common.js";
import { conversationMatchesAnyClogIgnoreRule, isRecognizedClogIgnoreRule } from "./clogignore.js";

interface RemoveOptions {
  yes?: boolean;
  dryRun?: boolean;
}

export function buildRemoveCommand(): Command {
  return new Command("remove")
    .description("Remove saved conversations currently known to clog")
    .argument("<rules...>")
    .option("--yes", "Remove matching conversations without prompting")
    .option("--dry-run", "Show matching conversations without removing them")
    .action(async (rules: string[], options: RemoveOptions) => {
      assertValidLiteralRules(rules);

      const matches = (await listConversations({ states: ["saved"] })).filter((conversation) =>
        conversationMatchesAnyClogIgnoreRule(conversation, rules),
      );

      if (matches.length === 0) {
        process.stdout.write("No saved conversations in clog's database match those rules.\n");
        return;
      }

      const missingSourceCount = await countSavedRowsWithMissingSources(matches);
      process.stdout.write(renderRemovalPreview(matches, missingSourceCount));

      if (options.dryRun) {
        process.stdout.write("Dry run: no conversations removed.\n");
        return;
      }

      if (!options.yes) {
        if (!process.stdin.isTTY) {
          throw new ClogError(
            "Refusing to remove conversations without confirmation. Re-run with --yes to confirm.",
          );
        }

        const accepted = await confirm("Continue?");
        if (!accepted) {
          process.stdout.write("Aborted.\n");
          return;
        }
      }

      const removed = await removeConversationCopies(matches, { command: "clog remove" });
      for (const removal of removed) {
        await applyRemovalFileEffect(removal);
      }

      const failures = await tryDeleteConversationVectors(removed.map((conversation) => conversation.id));
      for (const failedId of failures) {
        process.stderr.write(
          `warning: ${failedId.slice(0, 8)} was removed but its search vectors could not be deleted\n`,
        );
      }

      process.stdout.write(
        `Removed ${removed.length} conversation${removed.length === 1 ? "" : "s"} from clog's database.\n`,
      );
    });
}

async function applyRemovalFileEffect(removal: RemovedConversationCopy): Promise<void> {
  if (removal.fileEffect === "raw") {
    await removeRawCopyIfPresent(removal);
  } else if (removal.fileEffect === "import") {
    await removeImportCopyIfPresent(removal);
  }
}

function assertValidLiteralRules(rules: string[]): void {
  for (const rule of rules) {
    if (rule.trim().length === 0) {
      throw new ClogError("Ignore rules cannot be blank.");
    }

    if (rule.startsWith("project:")) {
      throw new UsageError(
        `clog remove does not accept project selectors like "${rule}". Pass a stored ignore-rule shape such as a simple name, filename, ID, or path instead.`,
      );
    }

    if (!isRecognizedClogIgnoreRule(rule)) {
      throw new UsageError(
        `clog remove does not accept unsupported ignore-rule syntax like "${rule}". Pass a simple name, filename, ID, or path instead.`,
      );
    }
  }
}

async function countSavedRowsWithMissingSources(
  conversations: ConversationMeta[],
): Promise<number> {
  let count = 0;

  for (const conversation of conversations) {
    if (
      isLocalConversation(conversation) &&
      conversation.state === "saved" &&
      !(await hasReadableIndependentSource(conversation))
    ) {
      count += 1;
    }
  }

  return count;
}

function renderRemovalPreview(
  conversations: ConversationMeta[],
  missingSourceCount: number,
): string {
  const lines: string[] = [];
  const plural = conversations.length === 1 ? "" : "s";
  lines.push(`Remove ${conversations.length} conversation${plural} from clog?`);
  lines.push("");

  for (const conversation of conversations.slice(0, 10)) {
    lines.push(
      `  ${conversation.id.slice(0, 8)}  ${conversation.source}  ${conversation.projectName ?? "(no project)"}  ${singleLine(conversation.title)}`,
    );
  }

  if (conversations.length > 10) {
    lines.push(`  ...and ${conversations.length - 10} more`);
  }

  lines.push("");

  if (missingSourceCount > 0) {
    lines.push(
      `Warning: ${missingSourceCount} saved conversation${missingSourceCount === 1 ? "" : "s"} no longer ${missingSourceCount === 1 ? "has a" : "have"} readable source file${missingSourceCount === 1 ? "" : "s"}. Their clog raw copies may be the only local transcript copies clog can access.`,
    );
    lines.push("");
  }

  lines.push(
    "This deletes clog metadata, summaries, tags, search vectors, and managed copies under raw/ or imports/ for these conversations.",
  );
  lines.push("Source files under ~/.claude and ~/.codex are not modified.");
  lines.push("");
  lines.push("If you want an export first, run:");
  lines.push(`  clog drain ${conversations.map(formatDrainSelector).join(" ")} -o <archive.zip>`);
  lines.push("");

  return `${lines.join("\n")}\n`;
}

function formatDrainSelector(conversation: ConversationMeta): string {
  return `${conversation.id}@${conversation.source}`;
}

function singleLine(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}
