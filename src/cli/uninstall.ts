import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { Command } from "commander";

import { ClogError } from "../utils/errors.js";
import { getClogHome, getSearchRuntimeRoot } from "../utils/paths.js";
import { confirm } from "./common.js";

const CLOG_PACKAGE_NAME = "@getclog/clog";
const CURRENT_PACKAGE_ROOT = path.dirname(
  fileURLToPath(new URL("../../package.json", import.meta.url)),
);

interface UninstallOptions {
  yes?: boolean;
}

export function buildUninstallCommand(): Command {
  return new Command("uninstall")
    .description("Remove clog and its optional search runtime")
    .option("--yes", "Uninstall without prompting")
    .action(async (options: UninstallOptions) => {
      await runUninstallCommand(options);
    });
}

export async function runUninstallCommand(
  options: UninstallOptions = {},
): Promise<void> {
  const clogHome = getClogHome();
  const searchRuntimeRoot = getSearchRuntimeRoot();
  await verifyGlobalPackageRegistration();

  process.stdout.write(
    `This will remove optional vector-search packages and model cache from ${searchRuntimeRoot}.\n`,
  );
  process.stdout.write(`This will remove the global ${CLOG_PACKAGE_NAME} npm package.\n`);
  process.stdout.write(`Other clog data will remain in ${clogHome}.\n`);
  process.stdout.write(
    "MCP registrations in Claude Code and Codex CLI will remain. " +
      "Remove them separately with 'claude mcp remove clog' and 'codex mcp remove clog'.\n",
  );

  if (!options.yes) {
    if (!process.stdin.isTTY) {
      throw new ClogError(
        "Refusing to uninstall without confirmation. Re-run with --yes to confirm.",
      );
    }

    const accepted = await confirm("Continue?");
    if (!accepted) {
      process.stdout.write("Operation cancelled.\n");
      return;
    }
  }

  try {
    await fs.rm(searchRuntimeRoot, { recursive: true, force: true });
  } catch (error) {
    throw new ClogError(
      `Could not remove the optional search runtime at ${searchRuntimeRoot}: ${describeError(error)}. ` +
        "The clog package was not removed; fix the directory problem and run 'clog uninstall' again.",
    );
  }

  process.stdout.write(`No optional search runtime remains at ${searchRuntimeRoot}.\n`);

  let npmExitCode: number | null;
  try {
    npmExitCode = await runNpmUninstall();
  } catch (error) {
    throw new ClogError(
      `No optional search runtime remains at ${searchRuntimeRoot}, but npm package removal could not start: ${describeError(error)}. ` +
        "The npm package remains installed.",
    );
  }

  if (npmExitCode !== 0) {
    throw new ClogError(
      `No optional search runtime remains at ${searchRuntimeRoot}. ` +
        `npm package removal failed with exit code ${npmExitCode ?? "unknown"}, so clog cannot determine whether the package is still installed.`,
      { exitCode: npmExitCode ?? 1 },
    );
  }

  process.stdout.write(`Removed the global ${CLOG_PACKAGE_NAME} npm package.\n`);
  process.stdout.write(
    `Retained clog data in ${clogHome}. Reinstalling clog will recover this library and configuration.\n`,
  );
}

async function verifyGlobalPackageRegistration(): Promise<void> {
  let globalRoot: string | null;
  try {
    globalRoot = await readNpmGlobalRoot();
  } catch (error) {
    throw packageIdentityError(
      `npm could not report its global package directory: ${describeError(error)}`,
    );
  }

  if (!globalRoot) {
    throw packageIdentityError("npm did not report a usable global package directory");
  }

  const registeredPackageRoot = path.join(globalRoot, "@getclog", "clog");
  if (!(await packageDirectoryMatchesCurrentInstall(registeredPackageRoot))) {
    throw packageIdentityError(
      `no registration for the running clog package was found under ${globalRoot}`,
    );
  }
}

async function packageDirectoryMatchesCurrentInstall(packageRoot: string): Promise<boolean> {
  try {
    const raw = await fs.readFile(path.join(packageRoot, "package.json"), "utf8");
    const manifest = JSON.parse(raw) as { name?: unknown };
    if (manifest.name !== CLOG_PACKAGE_NAME) {
      return false;
    }

    const [candidateRealPath, currentRealPath] = await Promise.all([
      fs.realpath(packageRoot),
      fs.realpath(CURRENT_PACKAGE_ROOT),
    ]);
    return path.relative(candidateRealPath, currentRealPath) === "";
  } catch {
    return false;
  }
}

function packageIdentityError(detail: string): ClogError {
  return new ClogError(
    `Could not verify the npm registration for this clog installation: ${detail}. ` +
      "No files were removed. Ensure 'clog' and 'npm' come from the same Node.js installation, then run 'clog uninstall' again.",
  );
}

async function readNpmGlobalRoot(): Promise<string | null> {
  const result = await runNpmForOutput(["root", "--global"]);
  if (result.exitCode !== 0) {
    return null;
  }

  const root = result.stdout.trim();
  return root || null;
}

async function runNpmUninstall(): Promise<number | null> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const useShell = process.platform === "win32";
  const args = ["uninstall", "--global", CLOG_PACKAGE_NAME];

  return new Promise<number | null>((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: "inherit",
      shell: useShell,
    });

    child.once("error", reject);
    child.once("close", resolve);
  });
}

async function runNpmForOutput(args: string[]): Promise<{
  exitCode: number | null;
  stdout: string;
}> {
  const command = process.platform === "win32" ? "npm.cmd" : "npm";
  const useShell = process.platform === "win32";

  return new Promise((resolve, reject) => {
    const child = spawn(command, args, {
      stdio: ["ignore", "pipe", "inherit"],
      shell: useShell,
    });
    let stdout = "";
    child.stdout?.on("data", (chunk) => {
      stdout += String(chunk);
    });

    child.once("error", reject);
    child.once("close", (exitCode) => {
      resolve({ exitCode, stdout });
    });
  });
}

function describeError(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
