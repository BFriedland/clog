import { constants as fsConstants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

import type { PairDiagnosticAdapter } from "../interchange/pairs.js";
import { ClogError } from "../utils/errors.js";
import { normalizeUserPath } from "../utils/paths.js";

export type FillInputKind = "directory" | "archive";

export interface PreparedFillInput extends PairDiagnosticAdapter {
  kind: FillInputKind;
  physicalRoot: string;
  suppliedPath: string;
  inputDescription: string;
  formatSummaryPath(): string;
}

class TranslatedFillInputError extends ClogError {}

export function createPreparedDirectoryInput(inputPath: string): PreparedFillInput {
  const physicalRoot = normalizeUserPath(inputPath);
  const suppliedPath = inputPath;

  const formatPath = (physicalPath: string): string => {
    const relativePath = path.relative(physicalRoot, path.resolve(physicalPath));
    if (!isDescendantPath(relativePath)) {
      throw new ClogError("Fill could not format a path outside the prepared input directory.");
    }

    return appendDisplayPath(suppliedPath, relativePath);
  };

  return {
    kind: "directory",
    physicalRoot,
    suppliedPath,
    inputDescription: "input directory",
    formatPath,
    formatPairPath(normalizedRelativePath: string): string {
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

export async function assertReadableFillDirectory(input: PreparedFillInput): Promise<void> {
  let stat;
  try {
    stat = await fs.stat(input.physicalRoot);
  } catch (error) {
    throw input.translateFilesystemError(
      "Fill directory is not readable:",
      input.physicalRoot,
      error,
    );
  }

  if (!stat.isDirectory()) {
    throw new ClogError(`Fill path is not a directory: ${input.suppliedPath}`);
  }

  try {
    await fs.access(input.physicalRoot, fsConstants.R_OK);
  } catch (error) {
    throw input.translateFilesystemError(
      "Fill directory is not readable:",
      input.physicalRoot,
      error,
    );
  }
}

export function protectFillInputError(
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
    `Failed to process fill input ${input.suppliedPath}${formatFilesystemErrorCode(error)}.`,
    { exitCode: error instanceof ClogError ? error.exitCode : 1 },
  );
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
