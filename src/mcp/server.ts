#!/usr/bin/env node

import { McpServer, ResourceTemplate } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { withDb } from "../db/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { resolveContentPath } from "../sync/resolve-content-path.js";

const server = new McpServer(
  { name: "clog", version: "0.1.0" },
  {
    capabilities: { resources: {}, tools: {} },
    instructions: "clog is a knowledge base of AI coding agent conversations (Claude Code, Codex, etc.). Use it to find context from past sessions — architectural decisions, debugging approaches, solved problems, and domain knowledge. Browse and list to discover conversations, get to read them, update to curate.",
  },
);

// ---------------------------------------------------------------------------
// Shared list handler — used by clog_list_published and clog_list_staged
// ---------------------------------------------------------------------------
const listSchema = {
  tags: z.array(z.string()).optional().describe("Filter by tags (conversations must have at least one of these tags)"),
  project: z.string().optional().describe("Filter by project path"),
  author: z.string().optional().describe("Filter by author name"),
  grep: z.string().optional().describe("Search in title and summary text"),
  origin: z.enum(["local", "remote"]).optional().describe("Filter by origin: 'local' for own conversations, 'remote' for team conversations"),
  limit: z.number().min(1).max(100).default(20).describe("Max results to return (1-100, default 20)"),
  offset: z.number().min(0).default(0).describe("Number of results to skip for pagination"),
};

async function listHandler(
  state: "published" | "staged",
  { tags, project, author, grep, origin, limit, offset }: {
    tags?: string[];
    project?: string;
    author?: string;
    grep?: string;
    origin?: "local" | "remote";
    limit: number;
    offset: number;
  },
) {
  const allConversations = await withDb((ctx) =>
    ctx.listConversations({
      state,
      project: project ?? undefined,
      author: author ?? undefined,
      tag: tags?.[0] ?? undefined,
      grep: grep ?? undefined,
      origin: origin ?? undefined,
    }),
  );

  // If multiple tags were requested, filter to conversations that have at least one
  let filtered = allConversations;
  if (tags && tags.length > 1) {
    const tagSet = new Set(tags);
    filtered = allConversations.filter((c) =>
      c.tags.some((t) => tagSet.has(t)),
    );
  }

  const totalCount = filtered.length;
  const page = filtered.slice(offset, offset + limit);

  const conversations = page.map((c) => ({
    id: c.id,
    title: c.title,
    summary: c.summary,
    tags: c.tags,
    author: c.author,
    project: c.project,
    createdAt: c.createdAt,
  }));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ conversations, totalCount }, null, 2),
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// Tool: clog_list_published — list published conversations with optional filters
// ---------------------------------------------------------------------------
server.tool(
  "clog_list_published",
  "Search past AI coding conversations that have been published to the knowledge base. Filter by project, tags, author, or text search.",
  listSchema,
  async (params) => listHandler("published", params),
);

// ---------------------------------------------------------------------------
// Tool: clog_list_staged — list staged conversations awaiting publication
// ---------------------------------------------------------------------------
server.tool(
  "clog_list_staged",
  "Find conversations staged for review but not yet published. Use during curation to find conversations needing summaries or tags.",
  listSchema,
  async (params) => listHandler("staged", params),
);

