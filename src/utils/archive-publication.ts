import { randomUUID } from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";

import { ClogError } from "./errors.js";

export async function assertArchivePublicationDestination(
  destination: string,
  options: { force: boolean },
): Promise<void> {
  const parent = path.dirname(destination);
  let parentStat;
  try {
    parentStat = await fs.stat(parent);
  } catch (error) {
    throw new ClogError(
      `Archive destination parent does not exist or is not readable: ${parent}${formatErrorCode(error)}`,
    );
  }

  if (!parentStat.isDirectory()) {
    throw new ClogError(`Archive destination parent is not a directory: ${parent}`);
  }

  const existing = await lstatIfPresent(destination);
  if (!existing) {
    return;
  }

  if (!existing.isFile() || existing.isSymbolicLink()) {
    throw new ClogError(
      `Archive destination must be absent or an ordinary file: ${destination}`,
    );
  }

  if (!options.force) {
    throw new ClogError(
      `Archive destination already exists: ${destination}. Use --force to replace it.`,
    );
  }
}

export async function publishArchiveAtomic(
  destination: string,
  data: Uint8Array,
  options: { force: boolean },
): Promise<void> {
  const tempPath = path.join(
    path.dirname(destination),
    `.${path.basename(destination)}.${process.pid}.${randomUUID()}.tmp`,
  );

  try {
    try {
      await fs.writeFile(tempPath, data, { flag: "wx", mode: 0o600 });
    } catch (error) {
      throw new ClogError(
        `Could not stage archive output for ${destination}${formatErrorCode(error)}.`,
      );
    }

    await assertArchivePublicationDestination(destination, options);

    try {
      await fs.rename(tempPath, destination);
    } catch (error) {
      throw new ClogError(
        `Could not publish archive output to ${destination}${formatErrorCode(error)}.`,
      );
    }
  } finally {
    await fs.rm(tempPath, { force: true }).catch(() => undefined);
  }
}

async function lstatIfPresent(filePath: string): Promise<Awaited<ReturnType<typeof fs.lstat>> | null> {
  try {
    return await fs.lstat(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return null;
    }
    throw new ClogError(
      `Could not inspect archive destination ${filePath}${formatErrorCode(error)}.`,
    );
  }
}

function formatErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}
