import path from "node:path";
import { scanSources } from "./scan.js";
import { loadConfig } from "../config/schema.js";
import { getDefaultSourcePaths } from "../config/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { withDb } from "../db/index.js";
import { loadExcluded, isExcluded } from "./excluded.js";
import { stateColors } from "./colors.js";
import type { ConversationState, ConversationMeta } from "../models/conversation.js";

export interface ListOpts {
  state?: ConversationState;
  all?: boolean;
  project?: string;
  author?: string;
  tag?: string;
  grep?: string;
  columns?: string;
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

  if (opts.all) {
    rows = await buildAllRows(opts);
  } else if (opts.state) {
    rows = await buildDbRows({ ...opts, state: opts.state });
  } else {
    // Default: staged + published
    rows = await buildDbRows(opts);
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
}

/**
 * Default / --state mode: query from DB only.
 * No flags = staged + published. --state = specific state.
 */
async function buildDbRows(opts: ListOpts): Promise<ListRow[]> {
  let conversations: ConversationMeta[];

  if (opts.state) {
    conversations = await withDb((ctx) =>
      ctx.listConversations({
        state: opts.state as ConversationState,
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
      })
    );
  } else {
    // Default: staged + published
    const [staged, published] = await withDb((ctx) => [
      ctx.listConversations({
        state: "staged",
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
      }),
      ctx.listConversations({
        state: "published",
        project: opts.project,
        author: opts.author,
        tag: opts.tag,
        grep: opts.grep,
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

  const rows: ListRow[] = [];

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

    rows.push({
      shortId: conv.sourceId.slice(0, 7),
      date: createdAt.slice(0, 10),
      state,
      project: project ? path.basename(project) : "",
      author: dbConv?.author ?? "",
      title,
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
