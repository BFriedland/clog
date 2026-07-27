import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import {
  getDefaultEnvironment,
  StdioClientTransport,
} from "@modelcontextprotocol/sdk/client/stdio.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { buildMcpLauncherScript } from "../src/cli/mcp.js";
import { getDefaultConfig, loadConfig, saveConfig } from "../src/config/index.js";
import {
  handleAnalysisSuggestions,
  handleBrowse,
  handleGet,
  handleList,
  handleSearch,
  handleSummarizationGuide,
  handleUpdate,
} from "../src/mcp/handlers.js";
import { createMcpServer } from "../src/mcp/create-server.js";
import { getConversationById } from "../src/db/index.js";
import { SearchNotConfiguredError } from "../src/search/errors.js";
import type {
  EmbeddingProvider,
  SearchHit,
  VectorStore,
} from "../src/search/types.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import { insertConversation } from "./helpers/db.js";
import { writeJsonl } from "./helpers/fixtures.js";

vi.mock("../src/search/deps.js", async () => {
  return {
    getSearchProviders: vi.fn(async () => {
      throw new SearchNotConfiguredError();
    }),
    searchAvailable: vi.fn(async () => false),
    resetSearchProviders: () => undefined,
  };
});

const depsModule = await import("../src/search/deps.js");
const mockedGetSearchProviders = vi.mocked(depsModule.getSearchProviders);

