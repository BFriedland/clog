import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline/promises";
import { fileURLToPath, pathToFileURL } from "node:url";

// This smoke test exercises the user-facing package install path that npm link
// can hide during development: pack clog, install that tarball into a temporary
// global npm prefix, then verify vector search packages install into a temporary
// CLOG_HOME/search-runtime instead of resolving from this checkout's dev deps.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const npmCommand = process.platform === "win32" ? "npm.cmd" : "npm";
const searchPackages = ["vectra", "@huggingface/transformers"];

async function main() {
  await confirmExternalNetworkAccess();

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clog-global-runtime-smoke-"));
  const packDir = path.join(tempRoot, "pack");
  const npmCache = path.join(tempRoot, "npm-cache");
  const npmPrefix = path.join(tempRoot, "npm-prefix");
  const clogHome = path.join(tempRoot, "clog-home");
  const keepTemp = process.env.CLOG_SMOKE_KEEP_TEMP === "1";

  await fs.mkdir(packDir, { recursive: true });
  await fs.mkdir(npmPrefix, { recursive: true });
  await fs.mkdir(clogHome, { recursive: true });

  const smokeEnv = {
    CLOG_HOME: clogHome,
    PATH: prependPath(getGlobalBinDir(npmPrefix), process.env.PATH ?? ""),
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };

  Object.assign(process.env, smokeEnv);
  const env = { ...process.env };

  try {
    await assertFileExists(
      getLocalBinPath("tsc"),
      "local TypeScript compiler. Run npm install before this smoke test",
    );

    step("Building clog from the current checkout");
    await run(npmCommand, ["run", "build"], {
      cwd: repoRoot,
      env,
    });

    step("Packing the built clog output");
    await run(npmCommand, ["pack", "--ignore-scripts", "--pack-destination", packDir], {
      cwd: repoRoot,
      env,
    });
    const tarballPath = await findSingleTarball(packDir);

    step(`Installing packed clog into temporary npm prefix: ${npmPrefix}`);
    await run(
      npmCommand,
      ["install", "--global", "--prefix", npmPrefix, "--omit=dev", "--no-audit", "--no-fund", tarballPath],
      { cwd: repoRoot, env },
    );

    const clogBin = getGlobalBinPath(npmPrefix, "clog");
    await assertFileExists(clogBin, "temporary clog executable");

    step("Verifying the temporary clog executable starts");
    await run(clogBin, ["--help"], { cwd: repoRoot, env, quiet: true });

    const packageRoot = path.join(await getGlobalNodeModulesRoot(npmPrefix, env), "@getclog", "clog");
    await assertFileExists(path.join(packageRoot, "package.json"), "packed clog package.json");

    step("Verifying optional search packages are absent from the packed install");
    await assertMissing(
      path.join(packageRoot, "node_modules", "vectra"),
      "vectra should not be installed inside the packed clog package",
    );
    await assertMissing(
      path.join(packageRoot, "node_modules", "@huggingface", "transformers"),
      "@huggingface/transformers should not be installed inside the packed clog package",
    );

    const runtime = await import(
      pathToFileURL(path.join(packageRoot, "dist", "search", "runtime.js")).href
    );

    if (runtime.searchRuntimePackagesInstalled(searchPackages)) {
      throw new Error(
        "Search runtime packages resolved before the smoke test installed them. The packed install is not exercising the clog-owned search runtime path.",
      );
    }

    step(`Installing vector search packages into temporary CLOG_HOME: ${clogHome}`);
    await runtime.installSearchRuntimePackages(searchPackages);

    step("Verifying vector search packages resolve from the clog-owned search runtime");
    if (!runtime.searchRuntimePackagesInstalled(searchPackages)) {
      throw new Error("Search runtime packages did not resolve after installation.");
    }

    const vectra = await runtime.importSearchRuntimePackage("vectra");
    if (typeof vectra.LocalIndex !== "function") {
      throw new Error("vectra resolved from the search runtime but did not expose LocalIndex as a usable export.");
    }
    const transformers = await runtime.importSearchRuntimePackage("@huggingface/transformers");
    if (typeof transformers.pipeline !== "function") {
      throw new Error(
        "@huggingface/transformers resolved from the search runtime but did not expose pipeline as a usable export.",
      );
    }
    await assertFileExists(
      path.join(clogHome, "search-runtime", "node_modules", "vectra", "package.json"),
      "vectra package.json in search runtime",
    );
    await assertFileExists(
      path.join(
        clogHome,
        "search-runtime",
        "node_modules",
        "@huggingface",
        "transformers",
        "package.json",
      ),
      "@huggingface/transformers package.json in search runtime",
    );

    process.stdout.write("\nGlobal runtime smoke test passed.\n");
    if (keepTemp) {
      process.stdout.write(`Temporary npm prefix: ${npmPrefix}\n`);
      process.stdout.write(`Temporary CLOG_HOME: ${clogHome}\n`);
    } else {
      process.stdout.write("Temporary npm prefix and CLOG_HOME will be removed.\n");
    }
  } finally {
    if (keepTemp) {
      process.stdout.write(`\nKept temporary smoke directory: ${tempRoot}\n`);
    } else {
      await fs.rm(tempRoot, { recursive: true, force: true });
    }
  }
}

