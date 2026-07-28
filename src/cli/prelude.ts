import { closeSync } from "node:fs";
import { isatty } from "node:tty";

import { ClogError } from "../utils/errors.js";
import { loadConfig } from "../config/index.js";
import { ensureClogHome } from "../config/init.js";
import {
  listSavedRelationshipInspectionWarnings,
  refreshSavedRelationshipInspections,
} from "../relationships/refresh.js";
import { collapseAggregatableWarnings, renderWarnings } from "./common.js";

const PRE_ACTION_EXCLUDED_COMMANDS = new Set(["init", "plunge"]);
let exitingForBrokenPipe = false;

export function shouldSkipPreAction(commandName: string, parentCommandName?: string): boolean {
  return PRE_ACTION_EXCLUDED_COMMANDS.has(commandName) || (
    parentCommandName === "mcp" && commandName === "setup"
  );
}

export async function preAction({
  interactive,
  refreshRelationshipInspections = true,
  showRelationshipWarnings = false,
  verboseWarnings = false,
}: {
  interactive: boolean;
  refreshRelationshipInspections?: boolean;
  showRelationshipWarnings?: boolean;
  verboseWarnings?: boolean;
}): Promise<void> {
  await ensureClogHome({ interactive });
  if (!refreshRelationshipInspections) {
    return;
  }
  const config = await loadConfig();
  const refreshWarnings =
    await refreshSavedRelationshipInspections(config);
  if (!showRelationshipWarnings) {
    return;
  }
  const persistedWarnings =
    await listSavedRelationshipInspectionWarnings(config);
  const warnings = [...refreshWarnings, ...persistedWarnings];
  renderWarnings(
    verboseWarnings
      ? warnings
      : collapseAggregatableWarnings(warnings),
  );
}

export function installBrokenPipeHandler(): void {
  // Only stdout: that's the pipe a pager (`clog show | less`) consumes.
  // stderr's EPIPE variant is rarer and untested — extend here if it surfaces.
  process.stdout.on("error", handleStdoutError);
}

function handleStdoutError(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") {
    throw error;
  }

  if (exitingForBrokenPipe) {
    return;
  }
  exitingForBrokenPipe = true;

  if (process.platform !== "win32") {
    // Node can restore a stale TTY snapshot after a pager exits. Closing every
    // TTY-backed stdio descriptor prevents that restore on the EPIPE exit path.
    // See https://github.com/nodejs/node/issues/41143 and issues/35536.
    for (const fd of [0, 2] as const) {
      try {
        if (isatty(fd)) {
          closeSync(fd);
        }
      } catch {
        // The process is terminating; descriptor close races are harmless.
      }
    }
  }

  process.exit(0);
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
