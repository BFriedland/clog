import { spawn } from "node:child_process";

export class GitError extends Error {
  readonly stderr: string;
  readonly exitCode: number | null;

  constructor(message: string, stderr: string, exitCode: number | null) {
    super(message);
    this.name = "GitError";
    this.stderr = stderr;
    this.exitCode = exitCode;
  }
}

export interface GitRunOptions {
  cwd?: string;
  stdin?: string;
}

export interface GitRunResult {
  stdout: string;
  stderr: string;
}

export async function runGit(
  args: string[],
  options: GitRunOptions = {},
): Promise<GitRunResult> {
  return new Promise((resolve, reject) => {
    const child = spawn("git", args, {
      cwd: options.cwd,
      env: process.env,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";

    child.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });

    child.on("error", (error) => {
      reject(
        new GitError(
          `Failed to execute git: ${error.message}`,
          stderr,
          null,
        ),
      );
    });

    child.on("close", (code) => {
      if (code === 0) {
        resolve({ stdout, stderr });
        return;
      }

      reject(
        new GitError(
          `git ${args.join(" ")} exited with code ${code ?? "null"}`,
          stderr,
          code,
        ),
      );
    });

    if (options.stdin !== undefined) {
      child.stdin.write(options.stdin);
    }
    child.stdin.end();
  });
}

export async function isGitAvailable(): Promise<boolean> {
  try {
    await runGit(["--version"]);
    return true;
  } catch {
    return false;
  }
}

export async function getGitVersion(): Promise<string | null> {
  try {
    const { stdout } = await runGit(["--version"]);
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitClone(url: string, targetDir: string): Promise<void> {
  await runGit(["clone", url, targetDir]);
}

export async function gitPullRebase(cwd: string): Promise<void> {
  await runGit(["pull", "--rebase"], { cwd });
}

export async function gitRebaseAbort(cwd: string): Promise<void> {
  try {
    await runGit(["rebase", "--abort"], { cwd });
  } catch {
    // Best-effort; the rebase may already be resolved or absent.
  }
}

export async function gitAddAll(cwd: string): Promise<void> {
  await runGit(["add", "-A"], { cwd });
}

export async function gitCommit(cwd: string, message: string): Promise<void> {
  await runGit(["commit", "-F", "-"], { cwd, stdin: message });
}

export async function gitPush(cwd: string): Promise<void> {
  await runGit(["push"], { cwd });
}

export async function gitRevParseHead(cwd: string): Promise<string> {
  const { stdout } = await runGit(["rev-parse", "HEAD"], { cwd });
  return stdout.trim();
}

export async function gitStatusPorcelain(cwd: string): Promise<string> {
  const { stdout } = await runGit(["status", "--porcelain"], { cwd });
  return stdout;
}

export async function gitHasChanges(cwd: string): Promise<boolean> {
  const status = await gitStatusPorcelain(cwd);
  return status.trim().length > 0;
}

export async function gitConfiguredUserEmail(cwd: string): Promise<string | null> {
  try {
    const { stdout } = await runGit(["config", "user.email"], { cwd });
    const trimmed = stdout.trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}

export async function gitRemoteGetUrl(
  cwd: string,
  remote = "origin",
): Promise<string | null> {
  try {
    const { stdout } = await runGit(["remote", "get-url", remote], { cwd });
    return stdout.trim();
  } catch {
    return null;
  }
}

export async function gitInitBare(targetDir: string): Promise<void> {
  await runGit(["init", "--bare", targetDir]);
}
