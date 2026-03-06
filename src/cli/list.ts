import path from "node:path";
import chalk from "chalk";
import { scanSources } from "./scan.js";
import { loadConfig } from "../config/schema.js";
import { getDefaultSourcePaths } from "../config/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { withDb } from "../db/index.js";
import { loadExcluded, isExcluded } from "./excluded.js";
import { stateColors } from "./colors.js";
import { checkStaleness } from "../sync/staleness.js";
import type { ConversationState, ConversationMeta } from "../models/conversation.js";

export interface ListOpts {
  state?: ConversationState;
  all?: boolean;
  project?: string;
  author?: string;
  tag?: string;
  grep?: string;
  columns?: string;
  origin?: string;
}

interface ListRow {
  shortId: string;
  date: string;
  state: string;
  project: string;
  author: string;
  title: string;
}

// Canonical column order — --columns toggles which are visible, not their order
const COLUMN_ORDER: Array<{ name: string; header: string; field: keyof ListRow }> = [
  { name: "id",      header: "ID",      field: "shortId" },
  { name: "date",    header: "DATE",    field: "date" },
  { name: "state",   header: "STATE",   field: "state" },
  { name: "project", header: "PROJECT", field: "project" },
  { name: "author",  header: "AUTHOR",  field: "author" },
  { name: "title",   header: "TITLE",   field: "title" },
];

const VALID_COLUMNS = new Set(COLUMN_ORDER.map((c) => c.name));
const DEFAULT_COLUMNS = new Set(["id", "date", "state", "project", "title"]);

export async function listCommand(opts: ListOpts): Promise<void> {
  await scanSources();

  let rows: ListRow[];
  let teamCount = 0;

  if (opts.all) {
    rows = await buildAllRows(opts);
  } else if (opts.state || opts.origin) {
    rows = await buildDbRows(opts);
  } else {
    // Default: user's own conversations + discovered
    const result = await buildDefaultRows(opts);
    rows = result.rows;
    teamCount = result.teamCount;
  }

  if (rows.length === 0) {
    console.log("No conversations found.");
    return;
  }

  // Resolve which columns are enabled
  let enabled: Set<string>;
  if (opts.columns) {
    const requested = opts.columns.split(",").map((c) => c.trim().toLowerCase());
    if (requested.includes("all")) {
      enabled = new Set(VALID_COLUMNS);
    } else {
      const invalid = requested.filter((c) => !VALID_COLUMNS.has(c));
      if (invalid.length > 0) {
        console.error(`Unknown column(s): ${invalid.join(", ")}`);
        console.error(`Valid columns: ${[...VALID_COLUMNS].join(", ")}, all`);
        process.exitCode = 1;
        return;
      }
      enabled = new Set(requested);
    }
  } else {
    enabled = new Set(DEFAULT_COLUMNS);
  }

  // Auto-show author when multiple distinct authors are present
  if (!enabled.has("author")) {
    const authors = new Set(rows.map((r) => r.author).filter(Boolean));
    if (authors.size > 1) {
      enabled.add("author");
    }
  }

  // Filter to enabled columns in canonical order
  const hasTitle = enabled.has("title");
  const fixedCols = COLUMN_ORDER.filter((c) => enabled.has(c.name) && c.name !== "title");

  // Compute dynamic widths: max(header, longest value) + 2 gutter
  const colWidths = fixedCols.map((c) => {
    const maxVal = rows.reduce((max, r) => Math.max(max, r[c.field].length), 0);
    return Math.max(c.header.length, maxVal) + 2;
  });

  const termWidth = process.stdout.columns || 80;
  const prefixWidth = colWidths.reduce((sum, w) => sum + w, 0);
  const titleWidth = Math.max(1, termWidth - prefixWidth);

  // Print header
  const header = fixedCols.map((c, i) => pad(c.header, colWidths[i])).join("")
    + (hasTitle ? "TITLE" : "");
  console.log(header);

  for (const row of rows) {
    const prefix = fixedCols.map((c, i) => pad(row[c.field], colWidths[i])).join("");

    const title = hasTitle
      ? row.title.replace(/[\r\n]+/g, " ").slice(0, titleWidth)
      : "";

    let line = prefix + title;

    const colorFn = stateColors[row.state as keyof typeof stateColors];
    if (colorFn) {
      line = colorFn(line);
    }

    console.log(line);
  }

  // Team conversation footer
  if (teamCount > 0) {
    console.log("");
    console.log(
      `${teamCount} team conversations available (use \`clog list --all\` to include)`
    );
  }

  // Staleness warning
  const config = await loadConfig();
  if (config.remote.url) {
    const staleness = await checkStaleness(config);
    if (staleness.isStale) {
      console.log("");
      console.log(
        chalk.yellow("Warning: remote checkout has changed outside of clog.")
      );
      console.log('Run `clog refresh` to reconcile.');
    }
  }
}