describe("mcp handlers", () => {
  let tempDir: string;
  let sourceDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-mcp-"));
    process.env.CLOG_HOME = tempDir;
    sourceDir = path.join(tempDir, "claude-sources");
    await fs.mkdir(sourceDir, { recursive: true });

    const config = getDefaultConfig("current-author");
    config.sources["claude-code"].paths = [sourceDir];
    config.sources["codex-cli"].enabled = false;
    await saveConfig(config);

    const rawDir = path.join(tempDir, "raw", "claude-code");
    await fs.mkdir(rawDir, { recursive: true });
    const filePath = path.join(rawDir, "abc12345-1234-1234-1234-123456789012.jsonl");

    await writeJsonl(filePath, [
      {
        type: "user",
        timestamp: "2026-02-01T10:00:00.000Z",
        message: { role: "user", content: "Debug auth flow" },
      },
      {
        type: "assistant",
        timestamp: "2026-02-01T10:00:01.000Z",
        message: {
          id: "msg_1",
          role: "assistant",
          content: [{ type: "text", text: "Looking into it." }],
        },
      },
    ]);

    await insertConversation({
      id: "abc12345-1234-1234-1234-123456789012",
      sourceId: "abc12345-1234-1234-1234-123456789012",
      source: "claude-code",
      title: "Debug auth flow",
      summary: "",
      author: "alice",
      projectName: "api-service",
      projectPath: "/tmp/api-service",
      tags: ["auth"],
      slug: null,
      createdAt: "2026-02-01T10:00:00.000Z",
      discoveredAt: "2026-02-01T10:00:00.000Z",
      modifiedAt: "2026-02-01T10:00:00.000Z",
      state: "saved",
      savedAt: "2026-02-01T10:00:02.000Z",
      savedMessageCount: 2,
      saveVersion: 1,
      sourcePath: filePath,
      filePath,
      sourceMtime: null,
      indexedAt: "2026-02-01T10:00:03.000Z",
      originKind: "local",
      originRef: null,
      relationshipInspection: {
        status: "none_found",
        version: 2,
        diagnostic: null,
      },
      relationships: [],
      transcriptProjectionVersion: 2,
    });
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("lists saved conversations", async () => {
    const result = await handleList({});
    expect(result.totalCount).toBe(1);
    expect(result.conversations[0]).toMatchObject({
      source: "claude-code",
      state: "saved",
      sourceMtime: null,
    });
  });

  it("collapses related conversations before pagination and restores them with allBranches", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b1111111-1111-1111-1111-111111111111";
    const unrelatedId = "c2222222-2222-2222-2222-222222222222";
    await insertOtherSaved(childId, {
      title: "Newest branch",
      createdAt: "2026-02-02T10:00:00.000Z",
      sourceMtime: "2026-02-03T10:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: parentId },
        evidence: "source",
        branchPoint: null,
      }],
    });
    await insertOtherSaved(unrelatedId, {
      title: "Unrelated",
      createdAt: "2026-01-01T10:00:00.000Z",
    });

    const collapsed = await handleList({ limit: 1 });
    const expanded = await handleList({ allBranches: true, limit: 10 });

    expect(collapsed).toMatchObject({
      totalCount: 2,
      returnedCount: 1,
      hasMore: true,
      branchView: "collapsed",
    });
    expect(collapsed.conversations[0]).toMatchObject({
      id: childId,
      branchCount: 1,
    });
    expect(collapsed.conversations[0]).not.toHaveProperty("knownRootIdentity");
    expect(collapsed.conversations[0]).not.toHaveProperty("immediateParentIdentity");
    expect(collapsed.conversations[0]).not.toHaveProperty("branchConversationIds");
    expect(collapsed.conversations[0]).not.toHaveProperty("memberCount");
    expect(collapsed.conversations[0]).not.toHaveProperty("relationshipCompleteness");
    expect(expanded.totalCount).toBe(3);
    expect(expanded.branchView).toBe("all_branches");
    expect(expanded.conversations.map((conversation) => conversation.id)).toEqual(
      expect.arrayContaining([parentId, childId, unrelatedId]),
    );
  });

  it("keeps list rows lean while marking unavailable branch history", async () => {
    const childId = "b1222222-1111-4111-8111-111111111111";
    const missingParentId = "b1333333-1111-4111-8111-111111111111";
    await insertOtherSaved(childId, {
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: missingParentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });

    const result = await handleList({ limit: 10 });
    const child = result.conversations.find(
      (conversation) => conversation.id === childId,
    );

    expect(child).toMatchObject({
      relationshipCompleteness: "incomplete",
    });
    expect(child).not.toHaveProperty("immediateParentIdentity");
    expect(child).not.toHaveProperty("immediateParentId");
    expect(child).not.toHaveProperty("branchConversationIds");
  });

  it("returns navigation metadata for the exact requested related conversation", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b3333333-3333-3333-3333-333333333333";
    await insertOtherSaved(childId, {
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: parentId },
        evidence: "source",
        branchPoint: null,
      }],
    });

    const parent = await handleGet({ id: parentId, head: 1 });

    expect(parent).toMatchObject({
      id: parentId,
      immediateParentRelationship: null,
      knownRootIdentity: {
        source: "claude-code",
        sourceId: parentId,
      },
      childIds: [childId],
      branchConversationIds: [parentId, childId].sort(),
      memberCount: 2,
      branchCount: 1,
      relationshipCompleteness: "complete",
      inheritedMessagesMayAppear: true,
    });
  });

  it("reads a linear representative from its opening turn without resolving the root", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b3444444-3333-4333-8333-333333333333";
    const childPath = path.join(tempDir, "raw", "claude-code", `${childId}.jsonl`);
    await writeJsonl(childPath, [
      {
        type: "user",
        uuid: "c3444444-3333-4333-8333-333333333333",
        timestamp: "2026-02-02T09:00:00.000Z",
        sessionId: childId,
        message: { role: "user", content: "Original prompt copied into the branch" },
      },
      {
        type: "user",
        uuid: "d3444444-3333-4333-8333-333333333333",
        timestamp: "2026-02-02T10:00:00.000Z",
        sessionId: childId,
        message: { role: "user", content: "Continue the branch" },
      },
    ]);
    await insertOtherSaved(childId, {
      sourcePath: childPath,
      filePath: childPath,
      savedMessageCount: 2,
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: parentId },
        evidence: "source",
        branchPoint: null,
      }],
    });

    const child = await handleGet({ id: childId, head: 1 });

    expect(child).toMatchObject({
      id: childId,
      inheritedMessagesMayAppear: true,
      messages: [{
        role: "user",
        content: "Original prompt copied into the branch",
      }],
      range: {
        startIndex: 0,
        endIndex: 1,
      },
    });
  });

  it("uses the current graph relationship when saved inspection is stale", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b3555555-3333-4333-8333-333333333333";
    const childPath = path.join(
      sourceDir,
      "project",
      `${childId}.jsonl`,
    );
    await writeJsonl(childPath, [
      {
        type: "assistant",
        uuid: "c3555555-3333-4333-8333-333333333333",
        timestamp: "2026-02-02T09:00:00.000Z",
        sessionId: childId,
        forkedFrom: {
          sessionId: parentId,
          messageUuid: "c3555555-3333-4333-8333-333333333333",
        },
      },
      {
        type: "user",
        uuid: "d3555555-3333-4333-8333-333333333333",
        timestamp: "2026-02-02T10:00:00.000Z",
        sessionId: childId,
        cwd: "/tmp/api-service",
        message: { role: "user", content: "Continue the saved branch" },
      },
    ]);
    await insertOtherSaved(childId, {
      sourcePath: childPath,
      filePath: childPath,
      relationshipInspection: {
        status: "unexamined",
        version: null,
        diagnostic: null,
      },
      relationships: [],
    });

    const child = await handleGet({ id: childId, head: 1 });

    expect(child).toMatchObject({
      id: childId,
      immediateParentRelationship: {
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      },
      knownRootIdentity: {
        source: "claude-code",
        sourceId: parentId,
      },
      branchConversationIds: [parentId, childId].sort(),
    });
  });

  it("reports known unsaved relatives without returning IDs that get_conversation cannot open", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b4444444-4444-4444-8444-444444444444";
    await writeJsonl(path.join(sourceDir, "project", `${childId}.jsonl`), [
      {
        type: "assistant",
        uuid: "c4444444-4444-4444-8444-444444444444",
        timestamp: "2026-02-02T09:00:00.000Z",
        sessionId: childId,
        forkedFrom: {
          sessionId: parentId,
          messageUuid: "c4444444-4444-4444-8444-444444444444",
        },
      },
      {
        type: "user",
        uuid: "d4444444-4444-4444-8444-444444444444",
        timestamp: "2026-02-02T10:00:00.000Z",
        sessionId: childId,
        cwd: "/tmp/api-service",
        message: { role: "user", content: "Continue on the unsaved branch" },
      },
    ]);

    const parent = await handleGet({ id: parentId, head: 1 });

    expect(parent).toMatchObject({
      id: parentId,
      childIds: [],
      branchConversationIds: [parentId],
      memberCount: 1,
      branchCount: 1,
      relationshipCompleteness: "complete",
      hasMoreMemberConversations: true,
      inheritedMessagesMayAppear: true,
    });
    await expect(handleGet({ id: childId, head: 1 })).rejects.toThrow(
      "get_conversation only works on saved conversations",
    );
  });

  it("leaves the current-schema database byte-identical across every non-writing MCP tool", async () => {
    const dbPath = path.join(tempDir, "clog.db");
    const before = await fs.readFile(dbPath);
    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore([]),
    });

    await handleList({ state: "all" });
    await handleGet({ id: "abc12345-1234-1234-1234-123456789012" });
    await handleBrowse({ by: "tags" });
    await handleSearch({ query: "auth" });
    await handleSummarizationGuide();
    await handleAnalysisSuggestions();

    await expect(fs.readFile(dbPath)).resolves.toEqual(before);
  });

  it("registers the public tool names and list_conversations state schema", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "clog-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const { tools } = await client.listTools();
      const names = tools.map((tool) => tool.name);
      expect(names).toContain("list_conversations");
      expect(names).toContain("get_conversation");
      expect(names).toContain("update_conversation");
      expect(names).toContain("search_conversations");
      expect(names).toContain("browse_metadata");
      expect(names).toContain("summarization_guide");
      expect(names).toContain("analysis_suggestions");

      const listTool = tools.find((tool) => tool.name === "list_conversations");
      expect(listTool?.inputSchema).toMatchObject({
        properties: {
          state: {
            type: "string",
            enum: ["saved", "unsaved", "all"],
            default: "saved",
          },
        },
      });
      expect(listTool?.outputSchema).toMatchObject({
        properties: {
          conversations: {
            type: "array",
            items: {
              properties: {
                id: { type: "string" },
                branchCount: { type: "integer" },
                relationshipCompleteness: {
                  type: "string",
                  enum: ["incomplete", "invalid"],
                },
              },
            },
          },
          branchView: {
            type: "string",
            enum: ["collapsed", "all_branches"],
          },
        },
      });

      const getTool = tools.find((tool) => tool.name === "get_conversation");
      expect(getTool?.outputSchema).toMatchObject({
        properties: {
          id: { type: "string" },
          knownRootIdentity: { type: "object" },
          branchConversationIds: {
            type: "array",
            items: { type: "string" },
          },
          relationshipCompleteness: {
            type: "string",
            enum: ["complete", "incomplete", "invalid"],
          },
        },
      });

      const searchTool = tools.find((tool) => tool.name === "search_conversations");
      expect(searchTool?.inputSchema).toMatchObject({
        properties: {
          project: {
            description: "Filter by project using case-insensitive substring matching.",
          },
          author: {
            description: "Filter by author metadata using case-insensitive substring matching.",
          },
          origin: {
            description: "Use local for locally writable rows, remote for imported read-only rows.",
          },
          limit: {
            default: 10,
          },
        },
      });
      expect(searchTool?.outputSchema).toMatchObject({
        properties: {
          results: {
            type: "array",
            items: {
              properties: {
                id: { type: "string" },
                snippetConversationId: { type: "string" },
                branchCount: { type: "integer" },
              },
            },
          },
        },
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("validates branch-rich list and search responses through the MCP SDK", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const firstChildId = "b3666666-3333-4333-8333-333333333333";
    const secondChildId = "b3777777-3333-4333-8333-333333333333";
    for (const [id, createdAt] of [
      [firstChildId, "2026-02-02T10:00:00.000Z"],
      [secondChildId, "2026-02-03T10:00:00.000Z"],
    ] as const) {
      await insertOtherSaved(id, {
        createdAt,
        relationshipInspection: {
          status: "linked",
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch",
          parent: {
            source: "claude-code",
            sourceId: parentId,
          },
          evidence: "source",
          branchPoint: null,
        }],
      });
    }

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore([
        {
          id: `${firstChildId}:0`,
          score: 0.8,
          text: "first branch match",
          metadata: { conversationId: firstChildId },
        },
        {
          id: `${secondChildId}:0`,
          score: 0.9,
          text: "second branch match",
          metadata: { conversationId: secondChildId },
        },
      ]),
    });

    const server = createMcpServer();
    const client = new Client({ name: "clog-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const collapsedList = await client.callTool({
        name: "list_conversations",
        arguments: {},
      });
      expect(collapsedList.isError).not.toBe(true);
      expect(collapsedList.structuredContent).toMatchObject({
        branchView: "collapsed",
        conversations: [{
          id: secondChildId,
          branchCount: 2,
        }],
      });

      const expandedList = await client.callTool({
        name: "list_conversations",
        arguments: { allBranches: true },
      });
      expect(expandedList.isError).not.toBe(true);
      expect(expandedList.structuredContent).toMatchObject({
        branchView: "all_branches",
        conversations: expect.arrayContaining([
          expect.objectContaining({
            id: parentId,
            branchCount: 2,
            branchStatus: "superseded",
          }),
          expect.objectContaining({
            id: firstChildId,
            branchCount: 2,
            branchStatus: "live",
          }),
        ]),
      });

      const search = await client.callTool({
        name: "search_conversations",
        arguments: { query: "branch" },
      });
      expect(search.isError).not.toBe(true);
      expect(search.structuredContent).toMatchObject({
        branchView: "collapsed",
        results: [{
          id: secondChildId,
          snippetConversationId: secondChildId,
          knownRootIdentity: {
            source: "claude-code",
            sourceId: parentId,
          },
          memberCount: 3,
          branchCount: 2,
          relationshipCompleteness: "complete",
        }],
      });
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("rejects unknown parameters for every parameterized tool", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "clog-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    // One resolution is enough: unknown-key calls fail validation before the
    // handler runs, so only the valid search_conversations call fetches providers.
    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore([]),
    });

    const validCalls: Array<{
      name: string;
      arguments: Record<string, unknown>;
    }> = [
      { name: "list_conversations", arguments: {} },
      { name: "get_conversation", arguments: { id: "abc12345" } },
      {
        name: "update_conversation",
        arguments: { id: "abc12345", title: "Debug auth flow" },
      },
      { name: "browse_metadata", arguments: { by: "tags" } },
      { name: "search_conversations", arguments: { query: "auth" } },
    ];

    try {
      for (const validCall of validCalls) {
        const invalidResult = await client.callTool({
          name: validCall.name,
          arguments: {
            ...validCall.arguments,
            unexpectedParameter: true,
          },
        });

        expect(invalidResult.isError, validCall.name).toBe(true);
        expect(invalidResult.content, validCall.name).toEqual([
          expect.objectContaining({
            type: "text",
            text: expect.stringContaining("unexpectedParameter"),
          }),
        ]);

        const validResult = await client.callTool(validCall);
        expect(validResult.isError, validCall.name).not.toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("calls no-parameter tools without an arguments field", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "clog-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      for (const name of ["summarization_guide", "analysis_suggestions"]) {
        const result = await client.callTool({ name });
        expect(result.isError, name).not.toBe(true);
      }
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("exposes server instructions and retrieval-oriented tool metadata", async () => {
    const server = createMcpServer();
    const client = new Client({ name: "clog-test-client", version: "1.0.0" });
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

    await Promise.all([
      server.connect(serverTransport),
      client.connect(clientTransport),
    ]);

    try {
      const instructions = client.getInstructions();
      expect(instructions).toBeDefined();
      // Codex docs recommend the first ~512 characters be self-contained;
      // clog keeps the whole instructions string within that budget.
      expect(instructions!.length).toBeLessThanOrEqual(512);
      expect(instructions).toContain("Claude Code and Codex");
      expect(instructions).toContain("summarize and analyze");

      const { tools } = await client.listTools();
      for (const tool of tools) {
        expect(tool.title, `title for ${tool.name}`).toBeTruthy();
        expect(tool.description, `description for ${tool.name}`).toBeTruthy();
      }

      const byName = new Map(tools.map((tool) => [tool.name, tool]));
      expect(byName.get("list_conversations")?.description).toContain("literal-text");
      expect(byName.get("search_conversations")?.description).toContain("meaning");
      expect(byName.get("get_conversation")?.description).toContain("saved");
    } finally {
      await client.close();
      await server.close();
    }
  });

  it("registers a deterministic tool inventory across server constructions", async () => {
    const inventories: string[] = [];

    for (let i = 0; i < 2; i += 1) {
      const server = createMcpServer();
      const client = new Client({ name: "clog-test-client", version: "1.0.0" });
      const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();

      await Promise.all([
        server.connect(serverTransport),
        client.connect(clientTransport),
      ]);

      try {
        const { tools } = await client.listTools();
        inventories.push(JSON.stringify(tools));
      } finally {
        await client.close();
        await server.close();
      }
    }

    expect(inventories[0]).toBe(inventories[1]);
  });

  it("retrieves branch navigation metadata through the stdio MCP launcher", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "b3888888-3333-4333-8333-333333333333";
    await insertOtherSaved(childId, {
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: parentId },
        evidence: "source",
        branchPoint: null,
      }],
    });
    const serverPath = fileURLToPath(new URL("../dist/mcp/server.js", import.meta.url));
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: ["-e", buildMcpLauncherScript(serverPath)],
      env: {
        ...getDefaultEnvironment(),
        CLOG_HOME: tempDir,
      },
      stderr: "pipe",
    });
    const client = new Client({ name: "clog-launcher-test-client", version: "1.0.0" });

    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((tool) => tool.name)).toContain("list_conversations");
      expect(tools.find((tool) => tool.name === "get_conversation")?.outputSchema)
        .toMatchObject({
          properties: {
            branchConversationIds: {
              type: "array",
              items: { type: "string" },
            },
          },
        });

      const result = await client.callTool({
        name: "get_conversation",
        arguments: { id: parentId, head: 1 },
      });
      expect(result.isError).not.toBe(true);
      expect(result.structuredContent).toMatchObject({
        id: parentId,
        childIds: [childId],
        branchConversationIds: [parentId, childId].sort(),
        memberCount: 2,
        branchCount: 1,
        relationshipCompleteness: "complete",
      });
    } finally {
      await client.close();
    }
  });

  it("rejects legacy and unknown list state values", async () => {
    await expect(handleList({ state: "discovered" })).rejects.toThrow();
    await expect(handleList({ state: "archived" })).rejects.toThrow();
  });

  it("scans on demand and lists saved, unsaved, or both lifecycle states", async () => {
    const firstId = "a1000000-0000-0000-0000-000000000001";
    await writeUnsavedClaudeConversation(sourceDir, firstId, {
      title: "First unsaved conversation",
    });

    const defaultResult = await handleList({});
    expect(defaultResult.conversations.map((conversation) => conversation.id)).not.toContain(firstId);

    const unsaved = await handleList({ state: "unsaved" });
    expect(unsaved.conversations).toHaveLength(1);
    expect(unsaved.conversations[0]).toMatchObject({
      id: firstId,
      state: "unsaved",
      author: "current-author",
      tags: [],
      extraction: null,
      savedAt: null,
      savedMessageCount: null,
      originKind: "local",
      originRef: null,
    });
    expect(unsaved.conversations[0]?.modifiedAt).toBe(unsaved.conversations[0]?.sourceMtime);
    await expect(handleGet({ id: firstId.slice(0, 8) })).rejects.toThrow(/saved/);
    await expect(handleUpdate({ id: firstId.slice(0, 8), title: "No write" })).rejects.toThrow(
      /saved/,
    );

    const secondId = "a1000000-0000-0000-0000-000000000002";
    await writeUnsavedClaudeConversation(sourceDir, secondId, {
      title: "Created after the first scan",
    });

    const all = await handleList({ state: "all", limit: 10 });
    expect(new Set(all.conversations.map((conversation) => conversation.state))).toEqual(
      new Set(["saved", "unsaved"]),
    );
    expect(all.conversations.map((conversation) => conversation.id)).toContain(secondId);
  });

  it("normalizes unsaved metadata before filtering", async () => {
    const id = "a2000000-0000-0000-0000-000000000001";
    await writeUnsavedClaudeConversation(sourceDir, id, {
      title: "Investigate payment retries",
      projectName: "Mobile API",
      assistantText: "The hidden transcript needle is retry-budget.",
    });
    await handleList({ state: "unsaved" });

    const config = await loadConfig();
    config.author = "New Current Author";
    config.defaultTags = ["configured-tag"];
    await saveConfig(config);

    const byAuthor = await handleList({ state: "unsaved", author: "current auth" });
    expect(byAuthor.conversations.map((conversation) => conversation.id)).toEqual([id]);
    expect(byAuthor.conversations[0]?.tags).toEqual([]);

    const byProject = await handleList({ state: "unsaved", project: "mobile" });
    expect(byProject.conversations.map((conversation) => conversation.id)).toEqual([id]);

    const byTranscript = await handleList({ state: "unsaved", grep: "retry-budget" });
    expect(byTranscript.conversations.map((conversation) => conversation.id)).toEqual([id]);

    expect((await handleList({ state: "unsaved", tags: ["configured-tag"] })).totalCount).toBe(0);
    expect((await handleList({ state: "unsaved", origin: "remote" })).totalCount).toBe(0);
  });

  it("collapses literal matches through a nonmatching parent", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const firstId = "a2100000-0000-0000-0000-000000000001";
    const secondId = "a2200000-0000-0000-0000-000000000001";
    for (const [id, createdAt] of [
      [firstId, "2026-02-02T00:00:00.000Z"],
      [secondId, "2026-02-03T00:00:00.000Z"],
    ] as const) {
      await insertOtherSaved(id, {
        title: `literal branch needle ${id}`,
        createdAt,
        relationshipInspection: {
          status: "linked",
          version: 2,
          diagnostic: null,
        },
        relationships: [{
          kind: "branch",
          parent: {
            source: "claude-code",
            sourceId: parentId,
          },
          evidence: "source",
          branchPoint: null,
        }],
      });
    }

    const collapsed = await handleList({
      grep: "literal branch needle",
      limit: 10,
    });
    expect(collapsed.conversations).toHaveLength(1);
    expect(collapsed.conversations[0]?.branchCount).toBe(2);

    const expanded = await handleList({
      grep: "literal branch needle",
      allBranches: true,
      limit: 10,
    });
    expect(expanded.conversations).toHaveLength(2);
  });

  it("searches superseded literal content only when allBranches is true", async () => {
    const parentId = "a2300000-0000-0000-0000-000000000001";
    const childId = "a2400000-0000-0000-0000-000000000001";
    await insertOtherSaved(parentId, {
      title: "Unique abandoned literal",
      createdAt: "2026-01-01T00:00:00.000Z",
      sourceMtime: "2026-01-01T00:00:00.000Z",
    });
    await insertOtherSaved(childId, {
      title: "Current child",
      createdAt: "2026-01-02T00:00:00.000Z",
      sourceMtime: "2026-01-02T00:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });

    const defaultResult = await handleList({
      grep: "unique abandoned literal",
    });
    expect(defaultResult.conversations).toEqual([]);

    const expanded = await handleList({
      grep: "unique abandoned literal",
      allBranches: true,
    });
    expect(expanded.conversations).toEqual([
      expect.objectContaining({
        id: parentId,
        branchStatus: "superseded",
      }),
    ]);
  });

  it("reports branch status as unproven when relationship data contains a cycle", async () => {
    const firstId = "a2500000-0000-0000-0000-000000000001";
    const secondId = "a2500000-0000-0000-0000-000000000002";
    const linkedInspection = {
      status: "linked" as const,
      version: 2,
      diagnostic: null,
    };
    await insertOtherSaved(firstId, {
      relationshipInspection: linkedInspection,
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: secondId },
        evidence: "source",
        branchPoint: null,
      }],
    });
    await insertOtherSaved(secondId, {
      relationshipInspection: linkedInspection,
      relationships: [{
        kind: "branch",
        parent: { source: "claude-code", sourceId: firstId },
        evidence: "source",
        branchPoint: null,
      }],
    });

    const result = await handleList({ allBranches: true, limit: 10 });
    for (const id of [firstId, secondId]) {
      expect(result.conversations.find((conversation) => conversation.id === id))
        .toMatchObject({
          branchStatus: "unproven",
          relationshipCompleteness: "invalid",
        });
    }
  });

  it("places unsaved savedAt values last in both sort directions", async () => {
    await writeUnsavedClaudeConversation(
      sourceDir,
      "a3000000-0000-0000-0000-000000000001",
      { title: "Unsaved sort row" },
    );

    for (const sortDirection of ["asc", "desc"] as const) {
      const result = await handleList({
        state: "all",
        sortBy: "savedAt",
        sortDirection,
        limit: 10,
      });
      expect(result.conversations.at(-1)?.state).toBe("unsaved");
    }
  });

  it("filters, stably sorts, and paginates one normalized mixed-state population", async () => {
    const savedId = "a7000000-0000-0000-0000-000000000001";
    const firstUnsavedId = "a8000000-0000-0000-0000-000000000001";
    const secondUnsavedId = "a9000000-0000-0000-0000-000000000001";
    await insertOtherSaved(savedId, { author: "current-author" });
    await writeUnsavedClaudeConversation(sourceDir, firstUnsavedId, {
      title: "First unsaved page row",
    });
    await writeUnsavedClaudeConversation(sourceDir, secondUnsavedId, {
      title: "Second unsaved page row",
    });

    const firstPage = await handleList({
      state: "all",
      author: "current-author",
      sortBy: "createdAt",
      sortDirection: "desc",
      limit: 2,
    });
    const secondPage = await handleList({
      state: "all",
      author: "current-author",
      sortBy: "createdAt",
      sortDirection: "desc",
      limit: 2,
      offset: firstPage.nextOffset,
    });

    expect(firstPage).toMatchObject({
      totalCount: 3,
      returnedCount: 2,
      hasMore: true,
      nextOffset: 2,
    });
    expect(firstPage.conversations.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: savedId, state: "saved" },
      { id: firstUnsavedId, state: "unsaved" },
    ]);
    expect(firstPage.conversations[1]?.author).toBe("current-author");
    expect(secondPage).toMatchObject({
      totalCount: 3,
      returnedCount: 1,
      hasMore: false,
    });
    expect(secondPage.conversations.map(({ id, state }) => ({ id, state }))).toEqual([
      { id: secondUnsavedId, state: "unsaved" },
    ]);
  });

  it("sorts unsaved conversations by source mtime-derived modifiedAt values", async () => {
    const olderId = "a4000000-0000-0000-0000-000000000001";
    const newerId = "a4000000-0000-0000-0000-000000000002";
    const olderPath = await writeUnsavedClaudeConversation(sourceDir, olderId, {
      title: "Older modified conversation",
    });
    const newerPath = await writeUnsavedClaudeConversation(sourceDir, newerId, {
      title: "Newer modified conversation",
    });
    const olderTimestamp = new Date("2025-12-01T12:00:00.000Z");
    const newerTimestamp = new Date("2025-12-02T12:00:00.000Z");
    await fs.utimes(olderPath, olderTimestamp, olderTimestamp);
    await fs.utimes(newerPath, newerTimestamp, newerTimestamp);
    const olderMtime = (await fs.stat(olderPath)).mtime.toISOString();
    const newerMtime = (await fs.stat(newerPath)).mtime.toISOString();

    const ascending = await handleList({
      state: "unsaved",
      sortBy: "modifiedAt",
      sortDirection: "asc",
    });
    const descending = await handleList({
      state: "unsaved",
      sortBy: "modifiedAt",
      sortDirection: "desc",
    });

    expect(
      ascending.conversations.map(({ id, modifiedAt, sourceMtime }) => ({
        id,
        modifiedAt,
        sourceMtime,
      })),
    ).toEqual([
      { id: olderId, modifiedAt: olderMtime, sourceMtime: olderMtime },
      { id: newerId, modifiedAt: newerMtime, sourceMtime: newerMtime },
    ]);
    expect(descending.conversations.map((conversation) => conversation.id)).toEqual([
      newerId,
      olderId,
    ]);
  });

  it("returns collapsed scan warnings in the top-level warnings array", async () => {
    await writeMalformedClaudeConversation(
      sourceDir,
      "a5000000-0000-0000-0000-000000000001",
    );
    await writeMalformedClaudeConversation(
      sourceDir,
      "a5000000-0000-0000-0000-000000000002",
    );

    const result = await handleList({ state: "unsaved" });

    expect(result.warnings).toEqual([
      expect.objectContaining({
        code: "malformed_jsonl",
        message: "Skipping malformed Claude Code conversation file. (2 occurrences)",
      }),
    ]);
  });

  it("does not rewrite saved curation metadata during an all-state scan", async () => {
    const id = "a6000000-0000-0000-0000-000000000001";
    const sourcePath = await writeUnsavedClaudeConversation(sourceDir, id, {
      title: "Scanner title that must not replace curation",
      projectName: "scanner-project",
    });
    await insertOtherSaved(id, {
      title: "Curated saved title",
      summary: "Curated saved summary",
      summaryKind: "curated",
      summaryExtraction: { topics: ["curated-topic"] },
      author: "saved-author",
      tags: ["saved-tag"],
      projectName: "curated-project",
      sourcePath,
      sourceMtime: "2025-01-01T00:00:00.000Z",
    });

    const result = await handleList({ state: "all", limit: 10 });
    const saved = result.conversations.find((conversation) => conversation.id === id);

    expect(saved).toMatchObject({
      state: "saved",
      title: "Curated saved title",
      summary: "Curated saved summary",
      extraction: { topics: ["curated-topic"] },
      author: "saved-author",
      tags: ["saved-tag"],
      project: "curated-project",
    });
  });

  it("gets a conversation with parsed messages", async () => {
    const result = await handleGet({ id: "abc12345", tail: 20 });
    expect(result.totalMessages).toBe(2);
    expect(result.messages[0]?.content).toBe("Debug auth flow");
    expect(result.project).toBe("api-service");
    expect(result).not.toHaveProperty("projectName");
    expect(result).toMatchObject({
      originKind: "local",
      originRef: null,
    });
    expect(result).not.toHaveProperty("origin");
    expect(result.range).toMatchObject({
      mode: "tail",
      startIndex: 0,
      endIndex: 2,
      returnedMessages: 2,
      pageSize: 20,
      hasMoreBefore: false,
      hasMoreAfter: false,
    });
  });

  it("returns clog-style guidance when content is missing", async () => {
    await fs.rm(path.join(tempDir, "raw", "claude-code", "abc12345-1234-1234-1234-123456789012.jsonl"));

    await expect(handleGet({ id: "abc12345", tail: 20 })).rejects.toThrow(
      'Curated raw file is missing for abc12345-1234-1234-1234-123456789012. Run "clog save abc12345" to recreate it from source if the source file is still available.',
    );
  });

  it("includes a request-more truncation note when get_conversation is truncated", async () => {
    const result = await handleGet({ id: "abc12345", tail: 1 });
    expect(result.truncated).toBe(true);
    expect(result.truncationNote).toContain("Request head or offset/limit");
  });

  it("updates metadata and tags", async () => {
    const result = await handleUpdate({
      id: "abc12345",
      title: "Updated title",
      addTags: ["debugging"],
    });

    expect(result.conversation.title).toBe("Updated title");
    expect(result.conversation.tags).toContain("debugging");
    expect(result.conversation.project).toBe("api-service");
    expect(result.conversation).not.toHaveProperty("projectName");
  });

  it("leaves indexedAt unchanged for tag-only updates", async () => {
    await handleUpdate({
      id: "abc12345",
      addTags: ["debugging"],
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBe("2026-02-01T10:00:03.000Z");
  });

  it("clears indexedAt after a metadata edit when search is not configured", async () => {
    await handleUpdate({
      id: "abc12345",
      title: "Updated title",
    });

    const conversation = await getConversationById("abc12345-1234-1234-1234-123456789012");
    expect(conversation?.indexedAt).toBeNull();
  });

  it("leaves modifiedAt unchanged for no-op updates", async () => {
    const before = await getConversationById("abc12345-1234-1234-1234-123456789012");
    const result = await handleUpdate({
      id: "abc12345",
      title: "Debug auth flow",
      addTags: ["auth"],
    });
    const after = await getConversationById("abc12345-1234-1234-1234-123456789012");

    expect(result.conversation.modifiedAt).toBe(before?.modifiedAt);
    expect(after?.modifiedAt).toBe(before?.modifiedAt);
  });

  it("returns scan warnings from successful no-op updates", async () => {
    await writeMalformedClaudeConversation(
      sourceDir,
      "abc50000-0000-0000-0000-000000000001",
    );

    const result = await handleUpdate({
      id: "abc12345",
      title: "Debug auth flow",
      addTags: ["auth"],
    });

    expect(result.warnings).toEqual([
      expect.objectContaining({ code: "malformed_jsonl" }),
    ]);
  });

  it("browses distinct values", async () => {
    const tags = await handleBrowse({ by: "tags" });
    const authors = await handleBrowse({ by: "authors" });
    expect(tags.items).toEqual([{ name: "auth", count: 1 }]);
    expect(authors.items).toEqual([{ name: "alice", count: 1 }]);
  });

  it("filters list_conversations by origin", async () => {
    // Add an imported row so we have one of each.
    await insertConversation({
      id: "def45678-1234-1234-1234-123456789012",
      sourceId: "def45678-1234-1234-1234-123456789012",
      source: "claude-code",
      title: "From remote",
      summary: "",
      author: "bob",
      projectName: null,
      projectPath: null,
      tags: [],
      slug: null,
      createdAt: "2026-02-02T10:00:00.000Z",
      discoveredAt: "2026-02-02T10:00:00.000Z",
      modifiedAt: "2026-02-02T10:00:00.000Z",
      state: "saved",
      savedAt: "2026-02-02T10:00:00.000Z",
      savedMessageCount: 1,
      saveVersion: 1,
      sourcePath: "/tmp/remote.jsonl",
      filePath: "/tmp/remote.jsonl",
      sourceMtime: null,
      indexedAt: null,
      originKind: "git",
      originRef: "git@github.com:myorg/clog-team.git",
    });

    const all = await handleList({});
    expect(all.totalCount).toBe(2);

    const local = await handleList({ origin: "local" });
    expect(local.totalCount).toBe(1);
    expect(local.conversations[0]?.title).toBe("Debug auth flow");

    const remote = await handleList({ origin: "remote" });
    expect(remote.totalCount).toBe(1);
    expect(remote.conversations[0]?.title).toBe("From remote");
    expect(remote.conversations[0]).toMatchObject({
      originKind: "git",
      originRef: "git@github.com:myorg/clog-team.git",
    });
    expect(remote.conversations[0]).not.toHaveProperty("origin");
  });

  // ============================================================
  // Additional list filters
  // ============================================================

  it("filters by tags (OR semantics)", async () => {
    await insertOtherSaved("b1111111-1111-1111-1111-111111111111", {
      title: "Has rate-limit",
      tags: ["rate-limiting"],
    });

    const hits = await handleList({ tags: ["auth"] });
    expect(hits.totalCount).toBe(1);
    expect(hits.conversations[0]?.title).toBe("Debug auth flow");

    const multi = await handleList({ tags: ["rate-limiting", "auth"] });
    expect(multi.totalCount).toBe(2);
  });

  it("filters by project and author", async () => {
    await insertOtherSaved("b2222222-2222-2222-2222-222222222222", {
      title: "Other service",
      author: "Bob Xander",
      projectName: "Mobile API",
    });

    const byProject = await handleList({ project: "API" });
    expect(byProject.totalCount).toBe(2);
    expect(byProject.conversations.map((conversation) => conversation.project)).toEqual([
      "api-service",
      "Mobile API",
    ]);

    const combined = await handleList({ project: "mobile", author: "xand" });
    expect(combined.totalCount).toBe(1);
    expect(combined.conversations[0]?.project).toBe("Mobile API");

    const exactish = await handleList({ project: "api-service" });
    expect(exactish.totalCount).toBe(1);
    expect(exactish.conversations[0]?.project).toBe("api-service");

    const byAuthor = await handleList({ author: "BOB" });
    expect(byAuthor.totalCount).toBe(1);
    expect(byAuthor.conversations[0]?.author).toBe("Bob Xander");
  });

  it("filters saved conversations by project and author substrings", async () => {
    await insertOtherSaved("b2a2a2a2-2222-2222-2222-222222222222", {
      title: "Saved mobile API",
      author: "Xander",
      projectName: "Mobile API",
      state: "saved",
    });

    const result = await handleList({ project: "mobile", author: "xand" });
    expect(result.totalCount).toBe(1);
    expect(result.conversations[0]?.title).toBe("Saved mobile API");
  });

  it("keeps project filter from matching null projects", async () => {
    await insertOtherSaved("b2b2b2b2-2222-2222-2222-222222222222", {
      title: "No project",
      projectName: null,
    });

    const byProject = await handleList({ project: "api" });
    expect(byProject.totalCount).toBe(1);
    expect(byProject.conversations[0]?.project).toBe("api-service");
  });

  it("filters by grep against title and summary", async () => {
    await insertOtherSaved("b3333333-3333-3333-3333-333333333333", {
      title: "Unrelated chat",
      summary: "JWT token refresh discussion",
    });

    const byTitle = await handleList({ grep: "debug auth" });
    expect(byTitle.conversations.map((c) => c.title)).toContain("Debug auth flow");

    const bySummary = await handleList({ grep: "jwt" });
    expect(bySummary.conversations.map((c) => c.title)).toContain("Unrelated chat");
  });

  it("supports limit and offset pagination", async () => {
    for (let i = 0; i < 5; i++) {
      await insertOtherSaved(`b4${i}${i}${i}${i}${i}${i}${i}-4444-4444-4444-444444444444`, {
        title: `Row ${i}`,
      });
    }

    const first = await handleList({ limit: 3, offset: 0 });
    expect(first.conversations).toHaveLength(3);
    expect(first.totalCount).toBe(6); // the original + 5 new
    expect(first).toMatchObject({
      limit: 3,
      offset: 0,
      sortBy: "createdAt",
      sortDirection: "desc",
      returnedCount: 3,
      hasMore: true,
      nextOffset: 3,
    });
    expect(first.paginationNote).toContain("Request offset 3 with limit 3");

    const second = await handleList({ limit: 3, offset: 3 });
    expect(second.conversations).toHaveLength(3);
    expect(second).toMatchObject({
      limit: 3,
      offset: 3,
      sortBy: "createdAt",
      sortDirection: "desc",
      returnedCount: 3,
      hasMore: false,
    });
    expect(second.nextOffset).toBeUndefined();
    expect(second.paginationNote).toBeUndefined();
  });

  it("sorts list results and returns cheap metadata fields", async () => {
    await insertOtherSaved("b5a5a5a5-5555-5555-5555-555555555555", {
      title: "Zulu",
      author: "sorter",
      projectName: "Sort Project",
      modifiedAt: "2026-02-03T10:00:00.000Z",
      savedAt: "2026-02-03T10:00:00.000Z",
      savedMessageCount: 7,
    });
    await insertOtherSaved("b5b5b5b5-5555-5555-5555-555555555555", {
      title: "Alpha",
      author: "sorter",
      projectName: "Sort Project",
      modifiedAt: "2026-02-02T10:00:00.000Z",
      savedAt: "2026-02-02T10:00:00.000Z",
      savedMessageCount: 3,
    });

    const result = await handleList({
      author: "sort",
      sortBy: "title",
      sortDirection: "asc",
    });

    expect(result).toMatchObject({
      sortBy: "title",
      sortDirection: "asc",
      totalCount: 2,
    });
    expect(result.conversations.map((conversation) => conversation.title)).toEqual([
      "Alpha",
      "Zulu",
    ]);
    expect(result.conversations[0]).toMatchObject({
      project: "Sort Project",
      modifiedAt: "2026-02-02T10:00:00.000Z",
      savedAt: "2026-02-02T10:00:00.000Z",
      savedMessageCount: 3,
    });
    expect(result.conversations[0]).not.toHaveProperty("projectName");
  });

  // ============================================================
  // get_conversation edge cases
  // ============================================================

  it("get_conversation defaults to the last 20 messages and reports range metadata", async () => {
    const id = "c1000000-0000-0000-0000-000000000000";
    await insertSavedMessages(
      tempDir,
      id,
      Array.from({ length: 25 }, (_, index) => `message ${index}`),
    );

    const result = await handleGet({ id: "c1000000" });

    expect(result.messages).toHaveLength(20);
    expect(result.messages[0]?.content).toBe("message 5");
    expect(result.messages[19]?.content).toBe("message 24");
    expect(result.range).toEqual({
      mode: "tail",
      startIndex: 5,
      endIndex: 25,
      returnedMessages: 20,
      pageSize: 20,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 0,
    });
    expect(result.truncationNote).toContain("Showing the last 20 of 25 messages");
  });

  it("get_conversation supports explicit head and tail ranges", async () => {
    const id = "c3000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const head = await handleGet({ id: "c3000000", head: 2 });
    expect(head.messages.map((message) => message.content)).toEqual(["m0", "m1"]);
    expect(head.range).toEqual({
      mode: "head",
      startIndex: 0,
      endIndex: 2,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: false,
      hasMoreAfter: true,
      nextOffset: 2,
    });

    const tail = await handleGet({ id: "c3000000", tail: 2 });
    expect(tail.messages.map((message) => message.content)).toEqual(["m3", "m4"]);
    expect(tail.range).toEqual({
      mode: "tail",
      startIndex: 3,
      endIndex: 5,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 1,
    });
  });

  it("get_conversation supports arbitrary offset and limit windows", async () => {
    const id = "c4000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const result = await handleGet({ id: "c4000000", offset: 2, limit: 2 });

    expect(result.messages.map((message) => message.content)).toEqual(["m2", "m3"]);
    expect(result.range).toEqual({
      mode: "window",
      startIndex: 2,
      endIndex: 4,
      returnedMessages: 2,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: true,
      previousOffset: 0,
      nextOffset: 4,
    });
    expect(result.truncationNote).toContain("Showing messages 3-4 of 5");
    expect(result.truncationNote).toContain("Request offset 4 with limit 2");
  });

  it("get_conversation defaults a window limit to 20 when offset is supplied", async () => {
    const id = "c5000000-0000-0000-0000-000000000000";
    await insertSavedMessages(
      tempDir,
      id,
      Array.from({ length: 25 }, (_, index) => `message ${index}`),
    );

    const result = await handleGet({ id: "c5000000", offset: 20 });

    expect(result.messages.map((message) => message.content)).toEqual([
      "message 20",
      "message 21",
      "message 22",
      "message 23",
      "message 24",
    ]);
    expect(result.range).toMatchObject({
      mode: "window",
      startIndex: 20,
      endIndex: 25,
      returnedMessages: 5,
      pageSize: 20,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 0,
    });
  });

  it("get_conversation clamps empty windows beyond the end and points back to real content", async () => {
    const id = "c6000000-0000-0000-0000-000000000000";
    await insertSavedMessages(tempDir, id, ["m0", "m1", "m2", "m3", "m4"]);

    const result = await handleGet({ id: "c6000000", offset: 100, limit: 2 });

    expect(result.messages).toEqual([]);
    expect(result.range).toEqual({
      mode: "window",
      startIndex: 5,
      endIndex: 5,
      returnedMessages: 0,
      pageSize: 2,
      hasMoreBefore: true,
      hasMoreAfter: false,
      previousOffset: 3,
    });
    expect(result.truncationNote).toContain("Requested offset 100 is beyond the 5-message conversation");
    expect(result.truncationNote).toContain("Request offset 3 with limit 2");
  });

  it("get_conversation rejects conflicting range controls", async () => {
    await expect(handleGet({ id: "abc12345", head: 5, tail: 2 })).rejects.toThrow(
      "Choose only one message range: head, tail, or offset/limit.",
    );
    await expect(handleGet({ id: "abc12345", tail: 5, offset: 2, limit: 2 })).rejects.toThrow(
      "Choose only one message range: head, tail, or offset/limit.",
    );
  });

  it("get_conversation rejects limit without offset", async () => {
    await expect(handleGet({ id: "abc12345", limit: 2 })).rejects.toThrow(
      "limit can only be used with offset",
    );
  });

  it("get_conversation rejects message counts over the per-call cap", async () => {
    await expect(handleGet({ id: "abc12345", head: 201 })).rejects.toThrow();
  });

  it("get_conversation throws on a discovered conversation", async () => {
    await writeUnsavedClaudeConversation(
      sourceDir,
      "b6666666-6666-6666-6666-666666666666",
      { title: "Unsaved get target" },
    );
    await expect(handleGet({ id: "b6666666" })).rejects.toThrow(
      /saved/,
    );
  });

  it("get_conversation throws when the id is not found", async () => {
    await expect(handleGet({ id: "9999eeee" })).rejects.toThrow(/No conversation matches/);
  });

  // ============================================================
  // update_conversation edge cases
  // ============================================================

  it("update_conversation throws on a discovered conversation", async () => {
    await writeUnsavedClaudeConversation(
      sourceDir,
      "b7777777-7777-7777-7777-777777777777",
      { title: "Unsaved update target" },
    );

    await expect(
      handleUpdate({ id: "b7777777", title: "New title" }),
    ).rejects.toThrow(/saved/);
  });

  it("update_conversation refuses imported conversations (SPEC §11.1)", async () => {
    await insertOtherSaved("bb000000-0000-0000-0000-000000000002", {
      originKind: "file",
      originRef: null,
    });

    await expect(
      handleUpdate({ id: "bb000000", title: "new title" }),
    ).rejects.toThrow(/imported conversations are read-only/i);
  });

  it("update_conversation removeTags removes matching tags and bumps modifiedAt", async () => {
    await insertOtherSaved("b8888888-8888-8888-8888-888888888888", {
      tags: ["bug", "urgent", "frontend"],
    });

    const result = await handleUpdate({
      id: "b8888888",
      removeTags: ["bug", "urgent"],
    });
    expect(result.conversation.tags).toEqual(["frontend"]);
  });

  // ============================================================
  // browse_metadata
  // ============================================================

  it("browses projects", async () => {
    await insertOtherSaved("b9999999-9999-9999-9999-999999999999", {
      projectName: "other-project",
    });
    const result = await handleBrowse({ by: "projects" });
    expect(result.items.map((item) => item.name).sort()).toEqual([
      "api-service",
      "other-project",
    ]);
  });

  // ============================================================
  // search_conversations
  // ============================================================

  it("search_conversations throws when search is not configured", async () => {
    // Default mock throws SearchNotConfiguredError (see vi.mock above).
    await expect(handleSearch({ query: "auth" })).rejects.toThrow(
      /Search is not configured/,
    );
  });

  it("search_conversations returns empty results with indexCoverage when no conversations are searchable", async () => {
    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore([]),
    });

    // The seeded conversation has indexedAt set, but we'll add an unindexed one.
    await insertOtherSaved("ba000000-0000-0000-0000-000000000001", {
      title: "Not indexed",
      indexedAt: null,
    });

    const result = await handleSearch({
      query: "auth",
      project: "no-such-project",
    });
    expect(result.results).toEqual([]);
    // No searchable conversations match the project filter, so the invariant-check
    // short-circuits before invoking the vector store.
    expect(result.indexCoverage.indexed).toBe(0);
  });

  it("search_conversations returns ranked hits scoped to searchable conversations", async () => {
    const searchableId = "abc12345-1234-1234-1234-123456789012"; // seeded in beforeEach, indexedAt set
    const hits: SearchHit[] = [
      {
        id: `${searchableId}:0`,
        score: 0.9,
        text: "How to debug JWT refresh",
        metadata: { conversationId: searchableId },
      },
    ];

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const result = await handleSearch({ query: "auth" });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(searchableId);
    expect(result.results[0]?.project).toBe("api-service");
    expect(result.results[0]).not.toHaveProperty("projectName");
    expect(result.results[0]?.relevanceScore).toBe(0.9);
    expect(result.results[0]?.snippet).toContain("debug JWT refresh");
    expect(result.branchView).toBe("collapsed");
    expect(result.indexCoverage.indexed).toBe(1);
    expect(result.warning).toBeUndefined();
  });

  it("search_conversations collapses branches to the highest-scoring match", async () => {
    const parentId = "abc12345-1234-1234-1234-123456789012";
    const childId = "ba100000-0000-0000-0000-000000000001";
    await insertOtherSaved(childId, {
      title: "Auth branch",
      createdAt: "2026-02-02T10:00:00.000Z",
      relationshipInspection: {
        status: "linked",
        version: 2,
        diagnostic: null,
      },
      relationships: [{
        kind: "branch",
        parent: {
          source: "claude-code",
          sourceId: parentId,
        },
        evidence: "source",
        branchPoint: null,
      }],
    });
    const hits: SearchHit[] = [
      {
        id: `${parentId}:0`,
        score: 0.8,
        text: "parent auth match",
        metadata: { conversationId: parentId },
      },
      {
        id: `${childId}:0`,
        score: 0.9,
        text: "child auth match",
        metadata: { conversationId: childId },
      },
    ];
    mockedGetSearchProviders.mockResolvedValue({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const collapsed = await handleSearch({ query: "auth" });
    expect(collapsed.results).toEqual([
      expect.objectContaining({
        id: childId,
        snippetConversationId: childId,
        knownRootIdentity: {
          source: "claude-code",
          sourceId: parentId,
        },
        memberCount: 2,
        branchCount: 1,
        relationshipCompleteness: "complete",
      }),
    ]);
    expect(collapsed.branchView).toBe("collapsed");

    const expanded = await handleSearch({
      query: "auth",
      allBranches: true,
    });
    expect(expanded.results.map((result) => result.id)).toEqual([
      parentId,
      childId,
    ]);
    expect(expanded.branchView).toBe("all_branches");
  });

  it("search_conversations filters project and author by case-insensitive substrings", async () => {
    const otherId = "ba111111-1111-1111-1111-111111111111";
    await insertOtherSaved(otherId, {
      title: "Mobile API debug",
      author: "Bob Xander",
      projectName: "Mobile API",
    });

    const seededId = "abc12345-1234-1234-1234-123456789012";
    const hits: SearchHit[] = [
      {
        id: `${seededId}:0`,
        score: 0.95,
        text: "Auth flow in api-service",
        metadata: { conversationId: seededId },
      },
      {
        id: `${otherId}:0`,
        score: 0.9,
        text: "Mobile API auth flow",
        metadata: { conversationId: otherId },
      },
    ];

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const result = await handleSearch({
      query: "auth",
      project: "mobile",
      author: "xand",
    });
    expect(result.results).toHaveLength(1);
    expect(result.results[0]?.id).toBe(otherId);
    expect(result.results[0]?.project).toBe("Mobile API");
    expect(result.indexCoverage).toEqual({
      indexed: 1,
      saved: 1,
    });
  });

  it("search_conversations wraps unknown vector-store errors with a rebuild hint", async () => {
    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: {
        upsert: async () => undefined,
        delete: async () => undefined,
        search: async () => {
          throw new Error("malformed index shape");
        },
      },
    });

    await expect(handleSearch({ query: "auth" })).rejects.toThrow(
      /malformed index shape[\s\S]*clog index --rebuild/,
    );
  });

  it("search_conversations reports the scan-cap warning when the window is exhausted", async () => {
    const searchableId = "abc12345-1234-1234-1234-123456789012";
    // Return a full window of sub-threshold hits that never satisfy the limit.
    const hits: SearchHit[] = Array.from({ length: 5000 }, (_, i) => ({
      id: `${searchableId}:${i}`,
      score: 0.05,
      text: `noise ${i}`,
      metadata: { conversationId: searchableId },
    }));

    mockedGetSearchProviders.mockResolvedValueOnce({
      embedding: makeEmbedding(),
      vectorStore: makeVectorStore(hits),
    });

    const result = await handleSearch({ query: "auth", limit: 10 });
    expect(result.warning).toContain("maximum scan window");
  });
});

