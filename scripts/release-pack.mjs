import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import {
  assertNoUnexpectedPackChanges,
  assertVersionFields,
  getExpectedTarballFilename,
  parseExactVersion,
  parseJson,
  repoRoot,
  runCaptureInRepoRoot,
  runInRepoRoot,
  validatePackManifest,
} from "./release-shared.mjs";

const usage = "Usage: npm run release:pack -- <version>";

async function main() {
  const args = process.argv.slice(2);
  if (args.includes("--help") || args.includes("-h")) {
    process.stdout.write(`${usage}\n`);
    return;
  }
  if (process.platform === "win32") {
    throw new Error("Release scripts require macOS, Linux, or Windows Subsystem for Linux.");
  }
  const expectedVersion = parseArgs(args);

  process.stdout.write(
    `\n==> Checking release commit for version ${expectedVersion}\n`,
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
  const packageState = {
    packageJson: parseJson(packageJsonText, "package.json"),
    packageLock: parseJson(packageLockText, "package-lock.json"),
  };
  assertVersionFields(packageState, expectedVersion);

  const artifactFilename = getExpectedTarballFilename(packageState.packageJson.name, expectedVersion);
  const artifactPath = path.join(repoRoot, artifactFilename);
  if (await fileExists(artifactPath)) {
    throw new Error(
      `Refusing to overwrite existing release artifact ${artifactPath}. Inspect or remove it manually before retrying.`,
    );
  }

  const statusResult = await runCaptureInRepoRoot([
    "git", "status", "--porcelain=v1", "--untracked-files=all",
  ]);
  const status = statusResult.stdout.trimEnd();
  if (status) {
    throw new Error(`release:pack requires a clean checkout. Current entries:\n${status}`);
  }

  const tagResult = await runCaptureInRepoRoot([
    "git", "tag", "--list", `v${expectedVersion}`,
  ]);
  if (tagResult.stdout.trim()) {
    throw new Error(`Local Git tag v${expectedVersion} already exists.`);
  }

  const headResult = await runCaptureInRepoRoot([
    "git", "rev-parse", "HEAD",
  ]);
  const upstreamResult = await runCaptureInRepoRoot([
    "git", "rev-parse", "@{upstream}",
  ]);
  const upstreamNameResult = await runCaptureInRepoRoot([
    "git", "rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}",
  ]);
  const head = headResult.stdout.trim();
  const upstream = upstreamResult.stdout.trim();
  const upstreamName = upstreamNameResult.stdout.trim();
  if (head !== upstream) {
    throw new Error(
      `Release commit ${head} does not match ${upstreamName} at ${upstream}. Push main before packing.`,
    );
  }

  process.stdout.write(
    "\n==> Installing dependencies from the lockfile\n",
  );
  await runInRepoRoot([
    "npm", "ci",
  ]);

  process.stdout.write(
    "\n==> Building the exact release commit\n",
  );
  await runInRepoRoot([
    "npm", "run", "build",
  ]);

  const statusAfterInstallResult = await runCaptureInRepoRoot([
    "git", "status", "--porcelain=v1", "--untracked-files=all",
  ]);
  const statusAfterInstall = statusAfterInstallResult.stdout.trimEnd();
  if (statusAfterInstall) {
    throw new Error(`Release preparation changed the checkout:\n${statusAfterInstall}`);
  }

  process.stdout.write(
    "\n==> Creating the release artifact exactly once\n",
  );
  const npmCache = await fs.mkdtemp(path.join(os.tmpdir(), "clog-release-npm-cache-"));
  let packOutput;
  try {
    const packResult = await runCaptureInRepoRoot([
      "npm", "pack", "--ignore-scripts", "--json",
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
    name: packageState.packageJson.name,
    version: expectedVersion,
  });

  if (!(await fileExists(artifactPath))) {
    throw new Error(`npm pack reported ${artifactFilename} but did not create it at ${artifactPath}.`);
  }

  const artifactContents = await fs.readFile(artifactPath);
  const actualShasum = createHash("sha1").update(artifactContents).digest("hex");
  if (packEntry.shasum !== actualShasum) {
    throw new Error(
      `npm reported SHA-1 ${packEntry.shasum}, but the created artifact has SHA-1 ${actualShasum}.`,
    );
  }

  const finalStatusResult = await runCaptureInRepoRoot([
    "git", "status", "--porcelain=v1", "--untracked-files=all",
  ]);
  const finalStatus = finalStatusResult.stdout.trimEnd();
  assertNoUnexpectedPackChanges(finalStatus, artifactFilename);

  process.stdout.write(
    `\nRelease artifact passed inspection.\n` +
      `Commit: ${head} (${upstreamName})\n` +
      `Artifact: ${artifactPath}\n` +
      `Files: ${packEntry.entryCount}\n` +
      `Packed size: ${packEntry.size} bytes\n` +
      `SHA-1: ${actualShasum}\n\n` +
      "Do not rebuild or modify this tarball after its isolated-install smoke test passes.\n" +
      `Confirm continuous integration passed for commit ${head} before publication.\n`,
  );
}

function parseArgs(args) {
  if (args.length !== 1) {
    throw new Error(usage);
  }
  return parseExactVersion(args[0]);
}

async function fileExists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

try {
  await main();
} catch (error) {
  const message = error instanceof Error ? error.message : String(error);
  process.stderr.write(
    `\nRelease artifact creation failed: ${message}\n`,
  );
  process.exitCode = 1;
}
