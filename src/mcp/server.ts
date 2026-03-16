#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { listHandler, getHandler, updateHandler, browseHandler, searchHandler, resourceHandler } from "./handlers.js";

const server = new McpServer(
  { name: "clog", version: "0.1.0" },
  {
    capabilities: { resources: {}, tools: {} },
    instructions: "clog is a knowledge base of AI coding agent conversations (Claude Code, Codex, etc.). Use it to find context from past sessions — architectural decisions, debugging approaches, solved problems, and domain knowledge. Browse and list to discover conversations, get to read them, update to curate.",
  },
);

const listSchema = {
  tags: z.array(z.string()).optional().describe("Filter by tags (conversations must have at least one of these tags)"),
  project: z.string().optional().describe("Filter by project path"),
  author: z.string().optional().describe("Filter by author name"),
  grep: z.string().optional().describe("Search in title and summary text"),
  origin: z.enum(["local", "remote"]).optional().describe("Filter by origin: 'local' for own conversations, 'remote' for team conversations"),
  limit: z.number().min(1).max(100).default(20).describe("Max results to return (1-100, default 20)"),
  offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
};

server.tool(
  "clog_list_published",
  "Search past AI coding conversations that have been published to the knowledge base. Filter by project, tags, author, or text search.",
  listSchema,
  async (params) => listHandler("published", params),
);

server.tool(
  "clog_list_staged",
  "Find conversations staged for review but not yet published. Use during curation to find conversations needing summaries or tags.",
  listSchema,
  async (params) => listHandler("staged", params),
);

server.tool(
  "clog_get",
  "Read a past AI coding conversation — returns the message thread between human and agent. Works on both staged and published conversations. Use ID prefixes (min 4 chars) from list results.",
  {
    id: z.string().describe("Conversation ID or unique prefix (min 4 chars)"),
    maxMessages: z.number().min(1).max(200).default(20).describe("Max messages to return (default 20)"),
  },
  async (params) => getHandler(params),
);

server.tool(
  "clog_update",
  "Curate a conversation's metadata — set title, summary, or manage tags to make it easier to find. Works on both staged and published conversations.",
  {
    id: z.string().describe("Conversation ID or unique prefix (min 4 chars)"),
    title: z.string().optional().describe("New title for the conversation"),
    summary: z.string().optional().describe("New summary for the conversation"),
    addTags: z.array(z.string()).optional().describe("Tags to add"),
    removeTags: z.array(z.string()).optional().describe("Tags to remove"),
  },
  async (params) => updateHandler(params),
);

server.tool(
  "clog_search",
  "Semantic search across published AI coding conversations using natural language. Returns ranked results by relevance. Requires search to be configured via 'clog search --init'.",
  {
    query: z.string().describe("Natural language search query"),
    tags: z.array(z.string()).optional().describe("Filter by tags (conversations must have at least one of these tags)"),
    project: z.string().optional().describe("Filter by project path"),
    author: z.string().optional().describe("Filter by author name"),
    origin: z.enum(["local", "remote"]).optional().describe("Filter by origin: 'local' for own conversations, 'remote' for team conversations"),
    limit: z.number().min(1).max(50).default(10).describe("Max results (1-50, default 10)"),
  },
  async (params) => searchHandler(params),
);

server.tool(
  "clog_browse",
  "Discover what's in the knowledge base — see all tags, projects, or authors with conversation counts.",
  {
    by: z.enum(["tags", "projects", "authors"]).describe("What to browse: tags, projects, or authors"),
  },
  async (params) => browseHandler(params),
);

server.resource(
  "conversation",
  new ResourceTemplate("clog://conversations/{id}", { list: undefined }),
  { description: "A published clog conversation", mimeType: "application/json" },
  async (uri, variables) => resourceHandler(variables.id as string, uri.href),
);

const transport = new StdioServerTransport();
await server.connect(transport);
