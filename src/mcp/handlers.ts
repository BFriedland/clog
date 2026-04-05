import { withDb } from "../db/index.js";
import { ClaudeCodeAdapter } from "../adapters/claude-code.js";
import { resolveContentPath } from "../sync/resolve-content-path.js";
import {
  isConversationSearchable,
  markConversationIndexStale,
} from "../search/coherence.js";

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
      };
      let searchContentChanged = false;
      let metadataChanged = false;

      if (title !== undefined) {
        if (title !== conv.title) {
          updates.title = title;
          searchContentChanged = true;
          metadataChanged = true;
        }
      }
      if (summary !== undefined) {
        if (summary !== conv.summary) {
          updates.summary = summary;
          searchContentChanged = true;
          metadataChanged = true;
        }
      }

      // Compute new tags: merge existing + addTags, remove removeTags, dedupe, lowercase
      if (addTags || removeTags) {
        const existing = new Set(conv.tags);
        if (addTags) {
          for (const t of addTags) {
            const normalized = t.trim().toLowerCase();
            if (normalized) {
              existing.add(normalized);
            }
          }
        }
        if (removeTags) {
          const toRemove = new Set(
            removeTags
              .map((t) => t.trim().toLowerCase())
              .filter(Boolean),
          );
          for (const t of toRemove) {
            existing.delete(t);
          }
        }
        const nextTags = [...existing];
        if (
          nextTags.length !== conv.tags.length ||
          nextTags.some((tag, index) => tag !== conv.tags[index])
        ) {
          updates.tags = nextTags;
          searchContentChanged = true;
          metadataChanged = true;
        }
      }

      if (!metadataChanged) {
        return {
          id: conv.id,
          title: conv.title,
          summary: conv.summary,
          tags: conv.tags,
          author: conv.author,
          project: conv.project,
          state: conv.state,
          createdAt: conv.createdAt,
          modifiedAt: conv.modifiedAt,
        };
      }

      updates.modifiedAt = new Date().toISOString();
      ctx.updateConversation(fullId, updates);

      if (searchContentChanged) {
        markConversationIndexStale(ctx, conv);
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
        const indexCoverage = await withDb((ctx) => ctx.getIndexCoverage());
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ results: [], totalCount: 0, indexCoverage }, null, 2),
          }],
        };
      }
    }

    const searchableIds = await withDb((ctx) => {
      const convs = ctx.listConversations({ state: "published" });
      return new Set(
        convs
          .filter((conv) => isConversationSearchable(conv))
          .map((conv) => conv.id),
      );
    });

    let scanCapReached = false;
    const searchResults = await searchConversations(
      query,
      limit,
      embedding,
      vectorStore,
      conversationIdFilter,
      undefined,
      (conversationId) => searchableIds.has(conversationId),
      () => {
        scanCapReached = true;
      },
    );

    // Enrich with full metadata from DB and get index coverage
    const { convMap, indexCoverage } = await withDb((ctx) => {
      const map = new Map<string, ReturnType<typeof ctx.getConversation>>();
      for (const r of searchResults) {
        const conv = ctx.getConversation(r.conversationId);
        if (isConversationSearchable(conv)) {
          map.set(r.conversationId, conv);
        }
      }
      return { convMap: map, indexCoverage: ctx.getIndexCoverage() };
    });

    const results = searchResults
      .filter((r) => convMap.has(r.conversationId))
      .map((r) => {
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
        text: JSON.stringify({
          results,
          totalCount: results.length,
          indexCoverage,
          ...(scanCapReached
            ? { warning: "Search hit the maximum scan window; completeness is not guaranteed." }
            : {}),
        }, null, 2),
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
