import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import {
  handleAnalysisSuggestions,
  handleBrowse,
  handleGet,
  handleList,
  handleSearch,
  handleSummarizationGuide,
  handleUpdate,
  listInputSchema,
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
        "Find and list saved Claude Code and Codex conversations by default, or explicitly list unsaved conversations or both lifecycle states. Use `grep` for case-insensitive literal-text matching across titles, summaries, and transcript messages; use `search_conversations` for related meaning. Results are paginated; follow `hasMore` and `nextOffset`.",
      inputSchema: listInputSchema,
    },
    async (input) => toToolResult(await handleList(input), "Listed conversations."),
  );

  server.registerTool(
    "get_conversation",
    {
      title: "Get conversation",
      description:
        "Get the messages and metadata for a saved clog conversation by ID. After `list_conversations` or `search_conversations` returns a candidate, use this tool to inspect and verify the relevant transcript messages for summarization, review, or follow-up analysis. An unsaved conversation must be saved before this tool can retrieve its messages.",
      inputSchema: {
        id: z.string(),
        maxMessages: z.number().int().positive().max(200).optional(),
        head: z.number().int().positive().max(200).optional(),
        tail: z.number().int().positive().max(200).optional(),
        offset: z.number().int().nonnegative().optional(),
        limit: z.number().int().positive().max(200).optional(),
      },
    },
    async (input) => toToolResult(await handleGet(input), "Loaded conversation content."),
  );

  server.registerTool(
    "update_conversation",
    {
      title: "Update conversation",
      description:
        "Update a saved clog conversation's metadata: title, summary, tags, and structured extraction; the ID comes from `list_conversations` or `search_conversations`. For summarization work, pass `summary` and `extraction` together. Default summaryKind is 'generated'; pass 'curated' only when the user directs a specific edit.",
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
      inputSchema: {},
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
      inputSchema: {},
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
        "Semantic search across saved clog conversations; matches by meaning, not exact text. For exact text, use the `grep` filter on `list_conversations`.",
      inputSchema: {
        query: z.string(),
        tags: z.array(z.string()).optional(),
        project: z
          .string()
          .optional()
          .describe("Filter by project using case-insensitive substring matching."),
        author: z
          .string()
          .optional()
          .describe("Filter by author metadata using case-insensitive substring matching."),
        origin: z
          .enum(["local", "remote"])
          .optional()
          .describe("Use local for locally writable rows, remote for imported read-only rows."),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async (input) => toToolResult(await handleSearch(input), "Searched saved conversations."),
  );

  server.registerTool(
    "browse_metadata",
    {
      title: "Browse conversation metadata",
      description:
        "List the distinct tags, projects, or authors across saved clog conversations. Returns metadata values, not conversations. Use it to discover filter values before calling other conversation tools.",
      inputSchema: {
        by: z.enum(["tags", "projects", "authors"]),
      },
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
      const payload = await handleGet({ id, maxMessages: 200 });
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
