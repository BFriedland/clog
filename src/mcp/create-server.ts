import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";

import {
  browseInputSchema,
  getInputSchema,
  getOutputSchema,
  handleAnalysisSuggestions,
  handleBrowse,
  handleGet,
  handleList,
  handleSearch,
  handleSummarizationGuide,
  handleUpdate,
  listInputSchema,
  listOutputSchema,
  searchInputSchema,
  searchOutputSchema,
  updateInputSchema,
} from "./handlers.js";

// OpenAI's Codex docs recommend a server's first ~512 characters of
// instructions be self-contained (purpose and triggers stand on their own).
// That is an authoring guideline, not a truncation — Codex indexes the full
// string for tool search — so clog keeps the whole thing within it. A test
// pins the length.
const SERVER_INSTRUCTIONS =
  "clog discovers, organizes, and searches AI coding-agent conversations from Claude Code and Codex, and supports summarizing and analyzing them. " +
  "Use this server when a user asks to find a conversation, read its messages or metadata, edit titles, tags, or summaries, browse conversation metadata, or summarize and analyze conversations. " +
  "Use clog MCP tools before shell commands or file inspection for conversation work. " +
  "Use another interface when the user directs it or the needed tool is missing.";

export function createMcpServer(): McpServer {
  const server = new McpServer(
    {
      name: "clog-mcp",
      version: "0.1.0",
    },
    { instructions: SERVER_INSTRUCTIONS },
  );

  server.registerTool(
    "list_conversations",
    {
      title: "Find conversations",
      description:
        "Find and list saved Claude Code and Codex conversations by default, or explicitly list unsaved conversations or both lifecycle states. Related source branches collapse to one conversation result unless `allBranches` is true; each row's `id` is the conversation's representative branch ID in a collapsed view or the returned branch ID in an all-branches view, and `branchView` reports which view was requested. An `endpointCount` greater than 1 signals divergent outcomes. List rows intentionally omit branch IDs and ancestry objects; call `get_conversation` on the displayed conversation ID for navigation metadata. Default `grep` performs literal-text search across conversation endpoints; set `allBranches` to search superseded generations too. Results are paginated after branch collapse; follow `hasMore` and `nextOffset`.",
      inputSchema: listInputSchema,
      outputSchema: listOutputSchema,
    },
    async (input) => toToolResult(await handleList(input), "Listed conversations."),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation",
      description:
        "Get the coherent current transcript and relationship metadata for the requested saved clog conversation ID. The ID selects one exact conversation path, and this tool never substitutes another representative branch. The transcript starts at the conversation's opening turn, including copied history in canonical order, so a linear conversation can be read in one call without resolving its root. The `branchIds` and `childBranchIds` fields include only saved branches that this tool can open; `hasMoreBranches` indicates when additional unavailable branches are known, and parent metadata may identify an unsaved or unavailable branch. When `endpointCount` is greater than 1, inspect relevant branch IDs before summarizing divergent outcomes. An unsaved conversation must be saved before this tool can retrieve its messages.",
      inputSchema: getInputSchema,
      outputSchema: getOutputSchema,
    },
    async (input) => toToolResult(await handleGet(input), "Loaded conversation content."),
  );

  server.registerTool(
    "update_conversation",
    {
      title: "Update conversation",
      description:
        "Update title, summary, tags, or structured extraction on a saved, locally writable conversation. The ID selects one exact branch-backed conversation record, including when it came from a collapsed list or search result; metadata does not propagate to other branches in the conversation. For summarization work, pass `summary` and `extraction` together. Default summaryKind is 'generated'; pass 'curated' only when the user directs a specific edit.",
      inputSchema: updateInputSchema,
    },
    async (input) => toToolResult(await handleUpdate(input), "Updated conversation metadata."),
  );

  server.registerTool(
    "summarization_guide",
    {
      title: "Read the summarization guide",
      description:
        "Return clog's required workflow and quality guidelines for summarizing conversations. Read this before generating or updating conversation summaries.",
    },
    async () =>
      toToolResult(
        await handleSummarizationGuide(),
        "Returned the clog summarization guide.",
      ),
  );

  server.registerTool(
    "analysis_suggestions",
    {
      title: "Get analysis suggestions",
      description:
        "Return suggested analyses for exploring patterns, friction, outcomes, and working habits across a user's saved conversations.",
    },
    async () =>
      toToolResult(
        await handleAnalysisSuggestions(),
        "Returned analysis suggestions.",
      ),
  );

  server.registerTool(
    "search_conversations",
    {
      title: "Search conversations by meaning",
      description:
        "Semantic search across saved clog conversations; matches by meaning, not exact text. Related source branches collapse to one result per conversation unless `allBranches` is true. Each collapsed result's `id` identifies the highest-scoring matching branch, while `snippetBranchId` identifies the branch that supplied the snippet. An `endpointCount` greater than 1 signals divergent outcomes; call `get_conversation` and inspect relevant branch transcripts before summarizing them. Invalid relationship graphs fall back to branch-specific results and report `branchView` as `collapsed_with_branch_fallback`. For exact text, use the `grep` filter on `list_conversations`.",
      inputSchema: searchInputSchema,
      outputSchema: searchOutputSchema,
    },
    async (input) => toToolResult(await handleSearch(input), "Searched saved conversations."),
  );

  server.registerTool(
    "browse_metadata",
    {
      title: "Browse conversation metadata",
      description:
        "List the distinct tags, projects, or authors across saved clog conversations. Returns metadata values, not conversations. Use it to discover filter values before calling other conversation tools.",
      inputSchema: browseInputSchema,
    },
    async (input) => toToolResult(await handleBrowse(input), "Browsed conversation metadata."),
  );

  server.registerResource(
    "clog-conversation",
    new ResourceTemplate("clog://conversations/{id}", {
      list: undefined,
    }),
    {
      title: "clog conversation",
      description: "A saved clog conversation resource.",
      mimeType: "application/json",
    },
    async (_uri, variables) => {
      const id = firstVariable(variables.id);
      const payload = await handleGet({ id, tail: 200 });
      return {
        contents: [
          {
            uri: `clog://conversations/${id}`,
            text: JSON.stringify(payload, null, 2),
          },
        ],
      };
    },
  );

  return server;
}

function firstVariable(value: string | string[] | undefined): string {
  if (typeof value === "string") {
    return value;
  }

  if (Array.isArray(value) && value[0]) {
    return value[0];
  }

  throw new Error("Missing resource id.");
}

function toToolResult(payload: unknown, summary: string) {
  return {
    content: [
      {
        type: "text" as const,
        text: summary,
      },
    ],
    structuredContent: asStructuredContent(payload),
  };
}

function asStructuredContent(payload: unknown): Record<string, unknown> {
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    return payload as Record<string, unknown>;
  }

  return { value: payload };
}
