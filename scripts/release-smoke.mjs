import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  getExpectedTarballFilename,
  parseExactVersion,
  parseJson,
  repoRoot,
  run,
  runInRepoRoot,
  runCaptureInRepoRoot,
} from "./release-shared.mjs";

const usage =
  "Usage: npm run release:smoke -- <tarball-path|@getclog/clog@version> <version> --allow-network [--keep-temp]";
const MCP_STARTUP_OBSERVATION_MS = 2_000;
const MCP_SHUTDOWN_WAIT_MS = 3_000;

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (process.platform === "win32") {
    throw new Error("Release scripts require macOS, Linux, or Windows Subsystem for Linux.");
  }
  const options = await parseArgs(args);

  const tempRoot = await fs.mkdtemp(path.join(os.tmpdir(), "clog-release-smoke-"));
  const npmPrefix = path.join(tempRoot, "npm-prefix");
  const npmBinDir = path.join(npmPrefix, "bin");
  const npmCache = path.join(tempRoot, "npm-cache");
  const userHome = path.join(tempRoot, "user-home");
  const clogHome = path.join(tempRoot, "clog-home");
  let passed = false;

  await Promise.all([
    fs.mkdir(npmPrefix, { recursive: true }),
    fs.mkdir(userHome, { recursive: true }),
    fs.mkdir(clogHome, { recursive: true }),
  ]);

  const smokeEnv = {
    ...process.env,
    CLOG_HOME: clogHome,
    HOME: userHome,
    PATH: prependPath(npmBinDir, process.env.PATH ?? ""),
    npm_config_audit: "false",
    npm_config_cache: npmCache,
    npm_config_fund: "false",
    npm_config_update_notifier: "false",
  };
  try {
    process.stdout.write(
      `\n==> Installing ${options.installTarget} into an isolated npm prefix\n`,
    );
    await runInRepoRoot([
      "npm",
      "install",
      "--global",
      "--prefix",
      npmPrefix,
      "--omit=dev",
      "--no-audit",
      "--no-fund",
      options.installTarget,
    ], {
      env: smokeEnv,
    });

    const nodeModulesResult = await runCaptureInRepoRoot([
      "npm", "root", "--global", "--prefix", npmPrefix,
    ], {
      env: smokeEnv,
    });
    const installedPackagePath = path.join(
      nodeModulesResult.stdout.trim(),
      "@getclog",
      "clog",
      "package.json",
    );
    const installedPackage = parseJson(
      await fs.readFile(installedPackagePath, "utf8"),
      `installed package manifest at ${installedPackagePath}`,
    );
    if (installedPackage.name !== "@getclog/clog" || installedPackage.version !== options.expectedVersion) {
      throw new Error(
        `Installed package is ${installedPackage.name}@${installedPackage.version}; expected @getclog/clog@${options.expectedVersion}.`,
      );
    }

    const clogBin = path.join(npmBinDir, "clog");
    const mcpBin = path.join(npmBinDir, "clog-mcp");
    await Promise.all([
      assertFileExists(clogBin, "installed clog executable"),
      assertFileExists(mcpBin, "installed clog-mcp executable"),
    ]);

    process.stdout.write(
      "\n==> Running the installed clog --help command by absolute path\n",
    );
    await run([
      clogBin, "--help",
    ], {
      cwd: tempRoot,
      env: smokeEnv,
      stdin: "ignore",
    });

    process.stdout.write(
      "\n==> Initializing the temporary CLOG_HOME without interactive prompts\n",
    );
    await run([
      clogBin, "init",
    ], {
      cwd: tempRoot,
      env: smokeEnv,
      stdin: "ignore",
    });

    process.stdout.write(
      "\n==> Running clog status against the temporary CLOG_HOME\n",
    );
    await run([
      clogBin, "status",
    ], {
      cwd: tempRoot,
      env: smokeEnv,
      stdin: "ignore",
    });

    process.stdout.write(
      "\n==> Confirming the installed clog-mcp server remains running\n",
    );
    await startAndStopMcpServer(mcpBin, { cwd: tempRoot, env: smokeEnv });

    passed = true;
    process.stdout.write(
      `\nRelease smoke test passed for @getclog/clog@${options.expectedVersion}.\n` +
        `Temporary npm prefix: ${npmPrefix}\n` +
        `Temporary CLOG_HOME: ${clogHome}\n`,
    );
  } finally {
    if (passed && !options.keepTemp) {
      await fs.rm(tempRoot, { recursive: true, force: true });
      process.stdout.write("Temporary release-smoke files were removed.\n");
    } else {
      process.stdout.write(`Temporary release-smoke directory kept for inspection: ${tempRoot}\n`);
    }
  }
}

