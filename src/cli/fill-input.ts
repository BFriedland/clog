import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { ScanDiagnosticAdapter } from "../interchange/conversation-files.js";
import {
  assertArchiveByteLimit,
  ArchiveError,
  classifyZipSignature,
  extractArchive,
} from "../interchange/archive.js";
import { ClogError, UsageError } from "../utils/errors.js";
import { normalizeUserPath } from "../utils/paths.js";
import { withPrivateTempDirectory } from "../utils/private-temp.js";

type FillInputKind = "directory" | "archive";

export interface PreparedFillInput extends ScanDiagnosticAdapter {
  kind: FillInputKind;
  physicalRoot: string;
  suppliedPath: string;
  inputDescription: string;
  formatSummaryPath(): string;
}

class TranslatedFillInputError extends ClogError {}

function createPreparedDirectoryInput(inputPath: string): PreparedFillInput {
  const physicalRoot = normalizeUserPath(inputPath);
  const suppliedPath = inputPath;

  const formatPath = (physicalPath: string): string => {
    const relativePath = path.relative(physicalRoot, path.resolve(physicalPath));
    if (!isDescendantPath(relativePath)) {
      throw new ClogError("Could not format a path outside the prepared input directory.");
    }

    return appendDisplayPath(suppliedPath, relativePath);
  };

  return {
    kind: "directory",
    physicalRoot,
    suppliedPath,
    inputDescription: "input directory",
    formatPath,
    formatFilesPath(normalizedRelativePath: string): string {
      const relativePath = normalizedRelativePath.split("/").join(path.sep);
      return appendDisplayPath(suppliedPath, relativePath);
    },
    translateFilesystemError(operation: string, physicalPath: string, error: unknown): Error {
      return new TranslatedFillInputError(
        `${operation} ${formatPath(physicalPath)}${formatFilesystemErrorCode(error)}`,
      );
    },
    formatSummaryPath(): string {
      return hasTrailingPathSeparator(suppliedPath)
        ? suppliedPath
        : `${suppliedPath}${path.sep}`;
    },
  };
}

function createPreparedArchiveInput(
  inputPath: string,
  physicalRoot: string,
): PreparedFillInput {
  const suppliedPath = inputPath;
  const resolvedRoot = path.resolve(physicalRoot);

  const formatPath = (physicalPath: string): string => {
    const relativePath = path.relative(resolvedRoot, path.resolve(physicalPath));
    if (!isDescendantPath(relativePath)) {
      throw new ClogError("Could not format a path outside the prepared archive directory.");
    }
    return formatArchiveEntryPath(suppliedPath, relativePath.split(path.sep).join("/"));
  };

  return {
    kind: "archive",
    physicalRoot: resolvedRoot,
    suppliedPath,
    inputDescription: "input archive",
    formatPath,
    formatFilesPath(normalizedRelativePath: string): string {
      return formatArchiveEntryPath(suppliedPath, normalizedRelativePath);
    },
    translateFilesystemError(operation: string, physicalPath: string, error: unknown): Error {
      return new TranslatedFillInputError(
        `${operation} ${formatPath(physicalPath)}${formatFilesystemErrorCode(error)}`,
      );
    },
    formatSummaryPath(): string {
      return suppliedPath;
    },
  };
}

