#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "../config/index.js";
import { getScanWarningsForCommand, renderWarnings } from "../cli/common.js";
import { scanLocalSources } from "../cli/scan.js";
import {
  handleAnalysisSuggestions,
  handleBrowse,
  handleGet,
  handleListSaved,
  handleSearch,
  handleSummarizationGuide,
  handleUpdate,
  updateInputSchema,
} from "./handlers.js";

export async function startMcpServer(): Promise<void> {
  const config = await loadConfig();
  if (config.autoScan) {
    const scanResult = await scanLocalSources(config);
    renderWarnings(getScanWarningsForCommand(scanResult));
  }

  const server = new McpServer({
    name: "clog-mcp",
    version: "0.1.0",
  });

  server.registerTool(
    "clog_list_saved",
    {
      description:
        "List saved conversations with optional filters. Results are paginated; use limit and offset, then follow hasMore/nextOffset in the response.",
      inputSchema: {
        tags: z
          .array(z.string())
          .optional()
          .describe("Filter by tags using OR semantics after tag normalization."),
        project: z
          .string()
          .optional()
          .describe("Filter by project using case-insensitive substring matching."),
        author: z
          .string()
          .optional()
          .describe("Filter by author metadata using case-insensitive substring matching."),
        grep: z
          .string()
          .optional()
          .describe("Case-insensitive substring match on title, summary, or message content."),
        origin: z
          .enum(["local", "remote"])
          .optional()
          .describe("Use local for locally writable rows, remote for imported read-only rows."),
        limit: z
          .number()
          .int()
          .positive()
          .max(100)
          .optional()
          .describe("Maximum conversations to return. Defaults to 20; maximum is 100."),
        offset: z
          .number()
          .int()
          .nonnegative()
          .optional()
          .describe("Zero-based result offset for pagination. Use nextOffset when hasMore is true."),
        sortBy: z
          .enum(["createdAt", "savedAt", "modifiedAt", "title", "project", "author"])
          .optional()
          .describe("Sort field. Defaults to createdAt."),
        sortDirection: z
          .enum(["asc", "desc"])
          .optional()
          .describe("Sort direction. Defaults to desc."),
      },
    },
    async (input) => toToolResult(await handleListSaved(input), "Listed saved conversations."),
  );

  server.registerTool(
    "clog_get",
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
    "clog_update",
    {
      description:
        "Update saved conversation metadata. For summarization work, pass `summary` and `extraction` together. Default summaryKind is 'generated'; pass 'curated' only when the user directs a specific edit.",
      inputSchema: updateInputSchema,
    },
    async (input) => toToolResult(await handleUpdate(input), "Updated conversation metadata."),
  );

  server.registerTool(
    "clog_summarization_guide",
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
    "clog_analysis_suggestions",
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
    "clog_search",
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
    "clog_browse",
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

  const transport = new StdioServerTransport();
  await server.connect(transport);
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

await startMcpServer();
