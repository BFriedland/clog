import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertOnlyVersionMetadataChanged,
  assertReleaseVersionWorkingTree,
  assertVersionIncreases,
  assertVersionFields,
  parseExactVersion,
  parseJson,
  repoRoot,
  runCaptureInRepoRoot,
  runInRepoRoot,
  validatePackManifest,
} from "./release-shared.mjs";

const usage =
  "Usage: npm run release:check -- <version> (--skip-global-runtime-smoke | --global-runtime-smoke)";

async function main() {
  const args = process.argv.slice(2);

  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }

  if (process.platform === "win32") {
    throw new Error("Release scripts require macOS, Linux, or Windows Subsystem for Linux.");
  }

  const { expectedVersion, runGlobalRuntimeSmoke } = parseArgs(args);

  process.stdout.write(
    `\n==> Checking release version ${expectedVersion}\n`,
  );
  const branchResult = await runCaptureInRepoRoot([
    "git", "branch", "--show-current",
  ]);

  const branch = branchResult.stdout.trim();
  if (branch !== "main") {
    throw new Error(
      `Release scripts require branch main; the current branch is ${JSON.stringify(branch)}.`,
    );
  }

  const packageJsonText = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const packageLockText = await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8");
  const headPackageResult = await runCaptureInRepoRoot([
    "git", "show", "HEAD:package.json",
  ]);
  const headLockResult = await runCaptureInRepoRoot([
    "git", "show", "HEAD:package-lock.json",
  ]);
  const statusResult = await runCaptureInRepoRoot([
    "git", "status", "--porcelain=v1", "--untracked-files=all",
  ]);

  const workingState = {
    packageJson: parseJson(packageJsonText, "package.json"),
    packageLock: parseJson(packageLockText, "package-lock.json"),
  };
  const headState = {
    packageJson: parseJson(headPackageResult.stdout, "HEAD package.json"),
    packageLock: parseJson(headLockResult.stdout, "HEAD package-lock.json"),
  };
  const status = statusResult.stdout.trimEnd();
  assertVersionFields(workingState, expectedVersion);
  assertReleaseVersionWorkingTree(status);
  assertOnlyVersionMetadataChanged(headState, workingState);
  assertVersionIncreases(headState.packageJson.version, expectedVersion);

  process.stdout.write(
    "\n==> Checking the release-version diff for whitespace errors\n",
  );
  await runInRepoRoot([
    "git", "diff", "--check",
  ]);

  process.stdout.write(
    "\n==> Building clog\n",
  );
  await runInRepoRoot([
    "npm", "run", "build",
  ]);

  process.stdout.write(
    "\n==> Running ESLint\n",
  );
  await runInRepoRoot([
    "npm", "run", "lint",
  ]);

  process.stdout.write(
    "\n==> Running Knip\n",
  );
  await runInRepoRoot([
    "npm", "run", "knip",
  ]);

  process.stdout.write(
    "\n==> Running the complete Vitest suite\n",
  );
  await runInRepoRoot([
    "npm", "run", "test",
  ]);

  if (runGlobalRuntimeSmoke) {
    process.stdout.write(
      "\n==> Running the networked global-runtime smoke test\n",
    );
    await runInRepoRoot([
      "npm", "run", "smoke:global-runtime",
    ], {
      env: { ...process.env, CLOG_SMOKE_ALLOW_NETWORK: "1" },
    });
  } else {
    process.stdout.write(
      "\n==> Recording the global-runtime smoke-test decision\n",
    );
    process.stdout.write(
      "Skipped by explicit maintainer choice. This is appropriate only when packaging, dependencies, installed startup, and the search-runtime dependency path are unchanged.\n",
    );
  }

  process.stdout.write(
    "\n==> Inspecting the package manifest without creating a tarball\n",
  );
  const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), "clog-release-npm-cache-"));
  let packOutput;
  try {
    const packResult = await runCaptureInRepoRoot([
      "npm", "pack", "--dry-run", "--ignore-scripts", "--json",
    ], {
      env: {
        ...process.env,
        npm_config_audit: "false",
        npm_config_cache: npmCache,
        npm_config_fund: "false",
        npm_config_update_notifier: "false",
      },
    });
    packOutput = parseJson(packResult.stdout, "npm pack JSON output");
  } finally {
    await fs.rm(npmCache, { recursive: true, force: true });
  }
  const packEntry = validatePackManifest(packOutput, {
    name: workingState.packageJson.name,
    version: expectedVersion,
  });

  process.stdout.write(
    "\n==> Rechecking the final release-version diff\n",
  );
  const finalPackageJsonText = await fs.readFile(path.join(repoRoot, "package.json"), "utf8");
  const finalPackageLockText = await fs.readFile(path.join(repoRoot, "package-lock.json"), "utf8");
  const finalStatusResult = await runCaptureInRepoRoot([
    "git", "status", "--porcelain=v1", "--untracked-files=all",
  ]);
  const finalState = {
    packageJson: parseJson(finalPackageJsonText, "package.json"),
    packageLock: parseJson(finalPackageLockText, "package-lock.json"),
  };
  const finalStatus = finalStatusResult.stdout.trimEnd();
  assertVersionFields(finalState, expectedVersion);
  assertReleaseVersionWorkingTree(finalStatus);
  assertOnlyVersionMetadataChanged(headState, finalState);
  await runInRepoRoot([
    "git", "diff", "--check",
  ]);

  process.stdout.write(
    `\nRelease candidate checks passed for ${packEntry.name}@${packEntry.version}.\n` +
      `Package dry run contains ${packEntry.entryCount} files (${packEntry.size} packed bytes).\n` +
      "The maintainer must review the complete Git diff before staging the version files.\n",
  );
}

function parseArgs(args) {
  const expectedVersion = parseExactVersion(args[0]);
  const flags = args.slice(1);
  const allowedFlags = new Set(["--skip-global-runtime-smoke", "--global-runtime-smoke"]);
  const unknownFlags = flags.filter((flag) => !allowedFlags.has(flag));
  if (unknownFlags.length > 0) {
    throw new Error(`${usage}\nUnknown argument(s): ${unknownFlags.join(", ")}.`);
  }

  const skip = flags.includes("--skip-global-runtime-smoke");
  const runSmoke = flags.includes("--global-runtime-smoke");
  if (skip === runSmoke) {
    throw new Error(`${usage}\nChoose exactly one global-runtime smoke-test disposition.`);
  }

  return { expectedVersion, runGlobalRuntimeSmoke: runSmoke };
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(`\nRelease candidate check failed: ${message}\n`);
  process.exitCode = 1;
}
