import { spawn } from "node:child_process";
import { realpathSync } from "node:fs";
import fs from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { writeFileAtomic } from "../utils/atomic-write.js";
import { getSearchRuntimeRoot } from "../utils/paths.js";
import { SearchDepsError } from "./errors.js";

export const SEARCH_RUNTIME_PACKAGE_INSTALL_SIZE = "~470MB";
export const SEARCH_RUNTIME_MODEL_DOWNLOAD_SIZE = "30MB";

const SEARCH_RUNTIME_PACKAGE_SPECS: Record<string, string> = {
  "@huggingface/transformers": "@huggingface/transformers@^4.2.0",
  vectra: "vectra@^0.15.0",
};

const SEARCH_RUNTIME_PACKAGE_JSON = {
  name: "clog-search-runtime",
  private: true,
  description: "Optional runtime packages for clog vector search.",
};

const SEARCH_RUNTIME_PACKAGE_VALIDATORS: Record<string, (runtimeModule: unknown) => string[]> = {
  "@huggingface/transformers": (runtimeModule) => {
    const transformers = runtimeModule as {
      env?: unknown;
      pipeline?: unknown;
    };
    const missing: string[] = [];
    if (typeof transformers.pipeline !== "function") {
      missing.push("pipeline");
    }
    if (transformers.env === null || typeof transformers.env !== "object") {
      missing.push("env");
    }
    return missing;
  },
  vectra: (runtimeModule) => {
    const vectra = runtimeModule as {
      LocalFileStorage?: unknown;
      LocalIndex?: unknown;
    };
    const missing: string[] = [];
    if (typeof vectra.LocalIndex !== "function") {
      missing.push("LocalIndex");
    }
    if (typeof vectra.LocalFileStorage !== "function") {
      missing.push("LocalFileStorage");
    }
    return missing;
  },
};

// Resolve the package to a file path (via require.resolve, see
// resolveSearchRuntimePackage) and then dynamic-import that file. require.resolve
// applies the package's `require`/CJS export condition, so we load each package's
// CJS build (e.g. transformers.node.cjs) rather than its ESM build. This is
// deliberate: clog depends on these packages exposing usable named exports from
// their CJS builds (transformers' `pipeline`/`env`, vectra's
// `LocalIndex`/`LocalFileStorage`), and routing every load through this single
// resolver keeps one module instance per process — so mutating transformers'
// `env` singleton (e.g. env.cacheDir in embeddings/transformers.ts) stays
// consistent across callers instead of risking a dual-package (ESM+CJS) split.
export async function importSearchRuntimePackage<TModule>(moduleName: string): Promise<TModule> {
  const resolved = resolveSearchRuntimePackage(moduleName);
  if (!resolved) {
    throw new SearchDepsError([moduleName]);
  }

  try {
    const runtimeModule = await import(pathToFileURL(resolved).href) as TModule;
    validateSearchRuntimePackage(moduleName, runtimeModule);
    return runtimeModule;
  } catch (error) {
    throw new SearchDepsError([moduleName], { reason: "unusable", cause: error });
  }
}

export function searchRuntimePackagesInstalled(packages: string[]): boolean {
  return packages.every((packageName) => resolveSearchRuntimePackage(packageName) !== null);
}

export function assertSearchRuntimePackagesInstalled(packages: string[]): void {
  const missing = packages.filter((packageName) => resolveSearchRuntimePackage(packageName) === null);
  if (missing.length > 0) {
    throw new SearchDepsError(missing);
  }
}

export async function assertSearchRuntimePackagesImportable(packages: string[]): Promise<void> {
  assertSearchRuntimePackagesInstalled(packages);

  for (const packageName of packages) {
    await importSearchRuntimePackage<unknown>(packageName);
  }
}

export function buildSearchRuntimeInstallCommand(packages: string[]): {
  command: string;
  args: string[];
} {
  const executable = process.platform === "win32" ? "npm.cmd" : "npm";
  const packageSpecs = packages.map((packageName) => {
    return SEARCH_RUNTIME_PACKAGE_SPECS[packageName] ?? packageName;
  });

  return {
    command: executable,
    args: ["install", "--prefix", getSearchRuntimeRoot(), ...packageSpecs],
  };
}

export function formatSearchRuntimeInstallCommand(packages: string[]): string {
  const { command, args } = buildSearchRuntimeInstallCommand(packages);
  return formatShellCommand(command, args);
}

