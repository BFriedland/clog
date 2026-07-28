import fs from "node:fs";
import path from "node:path";

import { describe, expect, it } from "vitest";

// This guard keeps the UI_VOCABULARY_ALIGNMENT rename finished by making the
// boundary mechanical rather than remembered:
//
//   1. "pair" as a standalone identifier word lives only under
//      src/interchange/, where the two-file unit is the domain concept.
//      Everywhere else it was renamed to conversation/files vocabulary.
//   2. "row" never appears in user-facing string literals outside the MCP
//      surface, which speaks in conversations, not clog's internal nouns.
//
// Two documented carve-outs:
//   - The frozen `pair_*` interchange warning codes are stable machine
//     contract identifiers (docs/FORMATS.md) and keep their names anywhere.
//   - The MCP tool schemas use "row" for the result-item concept, a
//     vocabulary CL_14 deliberately shipped; that surface is exempt from the
//     "row" rule.

const REPO_ROOT = process.cwd();
const SELF = path.join("tests", "vocabulary-boundary.test.ts");

// "pair" identifiers are the interchange layer's domain vocabulary.
const PAIR_ALLOWED_PREFIX = path.join("src", "interchange") + path.sep;
// CL_14 owns "row" as the MCP result-item noun.
const ROW_EXEMPT_PREFIX = path.join("src", "mcp") + path.sep;

// Stable `pair_*` warning-code strings that keep their names wherever used.
const FROZEN_WARNING_CODES = [
  "pair_incomplete",
  "pair_invalid_metadata",
  "pair_id_mismatch",
  "pair_invalid_content",
  "pair_layout_mismatch",
  "pair_duplicate_identity",
];

function listSourceFiles(dir: string): string[] {
  const out: string[] = [];
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "fixtures") continue;
      out.push(...listSourceFiles(full));
    } else if (/\.(ts|mjs)$/.test(entry.name)) {
      out.push(full);
    }
  }
  return out;
}

// Split text into identifier "words": break on non-alphanumerics, then on
// camelCase humps. `ScannedPair` -> ["Scanned", "Pair"]; `repair` -> ["repair"]
// (no hump, so it never matches "pair").
function identifierWords(text: string): string[] {
  return text
    .split(/[^A-Za-z0-9]+/)
    .flatMap((chunk) => chunk.split(/(?<=[a-z0-9])(?=[A-Z])/))
    .filter(Boolean);
}

function stripFrozenCodes(line: string): string {
  let result = line;
  for (const code of FROZEN_WARNING_CODES) {
    result = result.split(code).join("");
  }
  return result;
}

function hasWord(text: string, re: RegExp): boolean {
  return identifierWords(text).some((word) => re.test(word));
}

// Bodies of single-, double-, and back-quoted string literals, with `${...}`
// template interpolations removed — an interpolation names a variable the user
// never sees, not user-facing prose.
function userFacingLiteralBodies(line: string): string[] {
  const bodies: string[] = [];
  const pattern = /"([^"]*)"|'([^']*)'|`([^`]*)`/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(line)) != null) {
    const body = match[1] ?? match[2] ?? match[3] ?? "";
    bodies.push(body.replace(/\$\{[^}]*\}/g, ""));
  }
  return bodies;
}

const files = [
  ...listSourceFiles(path.join(REPO_ROOT, "src")),
  ...listSourceFiles(path.join(REPO_ROOT, "tests")),
]
  .map((absolute) => ({
    relative: path.relative(REPO_ROOT, absolute),
    lines: fs.readFileSync(absolute, "utf8").split("\n"),
  }))
  .filter((file) => file.relative !== SELF);

describe("vocabulary boundary", () => {
  it("keeps 'pair' identifiers inside src/interchange only", () => {
    const violations: string[] = [];

    for (const file of files) {
      // Production identifiers are what teach vocabulary to future readers and
      // agents; test scaffolding and descriptions may still say "pair" when
      // exercising the interchange format.
      if (!file.relative.startsWith("src" + path.sep)) continue;
      if (file.relative.startsWith(PAIR_ALLOWED_PREFIX)) continue;

      file.lines.forEach((line, index) => {
        if (hasWord(stripFrozenCodes(line), /^pairs?$/i)) {
          violations.push(`${file.relative}:${index + 1}: ${line.trim()}`);
        }
      });
    }

    expect(violations).toEqual([]);
  });

  it("keeps 'row' out of user-facing string literals", () => {
    const violations: string[] = [];

    for (const file of files) {
      // Test files quote the exact product strings they assert on; the product
      // source is the authority. The MCP surface uses "row" as CL_14's
      // result-item noun.
      if (!file.relative.startsWith("src" + path.sep)) continue;
      if (file.relative.startsWith(ROW_EXEMPT_PREFIX)) continue;

      file.lines.forEach((line, index) => {
        for (const body of userFacingLiteralBodies(stripFrozenCodes(line))) {
          if (hasWord(body, /^rows?$/i)) {
            violations.push(`${file.relative}:${index + 1}: ${line.trim()}`);
          }
        }
      });
    }

    expect(violations).toEqual([]);
  });
});
