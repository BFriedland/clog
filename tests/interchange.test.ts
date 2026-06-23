import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { getDefaultConfig } from "../src/config/index.js";
import {
  parsePairMetadata,
  scanPairs,
  serializePairMetadata,
  validatePair,
  writePair,
  type PairMetadata,
} from "../src/interchange/pairs.js";
import * as atomicWrite from "../src/utils/atomic-write.js";
import { writeJsonl } from "./helpers/fixtures.js";

describe("conversation pair interchange", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-interchange-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("round-trips a complete pair through write, scan, and validation", async () => {
    const id = "a1111111-1111-1111-1111-111111111111";
    const meta = makePairMetadata(id);

    await writePair({
      jsonlPath: path.join(tempDir, `${id}.jsonl`),
      metaPath: path.join(tempDir, `${id}.meta.json`),
      jsonl: makeClaudeJsonl(2),
      meta,
    });

    const pairs = await scanPairs(tempDir);
    expect(pairs).toHaveLength(1);
    expect(pairs[0]).toMatchObject({
      stem: id,
      relativeDir: "",
      normalizedRelativePath: id,
      metaExists: true,
      jsonlExists: true,
    });

    const validation = await validatePair(pairs[0]!, getDefaultConfig("alice"));

    expect(validation.kind).toBe("valid");
    if (validation.kind === "valid") {
      expect(validation.pair.meta).toEqual(meta);
      expect(validation.pair.messageCount).toBe(2);
    }
  });

  it("discovers metadata-only and JSONL-only stems", async () => {
    const metaOnly = "b2222222-2222-2222-2222-222222222222";
    const jsonlOnly = "c3333333-3333-3333-3333-333333333333";

    await fs.writeFile(
      path.join(tempDir, `${metaOnly}.meta.json`),
      serializePairMetadata(makePairMetadata(metaOnly)),
      "utf8",
    );
    await fs.writeFile(path.join(tempDir, `${jsonlOnly}.jsonl`), makeClaudeJsonl(1), "utf8");

    const pairs = await scanPairs(tempDir);

    expect(pairs.map((pair) => pair.stem)).toEqual([metaOnly, jsonlOnly]);
    expect(pairs[0]).toMatchObject({
      metaExists: true,
      jsonlExists: false,
    });
    expect(pairs[1]).toMatchObject({
      metaExists: false,
      jsonlExists: true,
    });
  });

  it("orders nested scan results by normalized relative path", async () => {
    const ids = {
      root: "d4444444-4444-4444-4444-444444444444",
      nestedA: "a5555555-5555-5555-5555-555555555555",
      nestedB: "b6666666-6666-6666-6666-666666666666",
    };

    await writeCompletePair(path.join(tempDir, "zeta"), ids.root);
    await writeCompletePair(path.join(tempDir, "alpha", "beta"), ids.nestedB);
    await writeCompletePair(path.join(tempDir, "alpha"), ids.nestedA);

    const pairs = await scanPairs(tempDir);

    expect(pairs.map((pair) => pair.normalizedRelativePath)).toEqual([
      `alpha/${ids.nestedA}`,
      `alpha/beta/${ids.nestedB}`,
      `zeta/${ids.root}`,
    ]);
  });

  it("treats flat, nested, and git-style layouts as ordinary pairs", async () => {
    const id = "e7777777-7777-7777-7777-777777777777";
    const cases = [
      { root: path.join(tempDir, "flat"), pairDir: path.join(tempDir, "flat"), relativeDir: "" },
      {
        root: path.join(tempDir, "nested"),
        pairDir: path.join(tempDir, "nested", "claude-code"),
        relativeDir: "claude-code",
      },
      {
        root: path.join(tempDir, "git"),
        pairDir: path.join(tempDir, "git", "alice", "claude-code"),
        relativeDir: "alice/claude-code",
      },
    ];

    for (const item of cases) {
      await writeCompletePair(item.pairDir, id);
      const [pair] = await scanPairs(item.root);

      expect(pair).toMatchObject({
        stem: id,
        relativeDir: item.relativeDir,
        metaExists: true,
        jsonlExists: true,
      });
    }
  });

  it("reports an interrupted new-pair write as an incomplete JSONL-only pair", async () => {
    const id = "f8888888-8888-8888-8888-888888888888";
    await fs.writeFile(path.join(tempDir, `${id}.jsonl`), makeClaudeJsonl(1), "utf8");

    const [pair] = await scanPairs(tempDir);
    const validation = await validatePair(pair!, getDefaultConfig("alice"));

    expect(validation.kind).toBe("invalid");
    if (validation.kind === "invalid") {
      expect(validation.warning.code).toBe("pair_incomplete");
      expect(validation.warning.paths).toEqual([
        path.join(tempDir, `${id}.meta.json`),
        path.join(tempDir, `${id}.jsonl`),
      ]);
    }
  });

  it("uses pair_id_mismatch when the filename stem differs from meta.id", async () => {
    const filenameStem = "12345678-1234-1234-1234-123456789abc";
    const metaId = "abcdef12-1234-1234-1234-123456789abc";

    await fs.writeFile(
      path.join(tempDir, `${filenameStem}.meta.json`),
      serializePairMetadata(makePairMetadata(metaId)),
      "utf8",
    );
    await fs.writeFile(path.join(tempDir, `${filenameStem}.jsonl`), makeClaudeJsonl(1), "utf8");

    const [pair] = await scanPairs(tempDir);
    const validation = await validatePair(pair!, getDefaultConfig("alice"));

    expect(validation.kind).toBe("invalid");
    if (validation.kind === "invalid") {
      expect(validation.warning.code).toBe("pair_id_mismatch");
      expect(validation.warning.message).toContain(filenameStem);
      expect(validation.warning.message).toContain(metaId);
    }
  });

  it("writes JSONL first and metadata last through the atomic writer", async () => {
    const id = "a9999999-9999-9999-9999-999999999999";
    const calls: string[] = [];
    const spy = vi
      .spyOn(atomicWrite, "writeFileAtomic")
      .mockImplementation(async (filePath: string) => {
        calls.push(path.basename(filePath));
      });

    await writePair({
      jsonlPath: path.join(tempDir, `${id}.jsonl`),
      metaPath: path.join(tempDir, `${id}.meta.json`),
      jsonl: makeClaudeJsonl(1),
      meta: makePairMetadata(id),
    });

    expect(spy).toHaveBeenCalledTimes(2);
    expect(calls).toEqual([`${id}.jsonl`, `${id}.meta.json`]);
  });

  it("parses pair metadata with backward-compatible summary defaults", () => {
    const id = "b1010101-1010-1010-1010-101010101010";
    const parsed = JSON.parse(serializePairMetadata(makePairMetadata(id))) as Record<string, unknown>;
    delete parsed.summaryKind;
    delete parsed.summaryExtraction;

    const result = parsePairMetadata(JSON.stringify(parsed));

    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.meta.summaryKind).toBe("curated");
      expect(result.meta.summaryExtraction).toBeNull();
    }
  });
});

