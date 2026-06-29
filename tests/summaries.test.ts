import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  getConversationById,
  withDb,
} from "../src/db/index.js";
import { CURRENT_SCHEMA_VERSION } from "../src/db/schema.js";
import type { ConversationMeta } from "../src/models/conversation.js";
import {
  handleAnalysisSuggestions,
  handleGet,
  handleListSaved,
  handleSummarizationGuide,
  handleUpdate,
} from "../src/mcp/handlers.js";
import { buildEditCommand } from "../src/cli/edit.js";
import { maybePrintSummarizationHint } from "../src/cli/save.js";
import { isUnsummarized } from "../src/models/conversation.js";
import { insertConversation, updateConversation } from "./helpers/db.js";
import { captureOutput } from "./helpers/output.js";

describe("agent-assisted summarization", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-summaries-"));
    process.env.CLOG_HOME = tempDir;
  });

  afterEach(async () => {
    delete process.env.CLOG_HOME;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  describe("DB layer", () => {
    it("round-trips summaryKind and summaryExtraction", async () => {
      const conversation = makeSavedConversation({
        summary: "Auth race condition fixed",
        summaryKind: "generated",
        summaryExtraction: {
          topics: ["auth", "jwt"],
          outcome: "fixed",
          toolsUsed: ["Edit", "Bash"],
          notableMoments: [{ why: "user spotted a wrong premise" }],
        },
      });
      await insertConversation(conversation);

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summaryKind).toBe("generated");
      expect(loaded?.summaryExtraction).toEqual(conversation.summaryExtraction);
    });

    it("accepts and round-trips outcome: 'noise'", async () => {
      const conversation = makeSavedConversation({
        summary: "Session opened and closed without any user input.",
        summaryKind: "generated",
        summaryExtraction: {
          outcome: "noise",
        },
      });
      await insertConversation(conversation);

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summaryExtraction?.outcome).toBe("noise");
    });

    it("defaults summaryKind to 'none' for blank summaries", async () => {
      const conversation = makeSavedConversation({
        summary: "",
        summaryKind: "none",
      });
      await insertConversation(conversation);

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summaryKind).toBe("none");
      expect(loaded?.summaryExtraction).toBeNull();
    });

    it("upgrades a v4-shaped DB to v5 and back-fills summaryKind='curated' for non-empty summaries", async () => {
      // Construct a v4-shaped database directly: no summary_kind or
      // summary_extraction columns, with schema_version = 4. Then trigger
      // applyMigrations through a normal withDb call and verify both the
      // new columns and the back-fill behavior.
      await withDb(
        (db) => {
          db.exec("DROP TABLE IF EXISTS conversations");
          db.exec("DROP TABLE IF EXISTS schema_version");
          db.exec("CREATE TABLE schema_version (version INTEGER NOT NULL)");
          db.exec(`
            CREATE TABLE conversations (
              id TEXT PRIMARY KEY,
              source_id TEXT NOT NULL,
              source TEXT NOT NULL,
              title TEXT NOT NULL,
              summary TEXT DEFAULT '',
              author TEXT NOT NULL,
              project_name TEXT,
              project_path TEXT,
              tags_json TEXT DEFAULT '[]',
              slug TEXT,
              created_at TEXT NOT NULL,
              discovered_at TEXT NOT NULL,
              modified_at TEXT NOT NULL,
              state TEXT NOT NULL DEFAULT 'discovered'
                CHECK(state IN ('discovered','staged','saved')),
              saved_at TEXT,
              saved_message_count INTEGER,
              save_version INTEGER DEFAULT 0,
              source_path TEXT NOT NULL,
              file_path TEXT,
              source_mtime TEXT,
              indexed_at TEXT,
              origin TEXT DEFAULT NULL,
              UNIQUE(source, source_id)
            )
          `);
          db.run("INSERT INTO schema_version (version) VALUES (?)", [4]);
          db.run(
            `INSERT INTO conversations (id, source_id, source, title, summary, author,
              created_at, discovered_at, modified_at, state, save_version, source_path)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              "11111111-1234-1234-1234-123456789012",
              "src1",
              "claude-code",
              "Has a summary",
              "Existing summary text",
              "alice",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
              "saved",
              1,
              "/tmp/x",
            ],
          );
          db.run(
            `INSERT INTO conversations (id, source_id, source, title, summary, author,
              created_at, discovered_at, modified_at, state, save_version, source_path)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
            [
              "22222222-1234-1234-1234-123456789012",
              "src2",
              "claude-code",
              "Blank summary",
              "",
              "alice",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
              "2026-01-01T00:00:00.000Z",
              "saved",
              1,
              "/tmp/x",
            ],
          );
        },
        { applyMigrations: false },
      );

      // Sanity: the v4 DB has no summary_kind column yet.
      const v4Columns = await withDb(
        (db) => {
          const result = db.exec("PRAGMA table_info(conversations)");
          return new Set(
            result[0]?.values.map((row) => String(row[1])) ?? [],
          );
        },
        { applyMigrations: false },
      );
      expect(v4Columns.has("summary_kind")).toBe(false);
      expect(v4Columns.has("summary_extraction")).toBe(false);

      // Trigger the migration: applyMigrations defaults to true.
      await withDb(() => undefined);

      const populated = await getConversationById(
        "11111111-1234-1234-1234-123456789012",
      );
      const blank = await getConversationById(
        "22222222-1234-1234-1234-123456789012",
      );

      expect(populated?.summaryKind).toBe("curated");
      expect(populated?.summaryExtraction).toBeNull();
      expect(blank?.summaryKind).toBe("none");
      expect(blank?.summaryExtraction).toBeNull();
      expect(CURRENT_SCHEMA_VERSION).toBe(7);
    });
  });

  describe("MCP handleUpdate", () => {
    it("defaults summaryKind to 'generated' when a summary is provided", async () => {
      const conversation = makeSavedConversation();
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        summary: "Generated summary text",
        extraction: {
          topics: ["auth"],
          outcome: "fixed",
        },
      });

      expect(result.conversation.summaryKind).toBe("generated");
      expect(result.conversation.extraction).toEqual({
        topics: ["auth"],
        outcome: "fixed",
      });
    });

    it("accepts an explicit 'curated' override from the agent", async () => {
      const conversation = makeSavedConversation();
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        summary: "Curated by user direction",
        summaryKind: "curated",
      });

      expect(result.conversation.summaryKind).toBe("curated");
    });

    it("leaves summaryKind alone when prose is cleared but extraction is preserved", async () => {
      // Edge case: the agent passes summary: "" without clearing the
      // extraction. Defaulting to 'generated' would be wrong (the prose is
      // blank). Defaulting to 'none' would also be wrong (the extraction
      // is still there). Leave the existing summaryKind alone and let the
      // next explicit call decide.
      const conversation = makeSavedConversation({
        summary: "Curated prose",
        summaryKind: "curated",
        summaryExtraction: { topics: ["auth"] },
      });
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        summary: "",
      });

      expect(result.conversation.summary).toBe("");
      expect(result.conversation.summaryKind).toBe("curated");
      expect(result.conversation.extraction).toEqual({ topics: ["auth"] });
    });

    it("resets summaryKind to 'none' when both summary and extraction become empty", async () => {
      const conversation = makeSavedConversation({
        summary: "Existing",
        summaryKind: "generated",
        summaryExtraction: { topics: ["x"] },
      });
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        summary: "",
        extraction: null,
      });

      expect(result.conversation.summaryKind).toBe("none");
      expect(result.conversation.summary).toBe("");
      expect(result.conversation.extraction).toBeNull();
    });

    it("ignores explicit summaryKind when clearing both summary and extraction", async () => {
      const conversation = makeSavedConversation({
        summary: "Existing",
        summaryKind: "generated",
        summaryExtraction: { topics: ["x"] },
      });
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        summary: "",
        extraction: null,
        summaryKind: "curated",
      });

      expect(result.conversation.summaryKind).toBe("none");
      expect(result.conversation.summary).toBe("");
      expect(result.conversation.extraction).toBeNull();
    });

    it("preserves 'curated' when only the extraction is added to a curated summary", async () => {
      // The agent might add structure to a user-curated prose summary. The
      // prose is still curated; summaryKind must not silently downgrade.
      const conversation = makeSavedConversation({
        summary: "User-written prose",
        summaryKind: "curated",
        summaryExtraction: null,
      });
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        extraction: { topics: ["auth"] },
      });

      expect(result.conversation.summaryKind).toBe("curated");
      expect(result.conversation.summary).toBe("User-written prose");
      expect(result.conversation.extraction).toEqual({ topics: ["auth"] });
    });

    describe("strict input rejects malformed agent calls", () => {
      // The summarization guide warns agents about these patterns. Strict
      // validation turns the prose warnings into runtime errors so misbehaving
      // agents see the failure instead of silently dropping data.

      it("rejects extraction fields placed at the top level of clog_update", async () => {
        const conversation = makeSavedConversation();
        await insertConversation(conversation);

        await expect(
          handleUpdate({
            id: conversation.id,
            summary: "Prose summary",
            // Agent forgot to nest these under `extraction`.
            topics: ["auth"],
            outcome: "fixed",
          }),
        ).rejects.toThrow();
      });

      it("rejects misspelled fields inside extraction", async () => {
        const conversation = makeSavedConversation();
        await insertConversation(conversation);

        await expect(
          handleUpdate({
            id: conversation.id,
            summary: "Prose summary",
            extraction: {
              topics: ["auth"],
              // snake_case typo for toolsUsed.
              tools_used: ["Edit"],
            },
          }),
        ).rejects.toThrow();
      });

      it("rejects invented fields inside extraction", async () => {
        const conversation = makeSavedConversation();
        await insertConversation(conversation);

        await expect(
          handleUpdate({
            id: conversation.id,
            summary: "Prose summary",
            extraction: {
              topics: ["auth"],
              sentiment: "frustrated",
            },
          }),
        ).rejects.toThrow();
      });

      it("rejects extra keys inside notableMoments items", async () => {
        const conversation = makeSavedConversation();
        await insertConversation(conversation);

        await expect(
          handleUpdate({
            id: conversation.id,
            summary: "Prose summary",
            extraction: {
              notableMoments: [{ why: "ok", severity: "high" }],
            },
          }),
        ).rejects.toThrow();
      });
    });

    it("does not change summaryKind when only tags are updated", async () => {
      const conversation = makeSavedConversation({
        summary: "Existing",
        summaryKind: "curated",
      });
      await insertConversation(conversation);

      const result = await handleUpdate({
        id: conversation.id,
        addTags: ["new-tag"],
      });

      expect(result.conversation.summaryKind).toBe("curated");
      expect(result.conversation.summary).toBe("Existing");
    });
  });

  describe("CLI clog edit", () => {
    it("claims a source/generated summary as curated even when the text matches", async () => {
      // Regression: previously the summaryKind-flip only fired when the new text
      // differed from the existing text. A user passing --summary with the
      // exact same words ought to be able to claim the summary as curated.
      const conversation = makeSavedConversation({
        summary: "Source-derived summary",
        summaryKind: "imported",
        summaryExtraction: null,
      });
      await insertConversation(conversation);

      await captureOutput(async () => {
        const cmd = buildEditCommand();
        cmd.exitOverride();
        await cmd.parseAsync(
          [conversation.id, "--summary", "Source-derived summary"],
          { from: "user" },
        );
      });

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summary).toBe("Source-derived summary");
      expect(loaded?.summaryKind).toBe("curated");
    });

    it("clears the structured extraction when --summary is set to empty", async () => {
      // SPEC: clearing prose via the CLI also drops summaryExtraction so the
      // conversation looks unsummarized again. Regression guard for anyone
      // tightening edit.ts and forgetting to null out the extraction.
      const conversation = makeSavedConversation({
        summary: "Generated prose",
        summaryKind: "generated",
        summaryExtraction: { topics: ["auth"], outcome: "fixed" },
      });
      await insertConversation(conversation);

      await captureOutput(async () => {
        const cmd = buildEditCommand();
        cmd.exitOverride();
        await cmd.parseAsync([conversation.id, "--summary", ""], { from: "user" });
      });

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summary).toBe("");
      expect(loaded?.summaryKind).toBe("none");
      expect(loaded?.summaryExtraction).toBeNull();
    });
  });

  describe("MCP handleGet / handleListSaved", () => {
    it("returns summaryKind and extraction on get", async () => {
      const conversation = makeSavedConversation({
        summary: "Existing",
        summaryKind: "generated",
        summaryExtraction: { topics: ["auth"], outcome: "fixed" },
      });
      await insertConversation(conversation);
      await ensureMessagesFile(conversation);

      const result = await handleGet({ id: conversation.id });
      expect(result.summaryKind).toBe("generated");
      expect(result.extraction).toEqual({ topics: ["auth"], outcome: "fixed" });
    });

    it("returns summaryKind and extraction on list", async () => {
      const conversation = makeSavedConversation({
        summary: "Existing",
        summaryKind: "generated",
        summaryExtraction: { topics: ["auth"] },
      });
      await insertConversation(conversation);

      const result = await handleListSaved({ limit: 10 });
      expect(result.conversations).toHaveLength(1);
      expect(result.conversations[0].summaryKind).toBe("generated");
      expect(result.conversations[0].extraction).toEqual({ topics: ["auth"] });
    });
  });

  describe("state transitions preserve summary metadata", () => {
    it("saved metadata updates preserve summaryKind and extraction", async () => {
      const conversation = makeSavedConversation({
        summary: "Auth refactor",
        summaryKind: "generated",
        summaryExtraction: { topics: ["auth"], outcome: "fixed" },
      });
      await insertConversation(conversation);

      await updateConversation({
        ...conversation,
        title: "Updated title",
        indexedAt: null,
      });

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.state).toBe("saved");
      expect(loaded?.summaryKind).toBe("generated");
      expect(loaded?.summaryExtraction).toEqual({
        topics: ["auth"],
        outcome: "fixed",
      });
    });

    it("add raw-copy refresh on saved conversation preserves summary metadata", async () => {
      const conversation = makeSavedConversation({
        summary: "Curated text",
        summaryKind: "curated",
        summaryExtraction: { topics: ["x"] },
      });
      await insertConversation(conversation);

      // Mirror a saved raw-copy refresh: it
      // re-copies the raw file but leaves curation metadata alone.
      await updateConversation({
        ...conversation,
        modifiedAt: "2026-02-01T00:00:00.000Z",
      });

      const loaded = await getConversationById(conversation.id);
      expect(loaded?.summary).toBe("Curated text");
      expect(loaded?.summaryKind).toBe("curated");
      expect(loaded?.summaryExtraction).toEqual({ topics: ["x"] });
    });
  });

  describe("isUnsummarized predicate (used by clog talk / save hint)", () => {
    it("counts conversations with kind 'none' as unsummarized", () => {
      expect(
        isUnsummarized(
          makeSavedConversation({
            summary: "",
            summaryKind: "none",
            summaryExtraction: null,
          }),
        ),
      ).toBe(true);
    });

    it("counts imported-summary conversations as unsummarized", () => {
      expect(
        isUnsummarized(
          makeSavedConversation({
            summary: "From Claude Code metadata",
            summaryKind: "imported",
            summaryExtraction: null,
          }),
        ),
      ).toBe(true);
    });

    it("counts prose-only generated conversations (no extraction) as unsummarized", () => {
      // Regression: an earlier predicate excluded these, which would have
      // hidden them from `clog talk`'s state nudge and the post-save hint.
      expect(
        isUnsummarized(
          makeSavedConversation({
            summary: "Old prose summary without structure",
            summaryKind: "generated",
            summaryExtraction: null,
          }),
        ),
      ).toBe(true);
    });

    it("does not count conversations with a structured extraction", () => {
      expect(
        isUnsummarized(
          makeSavedConversation({
            summary: "Fine prose",
            summaryKind: "generated",
            summaryExtraction: { topics: ["x"] },
          }),
        ),
      ).toBe(false);
    });

    it("does not count curated conversations", () => {
      expect(
        isUnsummarized(
          makeSavedConversation({
            summary: "User-written",
            summaryKind: "curated",
            summaryExtraction: null,
          }),
        ),
      ).toBe(false);
    });
  });

  describe("post-save summarization hint", () => {
    it("prints a hint when at least one saved local conversation is unsummarized", async () => {
      await insertConversation(
        makeSavedConversation({
          id: "aaaaaaaa-1234-1234-1234-123456789012",
          sourceId: "src-a",
          summary: "",
          summaryKind: "none",
          summaryExtraction: null,
        }),
      );
      await insertConversation(
        makeSavedConversation({
          id: "bbbbbbbb-1234-1234-1234-123456789012",
          sourceId: "src-b",
          summary: "Source-derived",
          summaryKind: "imported",
          summaryExtraction: null,
        }),
      );

      const { stdout } = await captureOutput(async () => {
        await maybePrintSummarizationHint();
      });

      expect(stdout).toContain("2 saved conversation(s)");
      expect(stdout).toContain("clog talk");
    });

    it("stays silent when every saved conversation is curated or already has an extraction", async () => {
      await insertConversation(
        makeSavedConversation({
          id: "cccccccc-1234-1234-1234-123456789012",
          sourceId: "src-c",
          summary: "User-written",
          summaryKind: "curated",
          summaryExtraction: null,
        }),
      );
      await insertConversation(
        makeSavedConversation({
          id: "dddddddd-1234-1234-1234-123456789012",
          sourceId: "src-d",
          summary: "Generated",
          summaryKind: "generated",
          summaryExtraction: { topics: ["auth"] },
        }),
      );

      const { stdout } = await captureOutput(async () => {
        await maybePrintSummarizationHint();
      });

      expect(stdout).toBe("");
    });
  });

  describe("MCP guides", () => {
    it("returns the summarization guide markdown", async () => {
      const result = await handleSummarizationGuide();
      expect(typeof result.guide).toBe("string");
      expect(result.guide.length).toBeGreaterThan(200);
      expect(result.guide).toContain("summary");
      expect(result.guide).toContain("extraction");
    });

    it("returns the analysis suggestions library with v2 entries", async () => {
      const result = await handleAnalysisSuggestions();
      expect(result.version).toBe(2);
      expect(result.suggestions.length).toBeGreaterThan(3);
      for (const suggestion of result.suggestions) {
        expect(suggestion.id).toBeTruthy();
        expect(suggestion.name).toBeTruthy();
        expect(suggestion.suggestedPrompt).toBeTruthy();
        expect(["solo", "team", "both"]).toContain(suggestion.audience);
      }
    });
  });
});