async function insertOtherSaved(
  id: string,
  overrides: Partial<ConversationMeta> = {},
): Promise<void> {
  await insertConversation({
    id,
    sourceId: id,
    source: "claude-code",
    title: "Other conversation",
    summary: "",
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: [],
    slug: null,
    createdAt: "2026-02-01T10:00:00.000Z",
    discoveredAt: "2026-02-01T10:00:00.000Z",
    modifiedAt: "2026-02-01T10:00:00.000Z",
    state: "saved",
    savedAt: "2026-02-01T10:00:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: "/tmp/other.jsonl",
    filePath: "/tmp/other.jsonl",
    sourceMtime: null,
    indexedAt: "2026-02-01T10:00:00.000Z",
    originKind: "local",
    originRef: null,
    relationshipInspection: {
      status: "none_found",
      version: 2,
      diagnostic: null,
    },
    relationships: [],
    transcriptProjectionVersion: 2,
    ...overrides,
  });
}

async function writeUnsavedClaudeConversation(
  sourceRoot: string,
  id: string,
  options: {
    title: string;
    projectName?: string;
    assistantText?: string;
  },
): Promise<string> {
  const projectName = options.projectName ?? "api-service";
  const sourcePath = path.join(sourceRoot, projectName, `${id}.jsonl`);
  await writeJsonl(sourcePath, [
    {
      type: "user",
      timestamp: "2026-02-01T10:00:00.000Z",
      cwd: `/tmp/${projectName}`,
      message: { role: "user", content: options.title },
    },
    {
      type: "assistant",
      timestamp: "2026-02-01T10:00:01.000Z",
      message: {
        id: `msg-${id}`,
        role: "assistant",
        content: [{ type: "text", text: options.assistantText ?? "Working on it." }],
      },
    },
  ]);
  return sourcePath;
}