export async function installSearchRuntimePackages(packages: string[]): Promise<void> {
  await ensureSearchRuntimePackageJson();

  const { command, args } = buildSearchRuntimeInstallCommand(packages);
  // On Windows, npm is a `.cmd` shim, and since the CVE-2024-27980 fix (present
  // in all Node 22.x) spawning a `.cmd`/`.bat` with shell:false throws EINVAL —
  // so run it through a shell there. Under shell:true the args are joined into
  // the cmd.exe command line verbatim, so each must be quoted to survive spaces
  // (the install-prefix path) and cmd metacharacters — notably the `^` in
  // version ranges like `^4.2.0`, which cmd would otherwise strip.
  const useShell = process.platform === "win32";
  await new Promise<void>((resolve, reject) => {
    const child = spawn(
      useShell ? quoteWindowsShellArg(command) : command,
      useShell ? args.map(quoteWindowsShellArg) : args,
      {
        stdio: "inherit",
        shell: useShell,
      },
    );

    child.on("error", reject);
    child.on("exit", (code) => {
      if (code === 0) {
        resolve();
        return;
      }

      reject(new Error(`Package installation failed with exit code ${code ?? "unknown"}.`));
    });
  });
}

function quoteWindowsShellArg(arg: string): string {
  return `"${arg.replace(/"/g, '""')}"`;
}

function formatShellCommand(command: string, args: string[]): string {
  if (process.platform === "win32") {
    return [command, ...args].map(quoteWindowsShellArg).join(" ");
  }

  return [command, ...args].map(quotePosixShellArg).join(" ");
}

function quotePosixShellArg(arg: string): string {
  if (/^[A-Za-z0-9_./:@%+=,^-]+$/.test(arg)) {
    return arg;
  }

  return `'${arg.replace(/'/g, "'\\''")}'`;
}

function validateSearchRuntimePackage(moduleName: string, runtimeModule: unknown): void {
  const validate = SEARCH_RUNTIME_PACKAGE_VALIDATORS[moduleName];
  if (!validate) {
    return;
  }

  const missingExports = validate(runtimeModule);
  if (missingExports.length === 0) {
    return;
  }

  throw new Error(
    `${moduleName} is missing required export${missingExports.length === 1 ? "" : "s"}: ${
      missingExports.join(", ")
    }`,
  );
}

// Resolve against the clog-owned runtime only. createRequire walks up from
// runtimeRoot, so the isPathInside guard rejects anything that resolves from a
// parent or global node_modules. require.resolve here picks the `require`/CJS
// condition (see importSearchRuntimePackage for why that's intentional).
function resolveSearchRuntimePackage(moduleName: string): string | null {
  const runtimeRoot = path.resolve(getSearchRuntimeRoot());
  const requireFromRuntime = createRequire(path.join(runtimeRoot, "package.json"));

  try {
    const resolved = requireFromRuntime.resolve(moduleName);
    if (isPathInside(resolved, runtimeRoot)) {
      return resolved;
    }
  } catch {
    return null;
  }

  return null;
}

function isPathInside(candidate: string, parent: string): boolean {
  const relative = path.relative(
    normalizeExistingPath(parent),
    normalizeExistingPath(candidate),
  );
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

function normalizeExistingPath(candidate: string): string {
  try {
    return realpathSync.native(candidate);
  } catch {
    return path.resolve(candidate);
  }
}

async function ensureSearchRuntimePackageJson(): Promise<void> {
  const runtimeRoot = getSearchRuntimeRoot();
  await fs.mkdir(runtimeRoot, { recursive: true });

  const packageJsonPath = path.join(runtimeRoot, "package.json");

  if (await hasValidSearchRuntimePackageJson(packageJsonPath)) {
    return;
  }

  await writeFileAtomic(
    packageJsonPath,
    `${JSON.stringify(SEARCH_RUNTIME_PACKAGE_JSON, null, 2)}\n`,
  );
}

async function hasValidSearchRuntimePackageJson(packageJsonPath: string): Promise<boolean> {
  let raw: string;
  try {
    raw = await fs.readFile(packageJsonPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return false;
    }

    throw error;
  }

  try {
    const parsed = JSON.parse(raw);
    return parsed !== null && typeof parsed === "object" && !Array.isArray(parsed);
  } catch {
    return false;
  }
}
