import chalk from "chalk";

import { getConversationById, listConversations } from "../db/index.js";
import type { ConversationMeta, SavedConversationMeta } from "../models/conversation.js";
import { getSearchProviders } from "../search/deps.js";
import { SearchDepsError, SearchNotConfiguredError, SearchSetupIncompleteError } from "../search/errors.js";
import { searchConversations } from "../search/indexer.js";
import { isConversationSearchable } from "../search/coherence.js";
import {
  collapseRelatedConversationSearchHits,
} from "../search/relationships.js";
import { ClogError } from "../utils/errors.js";

export async function runSearchCommand(
  query: string,
  options: {
    project?: string;
    author?: string;
    tag?: string;
    limit?: number;
    allBranches?: boolean;
  },
): Promise<void> {
  const { embedding, vectorStore } = await requireSearchProviders();
  const limit = options.limit ?? 10;
  const matchingSaved = await listMatchingSavedConversations(options);
  const graphUniverse = await listConversations();

  if (matchingSaved.length === 0) {
    process.stdout.write("No saved conversations match the specified filters.\n");
    return;
  }

  const searchableIds = new Set(
    matchingSaved
      .filter((conversation) => isConversationSearchable(conversation))
      .map((conversation) => conversation.id),
  );

  if (searchableIds.size === 0) {
    process.stdout.write('No saved conversations are indexed yet. Run "clog index".\n');
    return;
  }

  let scanCapReached = false;
  let hits;
  try {
    hits = await searchConversations(query, limit, embedding, vectorStore, {
      isConversationSearchable: (conversationId) => searchableIds.has(conversationId),
      composeResults: (candidateHits) =>
        collapseRelatedConversationSearchHits(
          graphUniverse,
          candidateHits,
          { allBranches: options.allBranches },
        ),
      onScanCapReached: () => {
        scanCapReached = true;
      },
    });
  } catch (error) {
    // Preserve known setup/config/dependency errors so they reach their own
    // dedicated messages instead of being misreported as a vector-index issue.
    if (
      error instanceof SearchNotConfiguredError ||
      error instanceof SearchDepsError ||
      error instanceof SearchSetupIncompleteError
    ) {
      throw error;
    }
    const detail = error instanceof Error ? error.message : String(error);
    throw new ClogError(
      `Search failed: ${detail}\nIf this looks like a vector-index issue (e.g. after changing the embedding model), try \`clog index --rebuild\`.`,
    );
  }

  const relatedHits = hits;
  const conversationsById = await loadConversationsById(
    relatedHits.map((hit) => hit.conversationId),
  );
  const visibleResults = relatedHits.filter((hit) => {
    const conversation = conversationsById.get(hit.conversationId);
    return isConversationSearchable(conversation);
  });
  const invalidRelationships = visibleResults.some(
    (hit) => hit.relationshipCompleteness === "invalid",
  );

  if (scanCapReached || invalidRelationships) {
    if (invalidRelationships) {
      process.stdout.write(
        `${chalk.yellow("warning:")} invalid conversation relationships were not collapsed.\n`,
      );
    }
    if (scanCapReached) {
      process.stdout.write(
        `${chalk.yellow("warning:")} search hit the maximum scan window; completeness is not guaranteed.\n`,
      );
    }
    if (visibleResults.length > 0) {
      process.stdout.write("\n");
    }
  }

  if (visibleResults.length === 0) {
    process.stdout.write("No results found.\n");
    return;
  }

  for (const [index, hit] of visibleResults.entries()) {
    const conversation = conversationsById.get(hit.conversationId);
    if (!conversation) {
      continue;
    }

    process.stdout.write(
      `${chalk.yellow(`${index + 1}.`)} ${chalk.cyan(conversation.id.slice(0, 8))} ${chalk.dim(
        `[${Math.round(hit.score * 100)}%]`,
      )} ${conversation.title}\n`,
    );

    if (conversation.projectName) {
      process.stdout.write(`   ${chalk.dim(conversation.projectName)}\n`);
    }

    process.stdout.write(`   ${chalk.dim(toSnippet(hit.text))}\n`);

    if (index < visibleResults.length - 1) {
      process.stdout.write("\n");
    }
  }
}

async function requireSearchProviders() {
  try {
    return await getSearchProviders();
  } catch (error) {
    if (
      error instanceof SearchNotConfiguredError ||
      error instanceof SearchDepsError ||
      error instanceof SearchSetupIncompleteError
    ) {
      throw error;
    }

    throw error;
  }
}

async function listMatchingSavedConversations(options: {
  project?: string;
  author?: string;
  tag?: string;
}): Promise<ConversationMeta[]> {
  return listConversations({
    projectName: options.project,
    author: options.author,
    tag: options.tag,
  });
}

async function loadConversationsById(ids: string[]): Promise<Map<string, SavedConversationMeta>> {
  const entries = await Promise.all(
    [...new Set(ids)].map(async (id) => [id, await getConversationById(id)] as const),
  );
  return new Map(
    entries.filter((entry): entry is readonly [string, SavedConversationMeta] => Boolean(entry[1])),
  );
}

function toSnippet(text: string): string {
  return text.replace(/\s+/g, " ").trim().slice(0, 200);
}
