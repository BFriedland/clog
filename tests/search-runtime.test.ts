import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock.mockImplementation(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("exit", 0));
    return child;
  }),
}));

import { getDefaultConfig, saveConfig } from "../src/config/index.js";
import { getSearchProviders, resetSearchProviders, searchAvailable } from "../src/search/deps.js";
import { SearchDepsError } from "../src/search/errors.js";
import {
  assertSearchRuntimePackagesImportable,
  buildSearchRuntimeInstallCommand,
  formatSearchRuntimeInstallCommand,
  importSearchRuntimePackage,
  installSearchRuntimePackages,
  searchRuntimePackagesInstalled,
} from "../src/search/runtime.js";
import { getSearchRuntimeRoot } from "../src/utils/paths.js";

describe("search runtime", () => {
  let tempDir: string;
  let originalClogHome: string | undefined;

  beforeEach(async () => {
    originalClogHome = process.env.CLOG_HOME;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-search-runtime-"));
    process.env.CLOG_HOME = tempDir;
    spawnMock.mockClear();
    resetSearchProviders();
  });

  afterEach(async () => {
    resetSearchProviders();
    if (originalClogHome === undefined) {
      delete process.env.CLOG_HOME;
    } else {
      process.env.CLOG_HOME = originalClogHome;
    }

    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("builds an npm install command scoped to the clog-owned runtime", () => {
    const command = buildSearchRuntimeInstallCommand(["vectra", "@huggingface/transformers"]);

    expect(command.command).toMatch(/^npm/);
    expect(command.args).toEqual([
      "install",
      "--prefix",
      getSearchRuntimeRoot(),
      "vectra@^0.15.0",
      "@huggingface/transformers@^4.2.0",
    ]);
  });

  it("quotes the displayed npm install command when the runtime path contains spaces", () => {
    process.env.CLOG_HOME = path.join(tempDir, "clog home with spaces");

    const command = formatSearchRuntimeInstallCommand(["vectra"]);

    if (process.platform === "win32") {
      expect(command).toContain(`"--prefix" "${getSearchRuntimeRoot()}"`);
    } else {
      expect(command).toContain(`--prefix '${getSearchRuntimeRoot()}'`);
    }
  });

  it("pins runtime package versions to match the dev manifest", async () => {
    const manifest = JSON.parse(
      await fs.readFile(new URL("../package.json", import.meta.url), "utf8"),
    ) as { devDependencies: Record<string, string> };

    const command = buildSearchRuntimeInstallCommand(["vectra", "@huggingface/transformers"]);
    const specs = command.args.slice(3); // trailing args after install/--prefix/<root>
    expect(specs.length).toBeGreaterThan(0);

    for (const spec of specs) {
      const at = spec.lastIndexOf("@");
      const name = spec.slice(0, at);
      const range = spec.slice(at + 1);
      // The version clog installs at runtime must match what tests/types build
      // against, so the resolver and the dev manifest can't silently drift.
      expect(manifest.devDependencies[name]).toBe(range);
    }
  });

  it("repairs an invalid runtime package manifest before installing packages", async () => {
    const packageJsonPath = path.join(getSearchRuntimeRoot(), "package.json");
    await fs.mkdir(getSearchRuntimeRoot(), { recursive: true });
    await fs.writeFile(packageJsonPath, "{", "utf8");

    await installSearchRuntimePackages(["fake-search-runtime-package"]);

    expect(JSON.parse(await fs.readFile(packageJsonPath, "utf8"))).toMatchObject({
      name: "clog-search-runtime",
      private: true,
      description: "Optional runtime packages for clog vector search.",
    });
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("preserves an existing valid runtime package manifest before installing packages", async () => {
    const packageJsonPath = path.join(getSearchRuntimeRoot(), "package.json");
    const manifest = {
      name: "existing-search-runtime",
      private: true,
      dependencies: {
        "fake-search-runtime-package": "1.0.0",
      },
    };
    await fs.mkdir(getSearchRuntimeRoot(), { recursive: true });
    await fs.writeFile(packageJsonPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");

    await installSearchRuntimePackages(["fake-search-runtime-package"]);

    expect(JSON.parse(await fs.readFile(packageJsonPath, "utf8"))).toEqual(manifest);
    expect(spawnMock).toHaveBeenCalledOnce();
  });

  it("imports packages from the clog-owned runtime", async () => {
    const packageRoot = path.join(
      getSearchRuntimeRoot(),
      "node_modules",
      "fake-search-runtime-package",
    );
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "fake-search-runtime-package",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(packageRoot, "index.js"), "export const value = 42;\n", "utf8");

    const module = await importSearchRuntimePackage<{ value: number }>(
      "fake-search-runtime-package",
    );

    expect(module.value).toBe(42);
  });

  it("reports missing packages through the search setup path", async () => {
    await expect(importSearchRuntimePackage("missing-search-runtime-package")).rejects.toThrow(
      SearchDepsError,
    );
  });

  it("ignores vector search packages installed outside the clog-owned runtime", () => {
    expect(searchRuntimePackagesInstalled(["vectra", "@huggingface/transformers"])).toBe(false);
  });

  it("rejects packages that resolve from the clog-owned runtime but cannot be imported", async () => {
    const packageRoot = path.join(
      getSearchRuntimeRoot(),
      "node_modules",
      "broken-search-runtime-package",
    );
    await fs.mkdir(packageRoot, { recursive: true });
    await fs.writeFile(
      path.join(packageRoot, "package.json"),
      `${JSON.stringify({
        name: "broken-search-runtime-package",
        version: "1.0.0",
        type: "module",
        main: "index.js",
      }, null, 2)}\n`,
      "utf8",
    );
    await fs.writeFile(path.join(packageRoot, "index.js"), 'import "./missing.js";\n', "utf8");

    expect(searchRuntimePackagesInstalled(["broken-search-runtime-package"])).toBe(true);
    await expect(importSearchRuntimePackage("broken-search-runtime-package")).rejects.toMatchObject(
      {
        cause: expect.any(Error),
        message: expect.stringContaining("Import error:"),
      },
    );
    await expect(
      assertSearchRuntimePackagesImportable(["broken-search-runtime-package"]),
    ).rejects.toMatchObject({
      cause: expect.any(Error),
      message: expect.stringContaining("Import error:"),
    });
  });

  it("rejects runtime packages that import but do not expose the API clog uses", async () => {
    await createRuntimePackage("@huggingface/transformers", "export const env = {};\n");
    await createRuntimePackage("vectra", "export class LocalIndex {}\n");

    expect(searchRuntimePackagesInstalled(["@huggingface/transformers", "vectra"])).toBe(true);
    await expect(
      assertSearchRuntimePackagesImportable(["@huggingface/transformers"]),
    ).rejects.toMatchObject({
      cause: expect.any(Error),
      message: expect.stringContaining("pipeline"),
    });
    await expect(assertSearchRuntimePackagesImportable(["vectra"])).rejects.toMatchObject({
      cause: expect.any(Error),
      message: expect.stringContaining("LocalFileStorage"),
    });
  });

  it("treats configured search as unavailable when runtime packages resolve but cannot import", async () => {
    const config = getDefaultConfig("testuser");
    config.search = {
      embedding: { type: "transformers", model: "Xenova/all-MiniLM-L6-v2" },
      vectorStore: { type: "vectra" },
    };
    await saveConfig(config);
    await createRuntimePackage("@huggingface/transformers", 'import "./missing.js";\n');
    await createRuntimePackage("vectra", "export const value = 42;\n");

    expect(searchRuntimePackagesInstalled(["@huggingface/transformers", "vectra"])).toBe(true);
    await expect(getSearchProviders()).rejects.toThrow(SearchDepsError);
    await expect(searchAvailable()).resolves.toBe(false);
  });
});

async function createRuntimePackage(moduleName: string, source: string): Promise<void> {
  const packageRoot = path.join(
    getSearchRuntimeRoot(),
    "node_modules",
    ...moduleName.split("/"),
  );
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({
      name: moduleName,
      version: "1.0.0",
      type: "module",
      main: "index.js",
    }, null, 2)}\n`,
    "utf8",
  );
  await fs.writeFile(path.join(packageRoot, "index.js"), source, "utf8");
}