async function writeMalformedClaudeConversation(
  sourceRoot: string,
  id: string,
): Promise<void> {
  const sourcePath = path.join(sourceRoot, "malformed", `${id}.jsonl`);
  await fs.mkdir(path.dirname(sourcePath), { recursive: true });
  await fs.writeFile(sourcePath, "{not valid json}\n", "utf8");
}

async function insertSavedMessages(
  tempDir: string,
  id: string,
  contents: string[],
): Promise<void> {
  const rawDir = path.join(tempDir, "raw", "claude-code");
  const filePath = path.join(rawDir, `${id}.jsonl`);
  await writeJsonl(
    filePath,
    contents.map((content, index) => ({
      type: "user",
      timestamp: `2026-02-01T10:00:${String(index).padStart(2, "0")}.000Z`,
      message: { role: "user", content },
    })),
  );

  await insertOtherSaved(id, {
    title: `Conversation ${id.slice(0, 8)}`,
    sourcePath: filePath,
    filePath,
    savedMessageCount: contents.length,
  });
}

function makeEmbedding(): EmbeddingProvider {
  return {
    name: "fake",
    dimensions: 3,
    embed: vi.fn(async (texts: string[]) => texts.map(() => [0.1, 0.2, 0.3])),
  };
}

function makeVectorStore(hits: SearchHit[]): VectorStore {
  return {
    upsert: vi.fn(async () => undefined),
    delete: vi.fn(async () => undefined),
    search: vi.fn(async (_embedding, limit) => hits.slice(0, limit)),
  };
}
