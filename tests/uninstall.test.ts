import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import { fileURLToPath } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const spawnMock = vi.hoisted(() => vi.fn());
const confirmMock = vi.hoisted(() => vi.fn());

vi.mock("node:child_process", () => ({
  spawn: spawnMock,
}));

vi.mock("../src/cli/common.js", async () => {
  const actual = await vi.importActual<typeof import("../src/cli/common.js")>(
    "../src/cli/common.js",
  );
  return { ...actual, confirm: confirmMock };
});

import { buildUninstallCommand, runUninstallCommand } from "../src/cli/uninstall.js";
import { ClogError } from "../src/utils/errors.js";
import { getClogHome, getSearchRuntimeRoot } from "../src/utils/paths.js";

const PROJECT_ROOT = path.dirname(fileURLToPath(new URL("../package.json", import.meta.url)));

describe("clog uninstall", () => {
  let tempDir: string;
  let originalClogHome: string | undefined;
  let originalStdinIsTTY: boolean | undefined;
  let npmGlobalRoot: string;
  let stdout: ReturnType<typeof vi.spyOn>;

  beforeEach(async () => {
    originalClogHome = process.env.CLOG_HOME;
    originalStdinIsTTY = process.stdin.isTTY;
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-uninstall-"));
    process.env.CLOG_HOME = path.join(tempDir, "custom clog home");
    npmGlobalRoot = path.join(tempDir, "npm-global", "lib", "node_modules");
    await linkCurrentPackage(path.join(npmGlobalRoot, "@getclog", "clog"));
    spawnMock.mockReset();
    confirmMock.mockReset();
    confirmMock.mockResolvedValue(true);
    mockNpmRoot(npmGlobalRoot);
    mockNpmClose(0);
    stdout = vi.spyOn(process.stdout, "write").mockImplementation(() => true);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    if (originalClogHome === undefined) {
      delete process.env.CLOG_HOME;
    } else {
      process.env.CLOG_HOME = originalClogHome;
    }
    Object.defineProperty(process.stdin, "isTTY", {
      value: originalStdinIsTTY,
      configurable: true,
    });
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("offers a non-interactive confirmation option", () => {
    expect(buildUninstallCommand().helpInformation()).toContain("--yes");
  });

  it("removes only the search runtime and preserves other clog state", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    const retainedPaths = [
      path.join(getClogHome(), "clog.db"),
      path.join(getClogHome(), "config.json"),
      path.join(getClogHome(), "raw", "claude-code", "saved.jsonl"),
      path.join(getClogHome(), "imports", "codex-cli", "imported.jsonl"),
      path.join(getClogHome(), "vectors", "index.json"),
      path.join(getClogHome(), "remote", ".git", "HEAD"),
    ];
    await fs.mkdir(path.join(searchRuntimeRoot, "node_modules", "example"), {
      recursive: true,
    });
    await fs.writeFile(path.join(searchRuntimeRoot, "node_modules", "example", "index.js"), "");
    for (const retainedPath of retainedPaths) {
      await fs.mkdir(path.dirname(retainedPath), { recursive: true });
      await fs.writeFile(retainedPath, "retain me\n", "utf8");
    }
    await runUninstallCommand({ yes: true });

    await expect(fs.access(searchRuntimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
    for (const retainedPath of retainedPaths) {
      await expect(fs.readFile(retainedPath, "utf8")).resolves.toBe("retain me\n");
    }
    expect(spawnMock).toHaveBeenNthCalledWith(
      2,
      process.platform === "win32" ? "npm.cmd" : "npm",
      ["uninstall", "--global", "@getclog/clog"],
      {
        stdio: "inherit",
        shell: process.platform === "win32",
      },
    );
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain(searchRuntimeRoot);
    expect(output).toContain(`Retained clog data in ${getClogHome()}`);
    expect(output).toContain("MCP registrations in Claude Code and Codex CLI will remain");
    expect(output).toContain("claude mcp remove clog");
    expect(output).toContain("codex mcp remove clog");
  });

  it("succeeds when the search runtime is already absent", async () => {
    await runUninstallCommand({ yes: true });

    expect(spawnMock).toHaveBeenCalledTimes(2);
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain(`No optional search runtime remains at ${getSearchRuntimeRoot()}`);
    expect(output).toContain("Removed the global @getclog/clog npm package");
  });

  it("stops before deletion when npm points to a different clog installation", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    await fs.writeFile(path.join(searchRuntimeRoot, "sentinel"), "retain me\n", "utf8");
    await fs.rm(path.join(npmGlobalRoot, "@getclog", "clog"), {
      recursive: true,
      force: true,
    });
    await writeGlobalPackage(
      path.join(npmGlobalRoot, "@getclog", "clog"),
      "@getclog/clog",
    );

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      message: expect.stringContaining(
        "No files were removed. Ensure 'clog' and 'npm' come from the same Node.js installation",
      ),
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(searchRuntimeRoot, "sentinel"), "utf8")).resolves.toBe(
      "retain me\n",
    );
  });

  it("stops before deletion when npm cannot report its global package root", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    await fs.writeFile(path.join(searchRuntimeRoot, "sentinel"), "retain me\n", "utf8");
    spawnMock.mockReset();
    mockNpmRoot(npmGlobalRoot, 9);

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      message: expect.stringContaining("npm did not report a usable global package directory"),
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(searchRuntimeRoot, "sentinel"), "utf8")).resolves.toBe(
      "retain me\n",
    );
  });

  it("stops before deletion when npm reports an empty global package root", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    await fs.writeFile(path.join(searchRuntimeRoot, "sentinel"), "retain me\n", "utf8");
    spawnMock.mockReset();
    mockNpmRoot("");

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      message: expect.stringContaining("npm did not report a usable global package directory"),
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.readFile(path.join(searchRuntimeRoot, "sentinel"), "utf8")).resolves.toBe(
      "retain me\n",
    );
  });

  it("requires --yes when stdin is non-interactive", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", { value: false, configurable: true });

    await expect(runUninstallCommand()).rejects.toMatchObject({
      name: "ClogError",
      message: "Refusing to uninstall without confirmation. Re-run with --yes to confirm.",
    });

    expect(confirmMock).not.toHaveBeenCalled();
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.access(searchRuntimeRoot)).resolves.toBeUndefined();
  });

  it("cancels without deleting files when confirmation is declined", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });
    confirmMock.mockResolvedValueOnce(false);

    await runUninstallCommand();

    expect(confirmMock).toHaveBeenCalledWith("Continue?");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.access(searchRuntimeRoot)).resolves.toBeUndefined();
    const output = stdout.mock.calls.map(([chunk]) => String(chunk)).join("");
    expect(output).toContain("Operation cancelled.");
  });

  it("proceeds after interactive confirmation", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    Object.defineProperty(process.stdin, "isTTY", { value: true, configurable: true });

    await runUninstallCommand();

    expect(confirmMock).toHaveBeenCalledWith("Continue?");
    expect(spawnMock).toHaveBeenCalledTimes(2);
    await expect(fs.access(searchRuntimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("does not invoke npm uninstall when search-runtime deletion fails", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    vi.spyOn(fs, "rm").mockRejectedValueOnce(new Error("permission denied"));

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      message: expect.stringContaining(
        `Could not remove the optional search runtime at ${searchRuntimeRoot}: permission denied`,
      ),
    });

    expect(spawnMock).toHaveBeenCalledTimes(1);
    await expect(fs.access(searchRuntimeRoot)).resolves.toBeUndefined();
  });

  it("preserves npm's failing exit status after runtime cleanup", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    spawnMock.mockReset();
    mockNpmRoot(npmGlobalRoot);
    mockNpmClose(17);

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      exitCode: 17,
      message: expect.stringContaining(
        "npm package removal failed with exit code 17, so clog cannot determine whether the package is still installed.",
      ),
    } satisfies Partial<ClogError>);

    await expect(fs.access(searchRuntimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("reports a failed npm launch after runtime cleanup", async () => {
    const searchRuntimeRoot = getSearchRuntimeRoot();
    await fs.mkdir(searchRuntimeRoot, { recursive: true });
    spawnMock.mockReset();
    mockNpmRoot(npmGlobalRoot);
    spawnMock.mockImplementationOnce(() => {
      const child = new EventEmitter();
      queueMicrotask(() => child.emit("error", new Error("npm not found")));
      return child;
    });

    await expect(runUninstallCommand({ yes: true })).rejects.toMatchObject({
      name: "ClogError",
      exitCode: 1,
      message: expect.stringContaining(
        "npm package removal could not start: npm not found. The npm package remains installed.",
      ),
    } satisfies Partial<ClogError>);

    await expect(fs.access(searchRuntimeRoot)).rejects.toMatchObject({ code: "ENOENT" });
  });
});

async function linkCurrentPackage(packageRoot: string): Promise<void> {
  await fs.mkdir(path.dirname(packageRoot), { recursive: true });
  await fs.symlink(
    PROJECT_ROOT,
    packageRoot,
    process.platform === "win32" ? "junction" : "dir",
  );
}

async function writeGlobalPackage(packageRoot: string, name: string): Promise<void> {
  await fs.mkdir(packageRoot, { recursive: true });
  await fs.writeFile(
    path.join(packageRoot, "package.json"),
    `${JSON.stringify({ name, version: "0.2.1" }, null, 2)}\n`,
    "utf8",
  );
}

function mockNpmRoot(globalRoot: string, exitCode = 0): void {
  spawnMock.mockImplementationOnce(() => {
    const stdout = new PassThrough();
    const child = Object.assign(new EventEmitter(), { stdout });
    queueMicrotask(() => {
      stdout.end(`${globalRoot}\n`);
      child.emit("close", exitCode);
    });
    return child;
  });
}

function mockNpmClose(exitCode: number | null): void {
  spawnMock.mockImplementationOnce(() => {
    const child = new EventEmitter();
    queueMicrotask(() => child.emit("close", exitCode));
    return child;
  });
}