async function ensureMessagesFile(conversation: ConversationMeta): Promise<void> {
  const messagesPath = conversation.filePath ?? conversation.sourcePath;
  await fs.mkdir(path.dirname(messagesPath), { recursive: true });
  await fs.writeFile(
    messagesPath,
    JSON.stringify({
      type: "user",
      uuid: "u1",
      timestamp: "2026-01-01T00:00:00.000Z",
      cwd: "/tmp/proj",
      message: { role: "user", content: "hi" },
    }) + "\n",
    "utf8",
  );
}

function makeSavedConversation(
  overrides: Partial<ConversationMeta> = {},
): ConversationMeta {
  const messagesPath = path.join(
    process.env.CLOG_HOME ?? "/tmp",
    "raw",
    "claude-code",
    "a1234567-1234-1234-1234-123456789012.jsonl",
  );
  return {
    id: "a1234567-1234-1234-1234-123456789012",
    sourceId: "a1234567-1234-1234-1234-123456789012",
    source: "claude-code",
    title: "Auth work",
    summary: "",
    summaryKind: "none",
    summaryExtraction: null,
    author: "alice",
    projectName: "api-service",
    projectPath: "/tmp/api-service",
    tags: [],
    slug: null,
    createdAt: "2026-01-01T00:00:00.000Z",
    discoveredAt: "2026-01-01T00:00:00.000Z",
    modifiedAt: "2026-01-01T00:00:00.000Z",
    state: "saved",
    savedAt: "2026-01-01T00:00:00.000Z",
    savedMessageCount: 1,
    saveVersion: 1,
    sourcePath: messagesPath,
    filePath: messagesPath,
    sourceMtime: null,
    indexedAt: null,
    originKind: "local",
    originRef: null,
    ...overrides,
  };
}