/**
 * Default mode: staged + published, filtered to user's own conversations.
 * WHERE (state IN ('staged','published')) AND (author = config.author OR origin IS NULL)
 */
async function buildDefaultRows(opts: ListOpts): Promise<{ rows: ListRow[]; teamCount: number }> {
  const config = await loadConfig();

  const result = await withDb((ctx) => {
    // Get staged + published
    const staged = ctx.listConversations({
      state: "staged",
      project: opts.project,
      tag: opts.tag,
      grep: opts.grep,
    });
    const published = ctx.listConversations({
      state: "published",
      project: opts.project,
      tag: opts.tag,
      grep: opts.grep,
    });
    const all = [...staged, ...published];

    // Filter: author matches OR origin is null (local)
    const filtered = all.filter((c) => {
      if (opts.author && c.author !== opts.author) return false;
      if (config.author && c.author === config.author) return true;
      if (!c.origin) return true;
      return false;
    });

    // Count team conversations (remote, not by current user) for footer
    const remoteOthers = all.filter((c) =>
      c.origin && c.state === "published" && c.author !== config.author
    );

    return { visible: filtered, teamCount: remoteOthers.length };
  });

  const rows = result.visible
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt))
    .map((conv) => ({
      shortId: conv.id.slice(0, 7),
      date: conv.createdAt.slice(0, 10),
      state: conv.state,
      project: conv.project ? path.basename(conv.project) : "",
      author: conv.author || "",
      title: conv.title,
    }));

  return { rows, teamCount: result.teamCount };
}

/**
 * --state or --origin mode: query from DB with filters.
 */
async function buildDbRows(opts: ListOpts): Promise<ListRow[]> {
  const originFilter = opts.origin === "local" ? "local" as const
    : opts.origin === "remote" ? "remote" as const
    : undefined;

  let conversations: ConversationMeta[];

  if (opts.state) {
    conversations = await withDb((ctx) =>
      ctx.listConversations({
        state: opts.state as ConversationState,
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
        origin: originFilter,
      })
    );
  } else {
    // With --origin but no --state: staged + published
    const [staged, published] = await withDb((ctx) => [
      ctx.listConversations({
        state: "staged",
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
        origin: originFilter,
      }),
      ctx.listConversations({
        state: "published",
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
        origin: originFilter,
      }),
    ]);
    conversations = [...staged, ...published].sort(
      (a, b) => b.createdAt.localeCompare(a.createdAt)
    );
  }

  return conversations.map((conv) => ({
    shortId: conv.id.slice(0, 7),
    date: conv.createdAt.slice(0, 10),
    state: conv.state,
    project: conv.project ? path.basename(conv.project) : "",
    author: conv.author || "",
    title: conv.title,
  }));
}

/**
 * --all mode: discover all conversations from source, merge with DB state,
 * include excluded conversations (dimmed).
 */