async function parseArgs(args) {
  const positional = args.filter((arg) => !arg.startsWith("--"));
  const flags = args.filter((arg) => arg.startsWith("--"));
  const allowedFlags = new Set(["--allow-network", "--keep-temp"]);
  const unknownFlags = flags.filter((flag) => !allowedFlags.has(flag));
  if (unknownFlags.length > 0 || positional.length !== 2) {
    throw new Error(
      `${usage}${unknownFlags.length > 0 ? `\nUnknown argument(s): ${unknownFlags.join(", ")}.` : ""}`,
    );
  }
  if (!flags.includes("--allow-network")) {
    throw new Error(
      `${usage}\n--allow-network is required because npm may download package dependencies into the temporary prefix.`,
    );
  }

  const [target, versionValue] = positional;
  const expectedVersion = parseExactVersion(versionValue);
  let installTarget;
  if (looksLikeTarballPath(target)) {
    installTarget = path.resolve(repoRoot, target);
    await assertFileExists(installTarget, "release tarball");
    const expectedFilename = getExpectedTarballFilename("@getclog/clog", expectedVersion);
    if (path.basename(installTarget) !== expectedFilename) {
      throw new Error(
        `Release tarball must be named ${expectedFilename} for version ${expectedVersion}; received ${path.basename(installTarget)}.`,
      );
    }
  } else {
    const expectedSpec = `@getclog/clog@${expectedVersion}`;
    if (target !== expectedSpec) {
      throw new Error(`Registry smoke target must be the exact package spec ${expectedSpec}; received ${target}.`);
    }
    installTarget = target;
  }

  return {
    expectedVersion,
    installTarget,
    keepTemp: flags.includes("--keep-temp"),
  };
}

function looksLikeTarballPath(value) {
  return value.endsWith(".tgz") || value.startsWith(".") || path.isAbsolute(value);
}

async function startAndStopMcpServer(command, options) {
  const child = spawn(command, [], {
    cwd: options.cwd,
    env: options.env,
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stdout = "";
  let stderr = "";
  child.stdout?.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr?.on("data", (chunk) => {
    stderr += chunk;
  });
  child.stdin?.on("error", () => {
    // A process that exits between the liveness check and stdin shutdown can
    // close the pipe first; the recorded process exit supplies the diagnostic.
  });

  const exitPromise = new Promise((resolve) => {
    child.once("error", (error) => resolve({ error }));
    child.once("close", (code, signal) => resolve({ code, signal }));
  });
  const initial = await Promise.race([
    exitPromise.then((result) => ({ type: "exit", result })),
    delay(MCP_STARTUP_OBSERVATION_MS).then(() => ({ type: "running" })),
  ]);

  if (initial.type === "exit") {
    throw new Error(
      `clog-mcp exited before the two-second startup check completed: ${formatExit(initial.result)}${
        stderr ? `\nstderr:\n${stderr.trim()}` : ""
      }${stdout ? `\nstdout:\n${stdout.trim()}` : ""}`,
    );
  }

  child.stdin?.end();
  let stopped = await waitForExit(exitPromise, MCP_SHUTDOWN_WAIT_MS);
  if (!stopped) {
    child.kill("SIGTERM");
    stopped = await waitForExit(exitPromise, MCP_SHUTDOWN_WAIT_MS);
  }
  if (!stopped) {
    child.kill("SIGKILL");
    stopped = await waitForExit(exitPromise, MCP_SHUTDOWN_WAIT_MS);
  }
  if (!stopped) {
    throw new Error("clog-mcp remained running after its stdin closed and termination signals were sent.");
  }
}

async function waitForExit(exitPromise, timeoutMs) {
  return Promise.race([
    exitPromise.then(() => true),
    delay(timeoutMs).then(() => false),
  ]);
}

function formatExit(result) {
  if (result.error) {
    return result.error.message;
  }
  return `exit code ${result.code ?? "unknown"}${result.signal ? `, signal ${result.signal}` : ""}`;
}

function prependPath(entry, existingPath) {
  return existingPath ? `${entry}${path.delimiter}${existingPath}` : entry;
}

async function assertFileExists(filePath, label) {
  try {
    await fs.access(filePath);
  } catch {
    throw new Error(`Missing ${label} at ${filePath}.`);
  }
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nRelease smoke test failed: ${message}\n`);
  process.exitCode = 1;
}
