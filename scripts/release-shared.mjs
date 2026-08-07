import { spawn } from "node:child_process";
import path from "node:path";
import { isDeepStrictEqual } from "node:util";
import { fileURLToPath } from "node:url";

export const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");

const EXACT_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

const REQUIRED_PACKAGE_FILES = [
  "LICENSE",
  "README.md",
  "clog.png",
  "package.json",
  "dist/index.js",
  "dist/mcp/server.js",
];

const EXECUTABLE_PACKAGE_FILES = ["dist/index.js", "dist/mcp/server.js"];
const ALLOWED_PACKAGE_ROOT_FILES = new Set(["LICENSE", "README.md", "clog.png", "package.json"]);
const EXECUTABLE_MODE_MASK = 0o111;

export function parseExactVersion(value, label = "release version") {
  if (!value || !EXACT_VERSION_PATTERN.test(value)) {
    throw new Error(`${label} must be an exact stable semantic version such as 0.2.1; received ${JSON.stringify(value)}.`);
  }

  return value;
}

export function assertVersionIncreases(committedVersion, releaseVersion) {
  const committed = parseVersionParts(committedVersion, "committed package version");
  const release = parseVersionParts(releaseVersion, "release version");
  if (compareVersionParts(release, committed) <= 0) {
    throw new Error(
      `Release version ${releaseVersion} must be greater than committed package version ${committedVersion}.`,
    );
  }
}

export function assertVersionFields(state, expectedVersion) {
  const fields = [
    ["package.json version", state.packageJson.version],
    ["package-lock.json root version", state.packageLock.version],
    ["package-lock.json packages[''] version", state.packageLock.packages?.[""]?.version],
  ];

  const mismatches = fields.filter(([, value]) => value !== expectedVersion);
  if (mismatches.length > 0) {
    const detail = mismatches
      .map(([label, value]) => `${label} is ${JSON.stringify(value)}`)
      .join("; ");
    throw new Error(`Release version fields do not all equal ${expectedVersion}: ${detail}.`);
  }
}

export function assertOnlyVersionMetadataChanged(headState, workingState) {
  const normalizedPackageJson = structuredClone(workingState.packageJson);
  normalizedPackageJson.version = headState.packageJson.version;
  if (!isDeepStrictEqual(normalizedPackageJson, headState.packageJson)) {
    throw new Error("package.json contains changes other than the release version.");
  }

  const normalizedPackageLock = structuredClone(workingState.packageLock);
  normalizedPackageLock.version = headState.packageLock.version;
  if (!normalizedPackageLock.packages?.[""]) {
    throw new Error("package-lock.json does not contain the root packages[''] record.");
  }
  normalizedPackageLock.packages[""].version = headState.packageLock.packages?.[""]?.version;
  if (!isDeepStrictEqual(normalizedPackageLock, headState.packageLock)) {
    throw new Error("package-lock.json contains changes other than the two package-owned version fields.");
  }
}

export function assertReleaseVersionWorkingTree(statusOutput) {
  const entries = statusOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .sort();
  const expected = [" M package-lock.json", " M package.json"].sort();

  if (!isDeepStrictEqual(entries, expected)) {
    throw new Error(
      "The release-check working tree must contain exactly unstaged version changes to package.json and package-lock.json. " +
        `Current entries: ${entries.length === 0 ? "none" : entries.join(", ")}.`,
    );
  }
}

export function assertNoUnexpectedPackChanges(statusOutput, artifactFilename) {
  const expectedArtifactStatus = `?? ${artifactFilename}`;
  const unexpectedEntries = statusOutput
    .split(/\r?\n/u)
    .filter(Boolean)
    .filter((entry) => entry !== expectedArtifactStatus);

  if (unexpectedEntries.length > 0) {
    throw new Error(
      `The release checkout changed while packing. Unexpected entries:\n${unexpectedEntries.join("\n")}`,
    );
  }
}