async function buildAllRows(opts: ListOpts): Promise<ListRow[]> {
  const config = await loadConfig();
  const sourceConfig = config.sources["claude-code"];

  const sourcePaths =
    sourceConfig.paths.length > 0
      ? sourceConfig.paths
      : getDefaultSourcePaths();

  const adapter = new ClaudeCodeAdapter(sourcePaths);
  const excludedEntries = await loadExcluded();

  // Load all DB conversations once to avoid N+1 withDb calls
  const allDbConvs = await withDb((ctx) => ctx.listConversations());
  const dbConvsBySourceId = new Map(
    allDbConvs.filter((c) => c.source === "claude-code").map((c) => [c.sourceId, c])
  );

  const originFilter = opts.origin === "local" ? "local" as const
    : opts.origin === "remote" ? "remote" as const
    : undefined;

  const rows: ListRow[] = [];
  const seenIds = new Set<string>();

  for await (const conv of adapter.discover()) {
    const excluded = isExcluded(excludedEntries, "claude-code", conv.sourceId);
    const dbConv = dbConvsBySourceId.get(conv.sourceId) ?? null;

    let state: string;
    if (excluded) {
      state = "excluded";
    } else if (dbConv) {
      state = dbConv.state;
    } else {
      state = "discovered";
    }

    // Apply origin filter
    if (originFilter === "remote" && (!dbConv || !dbConv.origin)) continue;
    if (originFilter === "local" && dbConv?.origin) continue;

    // Apply filters
    if (opts.state && state !== opts.state) continue;
    if (opts.project) {
      const project = dbConv?.project ?? conv.metadata.project ?? "";
      if (!project.toLowerCase().includes(opts.project.toLowerCase())) continue;
    }
    if (opts.author && dbConv) {
      if (!dbConv.author.toLowerCase().includes(opts.author.toLowerCase())) continue;
    }
    if (opts.tag && dbConv) {
      if (!dbConv.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) continue;
    }
    if (opts.grep) {
      const title = dbConv?.title ?? conv.metadata.title;
      const summary = dbConv?.summary ?? conv.metadata.summary;
      const pattern = opts.grep.toLowerCase();
      if (!title.toLowerCase().includes(pattern) && !summary.toLowerCase().includes(pattern)) continue;
    }

    const title = dbConv?.title ?? conv.metadata.title;
    const project = dbConv?.project ?? conv.metadata.project ?? "";
    const createdAt = dbConv?.createdAt ?? conv.metadata.createdAt;

    seenIds.add(conv.sourceId);

    rows.push({
      shortId: conv.sourceId.slice(0, 7),
      date: createdAt.slice(0, 10),
      state,
      project: project ? path.basename(project) : "",
      author: dbConv?.author ?? "",
      title,
    });
  }

  // Include remote conversations from DB that weren't in the adapter discovery
  const remoteConvs = allDbConvs.filter((c) => c.origin && !seenIds.has(c.sourceId));
  for (const conv of remoteConvs) {
    if (originFilter === "local") continue;

    if (opts.state && conv.state !== opts.state) continue;
    if (opts.project) {
      const project = conv.project ?? "";
      if (!project.toLowerCase().includes(opts.project.toLowerCase())) continue;
    }
    if (opts.author) {
      if (!conv.author.toLowerCase().includes(opts.author.toLowerCase())) continue;
    }
    if (opts.tag) {
      if (!conv.tags.some((t) => t.toLowerCase() === opts.tag!.toLowerCase())) continue;
    }
    if (opts.grep) {
      const pattern = opts.grep.toLowerCase();
      if (!conv.title.toLowerCase().includes(pattern) && !conv.summary.toLowerCase().includes(pattern)) continue;
    }

    rows.push({
      shortId: conv.id.slice(0, 7),
      date: conv.createdAt.slice(0, 10),
      state: conv.state,
      project: conv.project ? path.basename(conv.project) : "",
      author: conv.author || "",
      title: conv.title,
    });
  }

  // Sort by date descending
  rows.sort((a, b) => b.date.localeCompare(a.date));

  return rows;
}

function pad(str: string, width: number): string {
  if (str.length >= width) return str.slice(0, width - 1) + " ";
  return str + " ".repeat(width - str.length);
}
