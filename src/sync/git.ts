import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { access } from "node:fs/promises";
import path from "node:path";

const execFileAsync = promisify(execFile);

export async function ensureGit(): Promise<void> {
  try {
    await execFileAsync("git", ["--version"]);
  } catch {
    throw new Error(
      "git is not installed or not in PATH. Install git to use sync features."
    );
  }
}

export async function git(args: string[], cwd: string): Promise<string> {
  const { stdout } = await execFileAsync("git", args, { cwd });
  return stdout.trim();
}

export async function gitClone(url: string, targetDir: string): Promise<void> {
  await ensureGit();
  await execFileAsync("git", ["clone", url, targetDir]);
}

export async function gitPull(cwd: string): Promise<{ success: boolean; output: string }> {
  try {
    const output = await git(["pull", "--rebase"], cwd);
    return { success: true, output };
  } catch (err) {
    // Abort any in-progress rebase
    try {
      await git(["rebase", "--abort"], cwd);
    } catch {
      // rebase abort may fail if no rebase in progress
    }
    const message = err instanceof Error ? err.message : String(err);
    return { success: false, output: message };
  }
}

export async function gitAddCommitPush(
  cwd: string,
  message: string
): Promise<{ committed: boolean; pushed: boolean; error?: string }> {
  await git(["add", "-A"], cwd);

  // Check if there are changes to commit
  const status = await git(["status", "--porcelain"], cwd);
  if (!status) {
    return { committed: false, pushed: false };
  }

  await git(["commit", "-m", message], cwd);

  try {
    await git(["push"], cwd);
    return { committed: true, pushed: true };
  } catch (err) {
    const errMsg = err instanceof Error ? err.message : String(err);
    return {
      committed: true,
      pushed: false,
      error: errMsg,
    };
  }
}

export async function gitRevParseHead(cwd: string): Promise<string> {
  return git(["rev-parse", "HEAD"], cwd);
}

export async function gitRemoteUrl(cwd: string): Promise<string> {
  return git(["remote", "get-url", "origin"], cwd);
}

export async function isGitRepo(dir: string): Promise<boolean> {
  try {
    await access(path.join(dir, ".git"));
    return true;
  } catch {
    return false;
  }
}
