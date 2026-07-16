import { ClogError } from "../utils/errors.js";
import { ensureClogHome } from "../config/init.js";

const PRE_ACTION_EXCLUDED_COMMANDS = new Set(["init", "plunge"]);

export function shouldSkipPreAction(commandName: string, parentCommandName?: string): boolean {
  return PRE_ACTION_EXCLUDED_COMMANDS.has(commandName) || (
    parentCommandName === "mcp" && commandName === "setup"
  );
}

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
    process.exitCode = error instanceof ClogError ? error.exitCode : 1;
  }
}
