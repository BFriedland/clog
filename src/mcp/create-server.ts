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

export function createMcpServer(): McpServer {
  const server = new McpServer({
    name: "clog-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "list_conversations",
    {
      description:
        "List conversations by state (saved, unsaved, or all) with optional metadata filters. Results are paginated; use limit and offset, then follow hasMore/nextOffset in the response.",
      inputSchema: listInputSchema,
    },
    async (input) => toToolResult(await handleList(input), "Listed conversations."),
  );

  server.registerTool(
    "get_conversation",
    {
      description: "Get saved conversation content.",
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
      description:
        "Update saved conversation metadata. For summarization work, pass `summary` and `extraction` together. Default summaryKind is 'generated'; pass 'curated' only when the user directs a specific edit.",
      inputSchema: updateInputSchema,
    },
    async (input) => toToolResult(await handleUpdate(input), "Updated conversation metadata."),
  );

  server.registerTool(
    "summarization_guide",
    {
      description:
        "Read this before summarizing clog conversations. Returns the markdown guide describing the extraction shape and quality guidelines.",
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
      description:
        "Returns an opinionated library of analyses to offer the user when helping them explore their saved conversations.",
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
      description: "Semantic search across saved conversations.",
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
      description: "Browse saved tags, projects, or authors.",
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
