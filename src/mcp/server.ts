#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

import { loadConfig } from "../config/index.js";
import { getScanWarningsForCommand, renderWarnings } from "../cli/common.js";
import { scanLocalSources } from "../cli/scan.js";
import {
  handleBrowse,
  handleGet,
  handleListPublished,
  handleSearch,
  handleListStaged,
  handleUpdate,
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
    "clog_list_published",
    {
      description: "List published conversations with optional filters.",
      inputSchema: {
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        author: z.string().optional(),
        grep: z.string().optional(),
        origin: z.enum(["local", "remote"]).optional(),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (input) => toToolResult(await handleListPublished(input), "Listed published conversations."),
  );

  server.registerTool(
    "clog_list_staged",
    {
      description: "List staged conversations with optional filters.",
      inputSchema: {
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        author: z.string().optional(),
        grep: z.string().optional(),
        limit: z.number().int().positive().max(100).optional(),
        offset: z.number().int().nonnegative().optional(),
      },
    },
    async (input) => toToolResult(await handleListStaged(input), "Listed staged conversations."),
  );

  server.registerTool(
    "clog_get",
    {
      description: "Get staged or published conversation content.",
      inputSchema: {
        id: z.string(),
        maxMessages: z.number().int().positive().max(200).optional(),
      },
    },
    async (input) => toToolResult(await handleGet(input), "Loaded conversation content."),
  );

  server.registerTool(
    "clog_update",
    {
      description: "Update staged or published conversation metadata.",
      inputSchema: {
        id: z.string(),
        title: z.string().optional(),
        summary: z.string().optional(),
        addTags: z.array(z.string()).optional(),
        removeTags: z.array(z.string()).optional(),
      },
    },
    async (input) => toToolResult(await handleUpdate(input), "Updated conversation metadata."),
  );

  server.registerTool(
    "clog_search",
    {
      description: "Semantic search across published conversations.",
      inputSchema: {
        query: z.string(),
        tags: z.array(z.string()).optional(),
        project: z.string().optional(),
        author: z.string().optional(),
        origin: z.enum(["local", "remote"]).optional(),
        limit: z.number().int().positive().max(50).optional(),
      },
    },
    async (input) => toToolResult(await handleSearch(input), "Searched published conversations."),
  );

  server.registerTool(
    "clog_browse",
    {
      description: "Browse published tags, projects, or authors.",
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
      description: "A staged or published clog conversation resource.",
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