export function validatePackManifest(packOutput, expected) {
  if (!Array.isArray(packOutput) || packOutput.length !== 1) {
    throw new Error(`npm pack must describe exactly one package; received ${Array.isArray(packOutput) ? packOutput.length : "non-array output"}.`);
  }

  const entry = packOutput[0];
  if (entry.name !== expected.name) {
    throw new Error(`Packed package name is ${JSON.stringify(entry.name)} instead of ${JSON.stringify(expected.name)}.`);
  }
  if (entry.version !== expected.version) {
    throw new Error(`Packed package version is ${JSON.stringify(entry.version)} instead of ${JSON.stringify(expected.version)}.`);
  }

  const expectedFilename = getExpectedTarballFilename(expected.name, expected.version);
  if (entry.filename !== expectedFilename) {
    throw new Error(`Packed filename is ${JSON.stringify(entry.filename)} instead of ${JSON.stringify(expectedFilename)}.`);
  }

  if (!Array.isArray(entry.files)) {
    throw new Error("npm pack did not return a file manifest.");
  }

  const filesByPath = new Map(entry.files.map((file) => [file.path, file]));
  for (const requiredPath of REQUIRED_PACKAGE_FILES) {
    if (!filesByPath.has(requiredPath)) {
      throw new Error(`Packed artifact is missing required file ${requiredPath}.`);
    }
  }

  for (const file of entry.files) {
    if (!ALLOWED_PACKAGE_ROOT_FILES.has(file.path) && !file.path.startsWith("dist/")) {
      throw new Error(`Packed artifact contains unexpected path ${file.path}.`);
    }
  }

  for (const executablePath of EXECUTABLE_PACKAGE_FILES) {
    const mode = filesByPath.get(executablePath)?.mode;
    if (typeof mode !== "number" || (mode & EXECUTABLE_MODE_MASK) === 0) {
      throw new Error(`Packed executable ${executablePath} does not have an executable mode.`);
    }
  }

  if (entry.entryCount !== entry.files.length) {
    throw new Error(`npm pack entryCount ${entry.entryCount} does not match its ${entry.files.length}-file manifest.`);
  }

  return entry;
}

export function getExpectedTarballFilename(packageName, version) {
  const normalizedName = packageName.replace(/^@/u, "").replaceAll("/", "-");
  return `${normalizedName}-${version}.tgz`;
}

export async function run(commandArgs, options = {}) {
  const result = await runProcess(commandArgs, options);
  if (result.code !== 0) {
    throw commandFailure(commandArgs, result);
  }
  return result;
}

export function runInRepoRoot(commandArgs, options = {}) {
  return run(commandArgs, {
    ...options,
    cwd: repoRoot,
  });
}

export async function runCaptureInRepoRoot(commandArgs, options = {}) {
  const result = await runProcess(commandArgs, {
    ...options,
    cwd: repoRoot,
    quiet: true,
  });
  if (result.code !== 0) {
    throw commandFailure(commandArgs, result);
  }
  return result;
}

export function parseJson(value, label) {
  try {
    return JSON.parse(value);
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseVersionParts(value, label) {
  parseExactVersion(value, label);
  return value.split(".").map(BigInt);
}

function compareVersionParts(left, right) {
  for (let index = 0; index < left.length; index += 1) {
    if (left[index] !== right[index]) {
      return left[index] < right[index] ? -1 : 1;
    }
  }
  return 0;
}

function commandFailure(commandArgs, result) {
  return new Error(
    `Command failed with exit code ${result.code}: ${commandArgs.join(" ")}${
      result.stderr ? `\n${result.stderr.trim()}` : ""
    }`,
  );
}

async function runProcess(commandArgs, options = {}) {
  return new Promise((resolve, reject) => {
    const [command, ...args] = commandArgs;
    const stdin = options.stdin ?? (options.quiet ? "ignore" : "inherit");
    const child = spawn(command, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: options.quiet ? [stdin, "pipe", "pipe"] : [stdin, "inherit", "inherit"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout?.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.on("data", (chunk) => {
      stderr += chunk;
    });
    child.on("error", reject);
    child.on("close", (code) => {
      resolve({ code: code ?? 1, stdout, stderr });
    });
  });
}
