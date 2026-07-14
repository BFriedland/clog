import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { ClogError } from "./errors.js";

export async function withPrivateTempDirectory<T>(
  operation: (directory: string) => Promise<T>,
): Promise<T> {
  let directory: string;
  try {
    directory = await fs.mkdtemp(path.join(os.tmpdir(), "clog-private-"));
  } catch (error) {
    throw new ClogError(
      `Could not create a private clog temporary directory${formatErrorCode(error)}.`,
    );
  }

  try {
    if (process.platform !== "win32") {
      try {
        await fs.chmod(directory, 0o700);
      } catch (error) {
        throw new ClogError(
          `Could not secure a private clog temporary directory${formatErrorCode(error)}.`,
        );
      }
    }
    return await operation(directory);
  } finally {
    try {
      await fs.rm(directory, { recursive: true, force: true });
    } catch {
      process.stderr.write("warning: Could not remove a private clog temporary directory.\n");
    }
  }
}

function formatErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}