// ---------------------------------------------------------------------------
// Tool: clog_get — get a staged or published conversation with messages
// ---------------------------------------------------------------------------
server.tool(
  "clog_get",
  "Read a past AI coding conversation — returns the message thread between human and agent. Works on both staged and published conversations. Use ID prefixes (min 4 chars) from list results.",
  {
    id: z.string().describe("Conversation ID or unique prefix (min 4 chars)"),
    maxMessages: z.number().min(1).max(200).default(20).describe("Max messages to return (default 20)"),
  },
  async ({ id, maxMessages }) => {
    const conv = await withDb((ctx) => {
      const fullId = ctx.resolveId(id);
      return ctx.getConversation(fullId);
    });

    if (!conv) {
      return {
        content: [{ type: "text" as const, text: `Conversation "${id}" not found.` }],
        isError: true,
      };
    }

    if (conv.state === "discovered") {
      return {
        content: [{ type: "text" as const, text: `Conversation "${id}" is in discovered state. Stage or publish it first.` }],
        isError: true,
      };
    }

    // Parse messages from the source file
    const adapter = new ClaudeCodeAdapter([]);

    const filePath = resolveContentPath(conv);
    let messages = await adapter.parseMessages(filePath);

    const totalMessages = messages.length;
    let truncated = false;

    if (messages.length > maxMessages) {
      messages = messages.slice(-maxMessages);
      truncated = true;
    }

    const result = {
      id: conv.id,
      title: conv.title,
      summary: conv.summary,
      tags: conv.tags,
      author: conv.author,
      project: conv.project,
      state: conv.state,
      createdAt: conv.createdAt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.toolName ? { toolName: m.toolName } : {}),
      })),
      totalMessages,
      truncated,
      ...(truncated
        ? { truncationNote: `Showing last ${maxMessages} of ${totalMessages} messages. Use maxMessages to see more.` }
        : {}),
    };

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Tool: clog_update — edit metadata on a staged or published conversation
// ---------------------------------------------------------------------------
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
  async ({ id, title, summary, addTags, removeTags }) => {
    try {
      const updated = await withDb((ctx) => {
        const fullId = ctx.resolveId(id);
        const conv = ctx.getConversation(fullId);

        if (!conv) {
          throw new Error(`Conversation "${id}" not found.`);
        }

        if (conv.state === "discovered") {
          throw new Error(`Conversation "${id}" is in discovered state. Stage or publish it first.`);
        }

        if (conv.origin) {
          throw new Error(`Cannot edit a remote conversation (synced from ${conv.origin}).`);
        }

        const updates: Parameters<typeof ctx.updateConversation>[1] = {
          modifiedAt: new Date().toISOString(),
        };

        if (title !== undefined) {
          updates.title = title;
        }
        if (summary !== undefined) {
          updates.summary = summary;
        }

        // Compute new tags: merge existing + addTags, remove removeTags, dedupe, lowercase
        if (addTags || removeTags) {
          const existing = new Set(conv.tags);
          if (addTags) {
            for (const t of addTags) {
              existing.add(t.trim().toLowerCase());
            }
          }
          if (removeTags) {
            const toRemove = new Set(removeTags.map((t) => t.trim().toLowerCase()));
            for (const t of toRemove) {
              existing.delete(t);
            }
          }
          updates.tags = [...existing];
        }

        ctx.updateConversation(fullId, updates);

        // Mark for re-indexing if title/summary changed on a published conversation
        if (
          (title !== undefined || summary !== undefined) &&
          conv.state === "published" &&
          conv.indexedAt
        ) {
          ctx.setIndexedAt(fullId, null);
        }

        // Return updated conversation
        const result = ctx.getConversation(fullId)!;
        return {
          id: result.id,
          title: result.title,
          summary: result.summary,
          tags: result.tags,
          author: result.author,
          project: result.project,
          state: result.state,
          createdAt: result.createdAt,
          modifiedAt: result.modifiedAt,
        };
      });

      return {
        content: [
          {
            type: "text" as const,
            text: JSON.stringify({ conversation: updated }, null, 2),
          },
        ],
      };
    } catch (err) {
      return {
        content: [{ type: "text" as const, text: (err as Error).message }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: clog_search — semantic search across published conversations
// ---------------------------------------------------------------------------
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
  async ({ query, tags, project, author, origin, limit }) => {
    try {
      const { getSearchProviders } = await import("../search/deps.js");
      const { embedding, vectorStore } = await getSearchProviders();
      const { searchConversations } = await import("../search/indexer.js");

      // Pre-filter via SQLite if metadata filters provided
      let conversationIdFilter: Set<string> | undefined;
      if (project || author || origin || (tags && tags.length > 0)) {
        const convs = await withDb((ctx) =>
          ctx.listConversations({
            state: "published",
            project: project ?? undefined,
            author: author ?? undefined,
            tag: tags?.[0] ?? undefined,
            origin: origin ?? undefined,
          }),
        );
        // Multi-tag filter: keep conversations with at least one matching tag
        let filtered = convs;
        if (tags && tags.length > 1) {
          const tagSet = new Set(tags);
          filtered = convs.filter((c) => c.tags.some((t) => tagSet.has(t)));
        }
        conversationIdFilter = new Set(filtered.map((c) => c.id));
        if (conversationIdFilter.size === 0) {
          return {
            content: [{
              type: "text" as const,
              text: JSON.stringify({ results: [], totalCount: 0 }, null, 2),
            }],
          };
        }
      }

      const searchResults = await searchConversations(
        query,
        limit,
        embedding,
        vectorStore,
        conversationIdFilter,
      );

      // Enrich with full metadata from DB and get index coverage
      const { convMap, indexCoverage } = await withDb((ctx) => {
        const map = new Map<string, ReturnType<typeof ctx.getConversation>>();
        for (const r of searchResults) {
          const conv = ctx.getConversation(r.conversationId);
          if (conv) map.set(r.conversationId, conv);
        }
        return { convMap: map, indexCoverage: ctx.getIndexCoverage() };
      });

      const results = searchResults.map((r) => {
        const conv = convMap.get(r.conversationId);
        return {
          id: r.conversationId,
          title: conv?.title ?? "",
          summary: conv?.summary ?? "",
          tags: conv?.tags ?? [],
          author: conv?.author ?? "",
          project: conv?.project ?? null,
          createdAt: conv?.createdAt ?? "",
          relevanceScore: r.score,
          snippet: r.text.slice(0, 300),
        };
      });

      return {
        content: [{
          type: "text" as const,
          text: JSON.stringify({ results, totalCount: results.length, indexCoverage }, null, 2),
        }],
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return {
        content: [{
          type: "text" as const,
          text: `Search error: ${message}`,
        }],
        isError: true,
      };
    }
  },
);

// ---------------------------------------------------------------------------
// Tool: clog_browse — browse distinct tags, projects, or authors
// ---------------------------------------------------------------------------
server.tool(
  "clog_browse",
  "Discover what's in the knowledge base — see all tags, projects, or authors with conversation counts.",
  {
    by: z.enum(["tags", "projects", "authors"]).describe("What to browse: tags, projects, or authors"),
  },
  async ({ by }) => {
    const items = await withDb((ctx) => ctx.browseDistinct(by));

    return {
      content: [
        {
          type: "text" as const,
          text: JSON.stringify({ items }, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Resource: clog://conversations/{id}
// ---------------------------------------------------------------------------
server.resource(
  "conversation",
  new ResourceTemplate("clog://conversations/{id}", { list: undefined }),
  { description: "A published clog conversation", mimeType: "application/json" },
  async (uri, variables) => {
    const id = variables.id as string;

    const conv = await withDb((ctx) => {
      const fullId = ctx.resolveId(id);
      return ctx.getConversation(fullId);
    });

    if (!conv || conv.state !== "published") {
      return {
        contents: [
          {
            uri: uri.href,
            mimeType: "application/json",
            text: JSON.stringify({ error: "Conversation not found or not published" }),
          },
        ],
      };
    }

    const adapter = new ClaudeCodeAdapter([]);

    const filePath = resolveContentPath(conv);
    const messages = await adapter.parseMessages(filePath);

    const result = {
      id: conv.id,
      title: conv.title,
      summary: conv.summary,
      tags: conv.tags,
      author: conv.author,
      project: conv.project,
      createdAt: conv.createdAt,
      messages: messages.map((m) => ({
        role: m.role,
        content: m.content,
        timestamp: m.timestamp,
        ...(m.toolName ? { toolName: m.toolName } : {}),
      })),
      totalMessages: messages.length,
    };

    return {
      contents: [
        {
          uri: uri.href,
          mimeType: "application/json",
          text: JSON.stringify(result, null, 2),
        },
      ],
    };
  },
);

// ---------------------------------------------------------------------------
// Start server
// ---------------------------------------------------------------------------
const transport = new StdioServerTransport();
await server.connect(transport);