async function writeCompletePair(pairDir: string, id: string): Promise<void> {
  await fs.mkdir(pairDir, { recursive: true });
  await fs.writeFile(
    path.join(pairDir, `${id}.meta.json`),
    serializePairMetadata(makePairMetadata(id)),
    "utf8",
  );
  await writeJsonl(path.join(pairDir, `${id}.jsonl`), makeClaudeLines(1));
}

function makePairMetadata(id: string): PairMetadata {
  return {
    id,
    title: "Fix auth",
    summary: "JWT expiration",
    summaryKind: "curated",
    summaryExtraction: null,
    tags: ["auth", "debugging"],
    author: "alice",
    projectName: "api-service",
    savedAt: "2026-02-20T10:00:00.000Z",
    modifiedAt: "2026-02-21T15:00:00.000Z",
    source: "claude-code",
    createdAt: "2026-02-19T09:15:00.000Z",
    slug: "fix-auth",
  };
}

function makeClaudeJsonl(messageCount: number): string {
  return `${makeClaudeLines(messageCount).map((line) => JSON.stringify(line)).join("\n")}\n`;
}

function makeClaudeLines(messageCount: number): unknown[] {
  const lines: unknown[] = [];
  for (let i = 0; i < messageCount; i += 1) {
    lines.push({
      type: "user",
      timestamp: "2026-02-19T09:15:00.000Z",
      cwd: "/tmp/api-service",
      message: {
        role: "user",
        content: `Message ${i}`,
      },
    });
  }
  return lines;
}