export async function withPreparedFillInput<T>(
  inputPath: string,
  operation: (input: PreparedFillInput) => Promise<T>,
): Promise<T> {
  const directoryInput = createPreparedDirectoryInput(inputPath);
  let stat;
  try {
    stat = await fs.stat(directoryInput.physicalRoot);
  } catch {
    return runPreparedOperation(directoryInput, operation, async () => {
      await assertReadableFillDirectory(directoryInput);
    });
  }

  if (stat.isDirectory()) {
    return runPreparedOperation(directoryInput, operation, async () => {
      await assertReadableFillDirectory(directoryInput);
    });
  }

  if (!stat.isFile()) {
    throw new UsageError(
      `Import path must resolve to a directory or regular zip file: ${inputPath}`,
    );
  }

  const leadingBytes = await readLeadingBytes(directoryInput.physicalRoot, inputPath);
  if (classifyZipSignature(leadingBytes) == null) {
    throw new UsageError(
      `Import file is not a recognized zip archive: ${inputPath}. Use a zip archive or export directory.`,
    );
  }

  assertArchiveByteLimit(stat.size);

  return withPrivateTempDirectory(async (temporaryRoot) => {
    let archiveData;
    try {
      archiveData = await fs.readFile(directoryInput.physicalRoot);
    } catch (error) {
      throw new ArchiveError(
        `Could not read archive ${inputPath}${formatFilesystemErrorCode(error)}.`,
      );
    }

    assertArchiveByteLimit(archiveData.byteLength);
    if (classifyZipSignature(archiveData) == null) {
      throw new ArchiveError(`Archive ${inputPath} changed before it could be decoded.`);
    }

    await extractArchive(archiveData, temporaryRoot, inputPath);
    const archiveInput = createPreparedArchiveInput(inputPath, temporaryRoot);
    return runPreparedOperation(archiveInput, operation);
  });
}

async function assertReadableFillDirectory(input: PreparedFillInput): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(input.physicalRoot);
  } catch (error) {
    throw input.translateFilesystemError(
      "Import path is not readable:",
      input.physicalRoot,
      error,
    );
  }

  if (!stat.isDirectory()) {
    throw new ClogError(`Import path is not a directory: ${input.suppliedPath}`);
  }

  try {
    await fs.access(input.physicalRoot, fsConstants.R_OK);
  } catch (error) {
    throw input.translateFilesystemError(
      "Import path is not readable:",
      input.physicalRoot,
      error,
    );
  }
}

function protectFillInputError(
  input: PreparedFillInput,
  error: unknown,
): unknown {
  if (!(error instanceof Error)) {
    return error;
  }

  if (error instanceof TranslatedFillInputError) {
    return error;
  }

  if (
    input.physicalRoot === input.suppliedPath ||
    !error.message.includes(input.physicalRoot)
  ) {
    return error;
  }

  return new ClogError(
    `Failed to process import input ${input.suppliedPath}${formatFilesystemErrorCode(error)}.`,
    { exitCode: error instanceof ClogError ? error.exitCode : 1 },
  );
}

async function runPreparedOperation<T>(
  input: PreparedFillInput,
  operation: (input: PreparedFillInput) => Promise<T>,
  beforeOperation?: () => Promise<void>,
): Promise<T> {
  try {
    await beforeOperation?.();
    return await operation(input);
  } catch (error) {
    throw protectFillInputError(input, error);
  }
}

async function readLeadingBytes(
  physicalPath: string,
  suppliedPath: string,
): Promise<Uint8Array> {
  let handle;
  try {
    handle = await fs.open(physicalPath, "r");
    const bytes = Buffer.alloc(4);
    const { bytesRead } = await handle.read(bytes, 0, bytes.byteLength, 0);
    return bytes.subarray(0, bytesRead);
  } catch (error) {
    throw new ClogError(
      `Import file is not readable: ${suppliedPath}${formatFilesystemErrorCode(error)}`,
    );
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

function formatArchiveEntryPath(archivePath: string, relativePath: string): string {
  return relativePath.length > 0 ? `${archivePath}:${relativePath}` : archivePath;
}

function appendDisplayPath(displayRoot: string, relativePath: string): string {
  if (relativePath.length === 0) {
    return displayRoot;
  }

  const separator = hasTrailingPathSeparator(displayRoot) ? "" : path.sep;
  return `${displayRoot}${separator}${relativePath}`;
}

function isDescendantPath(relativePath: string): boolean {
  return (
    relativePath.length === 0 ||
    (!path.isAbsolute(relativePath) && relativePath !== ".." && !relativePath.startsWith(`..${path.sep}`))
  );
}

function hasTrailingPathSeparator(value: string): boolean {
  return path.sep === "\\"
    ? value.endsWith("\\") || value.endsWith("/")
    : value.endsWith(path.sep);
}

function formatFilesystemErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}
