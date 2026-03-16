import chalk from "chalk";
import path from "node:path";
import { loadConfig } from "../config/schema.js";
import { getDefaultSourcePaths } from "../config/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { withDb } from "../db/index.js";
import { loadExcluded, isExcluded } from "./excluded.js";
import { stateColors } from "./colors.js";
import type { DiscoveredConversation } from "../models/conversation.js";

export async function scanCommand(): Promise<void> {
  const config = await loadConfig();
  const sourceConfig = config.sources["claude-code"];

  const sourcePaths =
    sourceConfig.paths.length > 0
      ? sourceConfig.paths
      : getDefaultSourcePaths();

  const adapter = new ClaudeCodeAdapter(sourcePaths);
  const excludedEntries = await loadExcluded();

  // Collect all conversations the adapter finds — no filtering
  const all: Array<{
    conv: DiscoveredConversation;
    excluded: boolean;
    dbState: string | null;
  }> = [];

  for await (const conv of adapter.discover()) {
    const excluded = isExcluded(excludedEntries, "claude-code", conv.sourceId);

    // Look up DB state if it exists
    const dbState = await withDb((ctx) => {
      const existing = ctx.getConversationBySourceId(
        "claude-code",
        conv.sourceId
      );
      return existing?.state ?? null;
    });

    all.push({ conv, excluded, dbState });
  }

  if (all.length === 0) {
    throw new Error(`No conversations found in source directories. Searched: ${sourcePaths.join(", ")}`);
  }

  // Sort by date descending
  all.sort((a, b) =>
    b.conv.metadata.createdAt.localeCompare(a.conv.metadata.createdAt)
  );

  const termWidth = process.stdout.columns || 80;
  const prefixWidth = 9 + 12 + 12 + 17; // ID + DATE + STATE + PROJECT
  const titleWidth = Math.max(1, termWidth - prefixWidth);

  console.log(
    `${pad("ID", 9)}${pad("DATE", 12)}${pad("STATE", 12)}${pad("PROJECT", 17)}TITLE`
  );

  for (const { conv, excluded, dbState } of all) {
    const shortId = conv.sourceId.slice(0, 7);
    const date = conv.metadata.createdAt.slice(0, 10);
    const project = conv.metadata.project
      ? path.basename(conv.metadata.project)
      : "";
    const title = conv.metadata.title
      .replace(/[\r\n]+/g, " ")
      .slice(0, titleWidth);

    let state: string;
    if (excluded) {
      state = "excluded";
    } else if (dbState) {
      state = dbState;
    } else {
      state = "new";
    }

    let line = `${pad(shortId, 9)}${pad(date, 12)}${pad(state, 12)}${pad(project, 17)}${title}`;

    if (excluded) {
      line = stateColors.excluded(line);
    } else if (state === "staged" || state === "published") {
      line = stateColors[state](line);
    }

    console.log(line);
  }

  const counts = {
    total: all.length,
    excluded: all.filter((a) => a.excluded).length,
    published: all.filter((a) => a.dbState === "published").length,
    staged: all.filter((a) => a.dbState === "staged").length,
  };
  const newCount =
    counts.total - counts.excluded - counts.published - counts.staged;

  console.log("");
  console.log(
    `${counts.total} conversations: ${newCount} new, ${chalk.green(String(counts.staged) + " staged")}, ${counts.published} published, ${chalk.dim(String(counts.excluded) + " excluded")}`
  );
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width - 1) + " ";
  return str + " ".repeat(width - str.length);
}
