import { ClogError } from "../utils/errors.js";
import { ensureClogHome } from "../config/init.js";

export async function preAction({ interactive }: { interactive: boolean }): Promise<void> {
  await ensureClogHome({ interactive });
}

export async function runWithCliErrorHandling(
  fn: () => Promise<void>,
): Promise<void> {
  if (process.env.CLOG_DEBUG === "1") {
    await fn();
    return;
  }

  try {
    await fn();
  } catch (error) {
    const message =
      error instanceof Error ? error.message : "Unknown error";
    process.stderr.write(`error: ${message}\n`);
    process.exitCode = 1;
  }
}

export function fail(message: string): never {
  throw new ClogError(message);
}
