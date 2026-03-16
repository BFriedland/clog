import { withDb } from "../db/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { resolveContentPath } from "../sync/resolve-content-path.js";

export async function listHandler(
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

export async function getHandler({ id, maxMessages }: { id: string; maxMessages: number }) {
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
}

export async function updateHandler({ id, title, summary, addTags, removeTags }: {
  id: string;
  title?: string;
  summary?: string;
  addTags?: string[];
  removeTags?: string[];
}) {
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
}

export async function browseHandler({ by }: { by: "tags" | "projects" | "authors" }) {
  const items = await withDb((ctx) => ctx.browseDistinct(by));

  return {
    content: [
      {
        type: "text" as const,
        text: JSON.stringify({ items }, null, 2),
      },
    ],
  };
}

export async function searchHandler({ query, tags, project, author, origin, limit }: {
  query: string;
  tags?: string[];
  project?: string;
  author?: string;
  origin?: "local" | "remote";
  limit: number;
}) {
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
}

export async function resourceHandler(id: string, uriHref: string) {
  const conv = await withDb((ctx) => {
    const fullId = ctx.resolveId(id);
    return ctx.getConversation(fullId);
  });

  if (!conv || conv.state !== "published") {
    return {
      contents: [
        {
          uri: uriHref,
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
        uri: uriHref,
        mimeType: "application/json",
        text: JSON.stringify(result, null, 2),
      },
    ],
  };
}