function step(message) {
  process.stdout.write(`\n==> ${message}\n`);
}

async function confirmExternalNetworkAccess() {
  if (process.env.CLOG_SMOKE_ALLOW_NETWORK === "1") {
    return;
  }

  const message = [
    "This smoke test installs real npm packages into temporary directories.",
    "It can make external network calls to the npm registry while installing the packed clog package and the vector search runtime packages: vectra and @huggingface/transformers.",
    "It does not download Hugging Face model files.",
    "",
  ].join("\n");

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    throw new Error(
      `${message}Set CLOG_SMOKE_ALLOW_NETWORK=1 to confirm this in a non-interactive shell.`,
    );
  }

  process.stdout.write(`\n${message}\n`);

  const rl = createInterface({
    input: process.stdin,
    output: process.stdout,
  });

  try {
    const answer = await rl.question('Continue? Type "yes" to proceed: ');
    if (answer.trim().toLowerCase() !== "yes") {
      throw new Error('"yes" not provided.');
    }
  } finally {
    rl.close();
  }
}

function prependPath(entry, existingPath) {
  return existingPath ? `${entry}${path.delimiter}${existingPath}` : entry;
}

function getGlobalBinDir(prefix) {
  if (process.platform === "win32") {
    return prefix;
  }

  return path.join(prefix, "bin");
}

function getGlobalBinPath(prefix, name) {
  if (process.platform === "win32") {
    return path.join(prefix, `${name}.cmd`);
  }

  return path.join(getGlobalBinDir(prefix), name);
}

function getLocalBinPath(name) {
  const executable = process.platform === "win32" ? `${name}.cmd` : name;
  return path.join(repoRoot, "node_modules", ".bin", executable);
}

async function getGlobalNodeModulesRoot(prefix, env) {
  const result = await runCapture(npmCommand, ["root", "--global", "--prefix", prefix], {
    cwd: repoRoot,
    env,
  });
  return result.stdout.trim();
}

async function findSingleTarball(packDir) {
  const entries = await fs.readdir(packDir);
  const tarballs = entries.filter((entry) => entry.endsWith(".tgz"));

  if (tarballs.length !== 1) {
    throw new Error(`Expected npm pack to create one tarball in ${packDir}, found ${tarballs.length}.`);
  }

  return path.join(packDir, tarballs[0]);
}

async function assertFileExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing ${label} at ${filePath}`);
  }
}

async function assertMissing(filePath, message) {
  try {
    await fs.access(filePath);
  } catch {
    return;
  }

  throw new Error(`${message}: ${filePath}`);
}

async function run(command, args, options = {}) {
  const result = await runProcess(command, args, options);
  if (result.code !== 0) {
    throw new Error(
      `Command failed with exit code ${result.code}: ${[command, ...args].join(" ")}${
        result.stderr ? `\n${result.stderr.trim()}` : ""
      }`,
    );
  }
}

async function runCapture(command, args, options = {}) {
  const result = await runProcess(command, args, { ...options, quiet: true });
  if (result.code !== 0) {
    throw new Error(
      `Command failed with exit code ${result.code}: ${[command, ...args].join(" ")}${
        result.stderr ? `\n${result.stderr.trim()}` : ""
      }`,
    );
  }

  return result;
}

function quoteWindowsShellArg(arg) {
  return `"${String(arg).replace(/"/g, '""')}"`;
}

async function runProcess(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    // Mirror src/search/runtime.ts: on Windows the .cmd shims (npm.cmd, clog.cmd)
    // need shell:true since the CVE-2024-27980 fix, and shell:true requires
    // quoting the command and args for spaces and cmd metacharacters.
    const useShell = process.platform === "win32";
    const child = spawn(
      useShell ? quoteWindowsShellArg(command) : command,
      useShell ? args.map(quoteWindowsShellArg) : args,
      {
        cwd: options.cwd,
        env: options.env,
        shell: useShell,
        stdio: options.quiet ? ["ignore", "pipe", "pipe"] : "inherit",
      },
    );

    let stdout = "";
    let stderr = "";

    if (child.stdout) {
      child.stdout.on("data", (chunk) => {
        stdout += chunk;
      });
    }

    if (child.stderr) {
      child.stderr.on("data", (chunk) => {
        stderr += chunk;
      });
    }

    child.on("error", reject);
    child.on("close", (code) => {
      resolve({
        code: code ?? 1,
        stdout,
        stderr,
      });
    });
  });
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nSmoke test failed: ${message}\n`);
  process.exitCode = 1;
}
