import { execFile } from "node:child_process";

import { select } from "@inquirer/prompts";
import { Command } from "commander";

import { ClogError, UsageError } from "../utils/errors.js";

export type McpClient = "claude" | "codex";
export type McpSetupTarget = McpClient | "both";

interface ExternalCommandError extends Error {
  code?: number | string | null;
  stdout?: string;
  stderr?: string;
}

const MCP_SERVER_NAME = "clog";
const MCP_SERVER_COMMAND = ["npx", "-y", "clog-mcp"] as const;

const CLIENT_CONFIG: Record<McpClient, {
  label: string;
  executable: string;
  addArgs: string[];
  removeArgs: string[];
}> = {
  claude: {
    label: "Claude Code",
    executable: "claude",
    addArgs: ["mcp", "add", MCP_SERVER_NAME, "--", ...MCP_SERVER_COMMAND],
    removeArgs: ["mcp", "remove", MCP_SERVER_NAME],
  },
  codex: {
    label: "Codex CLI",
    executable: "codex",
    addArgs: ["mcp", "add", MCP_SERVER_NAME, "--", ...MCP_SERVER_COMMAND],
    removeArgs: ["mcp", "remove", MCP_SERVER_NAME],
  },
};

export function buildMcpCommand(): Command {
  const mcp = new Command("mcp").description("Manage MCP integration");

  mcp
    .command("setup")
    .description("Register clog's MCP server with Claude Code, Codex CLI, or both")
    .argument("[client]", "claude, codex, or both")
    .action(async (clientInput: string | undefined) => {
      const interactive = Boolean(process.stdin.isTTY);
      const client = clientInput
        ? parseMcpSetupTarget(clientInput)
        : interactive
        ? await promptForMcpSetupTarget()
        : (() => {
            throw new UsageError("Usage: clog mcp setup <claude|codex|both>");
          })();

      await runMcpSetup(client);
    });

  return mcp;
}

export async function promptForMcpSetupTarget(): Promise<McpSetupTarget> {
  return select<McpSetupTarget>({
    message: "Which MCP client should clog set up?",
    choices: [
      {
        value: "both",
        name: "Both",
        description: "Register clog with both Claude Code and Codex CLI",
      },
      {
        value: "claude",
        name: "Claude Code",
        description: "Run 'claude mcp add clog -- npx -y clog-mcp'",
      },
      {
        value: "codex",
        name: "Codex CLI",
        description: "Run 'codex mcp add clog -- npx -y clog-mcp'",
      },
    ],
    default: "both",
  });
}

export async function runMcpSetup(target: McpSetupTarget): Promise<void> {
  const clients = target === "both" ? (["claude", "codex"] as const) : [target];

  for (const client of clients) {
    await runSingleClientMcpSetup(client);
  }
}

export function parseMcpSetupTarget(input: string): McpSetupTarget {
  const normalized = input.trim().toLowerCase();
  if (normalized === "claude" || normalized === "codex" || normalized === "both") {
    return normalized;
  }

  throw new UsageError(`Unknown MCP client "${input}". Use claude, codex, or both.`);
}

async function runSingleClientMcpSetup(client: McpClient): Promise<void> {
  const config = CLIENT_CONFIG[client];

  try {
    await runExternalCommand(config.executable, config.addArgs);
    process.stdout.write(
      `${config.label} MCP integration configured using '${buildCommandPreview(config.executable, config.addArgs)}'.\n`,
    );
    return;
  } catch (error) {
    if (isCommandMissingError(error)) {
      throw new ClogError(
        `${config.label} is not installed or not on PATH. Install ${config.executable} and try again.`,
      );
    }

    if (!isAlreadyExistsError(error)) {
      throw new ClogError(
        `Could not configure ${config.label} MCP integration.\n${renderExternalCommandError(config.executable, config.addArgs, error)}`,
      );
    }
  }

  try {
    await runExternalCommand(config.executable, config.removeArgs);
  } catch (error) {
    if (isCommandMissingError(error)) {
      throw new ClogError(
        `${config.label} is not installed or not on PATH. Install ${config.executable} and try again.`,
      );
    }

    throw new ClogError(
      `Could not remove the existing clog MCP server from ${config.label}.\n${renderExternalCommandError(config.executable, config.removeArgs, error)}`,
    );
  }

  try {
    await runExternalCommand(config.executable, config.addArgs);
  } catch (error) {
    if (isCommandMissingError(error)) {
      throw new ClogError(
        `${config.label} is not installed or not on PATH. Install ${config.executable} and try again.`,
      );
    }

    throw new ClogError(
      `Could not reconfigure ${config.label} MCP integration.\n${renderExternalCommandError(config.executable, config.addArgs, error)}`,
    );
  }

  process.stdout.write(
    `${config.label} MCP integration replaced using '${buildCommandPreview(config.executable, config.addArgs)}'.\n`,
  );
}

async function runExternalCommand(command: string, args: string[]): Promise<{
  stdout: string;
  stderr: string;
}> {
  return new Promise((resolve, reject) => {
    execFile(command, args, (error, stdout, stderr) => {
      if (error) {
        const externalError = error as ExternalCommandError;
        externalError.stdout = stdout;
        externalError.stderr = stderr;
        reject(externalError);
        return;
      }

      resolve({ stdout, stderr });
    });
  });
}

function isCommandMissingError(error: unknown): boolean {
  return (
    error instanceof Error &&
    "code" in error &&
    (error as ExternalCommandError).code === "ENOENT"
  );
}

function isAlreadyExistsError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const details = `${(error as ExternalCommandError).stdout ?? ""}\n${(error as ExternalCommandError).stderr ?? ""}`;
  return /already exists|already configured|already registered/i.test(details);
}

function buildCommandPreview(command: string, args: string[]): string {
  return [command, ...args].join(" ");
}

function renderExternalCommandError(command: string, args: string[], error: unknown): string {
  const externalError = error as ExternalCommandError;
  const parts = [`Command: ${buildCommandPreview(command, args)}`];
  const stderr = externalError.stderr?.trim();
  const stdout = externalError.stdout?.trim();

  if (stderr) {
    parts.push(`stderr: ${stderr}`);
  }

  if (stdout) {
    parts.push(`stdout: ${stdout}`);
  }

  if (!stderr && !stdout && error instanceof Error) {
    parts.push(error.message);
  }

  return parts.join("\n");
}
