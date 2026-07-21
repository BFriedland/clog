import fs from "node:fs/promises";
import path from "node:path";

import { describe, expect, it } from "vitest";

const allowedUnsafeImporters = new Map<string, string>([
  ["src/db/index.ts", "public write APIs re-check provenance before calling unsafe SQL"],
  ["src/cli/fill-executor.ts", "file import and fill --own writes have origin-specific guards"],
  ["src/sync/reconcile-executor.ts", "git reconciliation writes only rows for the configured remote"],
  ["tests/helpers/db.ts", "tests seed exact database states through unsafe primitives"],
]);

describe("unsafe conversation write import boundary", () => {
  it("keeps unsafe conversation writes behind narrow modules", async () => {
    const violations: string[] = [];
    for (const filePath of await listTypeScriptFiles(".")) {
      const relativePath = toPosix(path.relative(process.cwd(), filePath));
      const source = await fs.readFile(filePath, "utf8");
      if (!importsUnsafeConversationWriter(source)) {
        continue;
      }

      if (allowedUnsafeImporters.has(relativePath)) {
        continue;
      }

      violations.push(relativePath);
    }

    expect(violations).toEqual([]);
  });
});

async function listTypeScriptFiles(root: string): Promise<string[]> {
  const entries = await fs.readdir(root, { withFileTypes: true });
  const files: string[] = [];

  for (const entry of entries) {
    if (
      entry.name === "node_modules" ||
      entry.name === "dist" ||
      entry.name.startsWith(".")
    ) {
      continue;
    }

    const entryPath = path.join(root, entry.name);
    if (entry.isDirectory()) {
      files.push(...await listTypeScriptFiles(entryPath));
    } else if (entry.name.endsWith(".ts")) {
      files.push(entryPath);
    }
  }

  return files;
}

function importsUnsafeConversationWriter(source: string): boolean {
  return /from\s+["'][^"']*unsafe-conversations\.js["']/.test(source);
}

function toPosix(filePath: string): string {
  return filePath.split(path.sep).join("/");
}
