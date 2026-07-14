import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { pathToFileURL } from "node:url";

import { unzipSync, zipSync } from "fflate";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  assertArchiveByteLimit,
  assertArchiveEntryLimit,
  assertSelectedPairByteLimit,
  classifyZipSignature,
  createDeterministicPairArchive,
  extractPairArchive,
  MAX_ARCHIVE_BYTES,
  MAX_ARCHIVE_ENTRIES,
  MAX_SELECTED_PAIR_BYTES,
  validateArchiveEntryName,
  validateArchivePathComponent,
} from "../src/interchange/archive.js";
import { withPrivateTempDirectory } from "../src/utils/private-temp.js";

describe("archive interchange helper", () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "clog-archive-test-"));
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it("classifies supported zip signatures without using a filename extension", () => {
    expect(classifyZipSignature(Uint8Array.of(0x50, 0x4b, 0x03, 0x04))).toBe("non-empty");
    expect(classifyZipSignature(Uint8Array.of(0x50, 0x4b, 0x05, 0x06))).toBe("empty");
    expect(classifyZipSignature(Uint8Array.of(0x7b, 0x22, 0x69, 0x64))).toBeNull();
  });

  it.each([
    ["empty component", "claude-code//id.jsonl"],
    ["C0 control", "claude-code/id\u0001.jsonl"],
    ["backslash", "claude-code\\id.jsonl"],
    ["Windows-forbidden character", "claude-code/id?.jsonl"],
    ["POSIX absolute path", "/claude-code/id.jsonl"],
    ["Windows absolute path", "C:/claude-code/id.jsonl"],
    ["dot component", "claude-code/./id.jsonl"],
    ["parent component", "claude-code/../id.jsonl"],
    ["trailing period", "claude-code./id.jsonl"],
    ["reserved device name", "CON/id.jsonl"],
  ])("rejects a selected entry with a %s", (_label, name) => {
    expect(() => validateArchiveEntryName(name)).toThrow(/Archive pair entry/);
  });

  it("requires a stored conversation ID to be exactly one path component", () => {
    expect(() => validateArchivePathComponent("nested/id")).toThrow(
      /forbidden path character/,
    );
  });

  it("creates a deterministic flat archive and round-trips pair bytes", async () => {
    const pairRoot = path.join(tempDir, "pairs");
    const sourceRoot = path.join(pairRoot, "claude-code");
    const id = "11111111-1111-1111-1111-111111111111";
    const jsonl = Buffer.from('{"type":"user","message":"hello"}\n');
    const metadata = Buffer.from('{"id":"11111111-1111-1111-1111-111111111111"}\n');
    await fs.mkdir(sourceRoot, { recursive: true });
    await fs.writeFile(path.join(sourceRoot, `${id}.jsonl`), jsonl);
    await fs.writeFile(path.join(sourceRoot, `${id}.meta.json`), metadata);

    const first = await createDeterministicPairArchive(pairRoot);
    const second = await createDeterministicPairArchive(pairRoot);
    expect(second).toEqual(first);

    const reportedNames: string[] = [];
    const decoded = unzipSync(first, {
      filter(entry) {
        reportedNames.push(entry.name);
        return true;
      },
    });
    expect(reportedNames).toEqual([
      `claude-code/${id}.jsonl`,
      `claude-code/${id}.meta.json`,
    ]);
    expect(reportedNames).not.toContain("claude-code/");
    expect(Buffer.from(decoded[`claude-code/${id}.jsonl`]!)).toEqual(jsonl);
    expect(Buffer.from(decoded[`claude-code/${id}.meta.json`]!)).toEqual(metadata);
  });

  it("creates identical bytes in processes with different host time zones", async () => {
    const pairRoot = path.join(tempDir, "timezone-pairs");
    await fs.mkdir(path.join(pairRoot, "claude-code"), { recursive: true });
    await fs.writeFile(path.join(pairRoot, "claude-code", "id.jsonl"), "timezone bytes\n");
    await fs.writeFile(path.join(pairRoot, "claude-code", "id.meta.json"), "metadata bytes\n");
    const archiveModule = pathToFileURL(
      path.join(process.cwd(), "src", "interchange", "archive.ts"),
    ).href;
    const script = `import(${JSON.stringify(archiveModule)}).then(async ({ createDeterministicPairArchive }) => { const data = await createDeterministicPairArchive(${JSON.stringify(pairRoot)}); process.stdout.write(Buffer.from(data).toString("base64")); });`;

    const outputs = ["UTC", "America/Los_Angeles", "Asia/Tokyo"].map((timezone) =>
      execFileSync(process.execPath, ["--import", "tsx", "-e", script], {
        encoding: "utf8",
        env: { ...process.env, TZ: timezone },
      }),
    );

    expect(outputs[1]).toBe(outputs[0]);
    expect(outputs[2]).toBe(outputs[0]);
  });

  it("extracts stored and deflated selected entries with private modes", async () => {
    const storedName = "claude-code/stored.jsonl";
    const deflatedName = "claude-code/deflated.meta.json";
    const archive = zipSync({
      [storedName]: [Buffer.from("stored\n"), { level: 0 }],
      [deflatedName]: [Buffer.from("deflated metadata\n"), { level: 6 }],
      "notes.txt": [Buffer.from("ignored\n"), { level: 0 }],
    });
    const output = path.join(tempDir, "extracted");
    await fs.mkdir(output, { mode: 0o700 });

    const methods = new Map<string, number>();
    unzipSync(archive, {
      filter(entry) {
        methods.set(entry.name, entry.compression);
        return false;
      },
    });
    expect(methods.get(storedName)).toBe(0);
    expect(methods.get(deflatedName)).toBe(8);

    await extractPairArchive(archive, output, "backup.bin");

    expect(await fs.readFile(path.join(output, ...storedName.split("/")), "utf8")).toBe("stored\n");
    expect(await fs.readFile(path.join(output, ...deflatedName.split("/")), "utf8")).toBe("deflated metadata\n");
    await expect(fs.access(path.join(output, "notes.txt"))).rejects.toThrow();
    if (process.platform !== "win32") {
      const fileMode = (await fs.stat(path.join(output, ...storedName.split("/")))).mode & 0o777;
      expect(fileMode).toBe(0o600);
    }
  });

  it("rejects a stored selected entry whose declared sizes differ", async () => {
    const name = "claude-code/stored.jsonl";
    const archive = zipSync({
      [name]: [Buffer.from("stored bytes\n"), { level: 0 }],
    });
    const modified = setCentralDirectorySizes(archive, name, {
      originalSize: Buffer.byteLength("stored bytes\n") + 1,
    });
    const output = path.join(tempDir, "stored-size-mismatch");

    await expect(
      extractPairArchive(modified, output, "stored-mismatch.zip"),
    ).rejects.toThrow(/Stored archive pair entry.*inconsistent compressed and uncompressed sizes/);
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("charges a deflated entry's declared decoded size before allocating its output", async () => {
    const name = "claude-code/deflated.meta.json";
    const archive = zipSync({
      [name]: [Buffer.from("compressible metadata ".repeat(20)), { level: 6 }],
    });
    const modified = setCentralDirectorySizes(archive, name, {
      originalSize: MAX_SELECTED_PAIR_BYTES + 1,
    });
    const output = path.join(tempDir, "deflated-over-budget");

    await expect(
      extractPairArchive(modified, output, "deflated-over-budget.zip"),
    ).rejects.toThrow(
      `Archive selected pair bytes observed ${MAX_SELECTED_PAIR_BYTES + 1}; limit is ${MAX_SELECTED_PAIR_BYTES}`,
    );
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("accumulates selected stored-entry sizes before extracting any files", async () => {
    const firstName = "claude-code/first.jsonl";
    const secondName = "claude-code/second.meta.json";
    const archive = zipSync({
      [firstName]: [Buffer.from("first\n"), { level: 0 }],
      [secondName]: [Buffer.from("second\n"), { level: 0 }],
    });
    const chargedSize = Math.floor(MAX_SELECTED_PAIR_BYTES / 2) + 1;
    const firstModified = setCentralDirectorySizes(archive, firstName, {
      compressedSize: chargedSize,
      originalSize: chargedSize,
    });
    const modified = setCentralDirectorySizes(firstModified, secondName, {
      compressedSize: chargedSize,
      originalSize: chargedSize,
    });
    const observedSize = chargedSize * 2;
    const output = path.join(tempDir, "cumulative-over-budget");

    await expect(
      extractPairArchive(modified, output, "cumulative-over-budget.zip"),
    ).rejects.toThrow(
      `Archive selected pair bytes observed ${observedSize}; limit is ${MAX_SELECTED_PAIR_BYTES}`,
    );
    await expect(fs.access(output)).rejects.toThrow();
  });

  it("enforces synthetic resource boundaries without maximum-size allocations", () => {
    expect(() => assertArchiveByteLimit(MAX_ARCHIVE_BYTES)).not.toThrow();
    expect(() => assertArchiveByteLimit(MAX_ARCHIVE_BYTES + 1)).toThrow(/observed.*limit/i);
    expect(() => assertArchiveEntryLimit(MAX_ARCHIVE_ENTRIES)).not.toThrow();
    expect(() => assertArchiveEntryLimit(MAX_ARCHIVE_ENTRIES + 1)).toThrow(/observed.*limit/i);
    expect(() => assertSelectedPairByteLimit(MAX_SELECTED_PAIR_BYTES)).not.toThrow();
    expect(() => assertSelectedPairByteLimit(MAX_SELECTED_PAIR_BYTES + 1)).toThrow(/observed.*limit/i);
  });

  it("turns malformed recognized zip data into one archive-level failure", async () => {
    await expect(
      extractPairArchive(
        Uint8Array.of(0x50, 0x4b, 0x03, 0x04, 0x00),
        path.join(tempDir, "bad"),
        "broken.zip",
      ),
    ).rejects.toThrow("Archive broken.zip could not be decoded");
  });

  it("removes private temporary directories after success and failure", async () => {
    let successfulPath = "";
    await withPrivateTempDirectory(async (directory) => {
      successfulPath = directory;
      await fs.writeFile(path.join(directory, "scratch"), "ok");
    });
    await expect(fs.access(successfulPath)).rejects.toThrow();

    let failedPath = "";
    await expect(
      withPrivateTempDirectory(async (directory) => {
        failedPath = directory;
        throw new Error("representative failure");
      }),
    ).rejects.toThrow("representative failure");
    await expect(fs.access(failedPath)).rejects.toThrow();
  });

  it("sanitizes private temporary-directory creation errors", async () => {
    const exposedTemplate = path.join(tempDir, "sensitive", "clog-private-");
    const nativeError = Object.assign(
      new Error(`EACCES: permission denied, mkdtemp '${exposedTemplate}'`),
      { code: "EACCES" },
    );
    vi.spyOn(fs, "mkdtemp").mockRejectedValueOnce(nativeError);
    const operation = vi.fn(async () => undefined);

    let failure: unknown;
    try {
      await withPrivateTempDirectory(operation);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "ClogError",
      message: "Could not create a private clog temporary directory (EACCES).",
    });
    expect((failure as Error).message).not.toContain(exposedTemplate);
    expect(operation).not.toHaveBeenCalled();
  });

  it("sanitizes permission errors and removes the private temporary directory", async () => {
    if (process.platform === "win32") {
      return;
    }

    const generatedPath = path.join(tempDir, "clog-private-visible-suffix");
    await fs.mkdir(generatedPath);
    vi.spyOn(fs, "mkdtemp").mockResolvedValueOnce(generatedPath);
    const nativeError = Object.assign(
      new Error(`EPERM: operation not permitted, chmod '${generatedPath}'`),
      { code: "EPERM" },
    );
    vi.spyOn(fs, "chmod").mockRejectedValueOnce(nativeError);
    const operation = vi.fn(async () => undefined);

    let failure: unknown;
    try {
      await withPrivateTempDirectory(operation);
    } catch (error) {
      failure = error;
    }

    expect(failure).toMatchObject({
      name: "ClogError",
      message: "Could not secure a private clog temporary directory (EPERM).",
    });
    expect((failure as Error).message).not.toContain(generatedPath);
    expect(operation).not.toHaveBeenCalled();
    await expect(fs.access(generatedPath)).rejects.toThrow();
  });
});

function setCentralDirectorySizes(
  archive: Uint8Array,
  name: string,
  sizes: { compressedSize?: number; originalSize?: number },
): Uint8Array {
  const modified = archive.slice();
  const headerOffset = findCentralDirectoryHeader(modified, name);
  const view = new DataView(
    modified.buffer,
    modified.byteOffset,
    modified.byteLength,
  );
  if (sizes.compressedSize != null) {
    view.setUint32(headerOffset + 20, sizes.compressedSize, true);
  }
  if (sizes.originalSize != null) {
    view.setUint32(headerOffset + 24, sizes.originalSize, true);
  }
  return modified;
}

function findCentralDirectoryHeader(archive: Uint8Array, name: string): number {
  const encodedName = Buffer.from(name);
  for (let nameOffset = archive.byteLength - encodedName.byteLength; nameOffset >= 46; nameOffset -= 1) {
    const headerOffset = nameOffset - 46;
    if (
      archive[headerOffset] === 0x50
      && archive[headerOffset + 1] === 0x4b
      && archive[headerOffset + 2] === 0x01
      && archive[headerOffset + 3] === 0x02
      && Buffer.from(
        archive.subarray(nameOffset, nameOffset + encodedName.byteLength),
      ).equals(encodedName)
    ) {
      return headerOffset;
    }
  }
  throw new Error(`Could not find central-directory record for ${JSON.stringify(name)}.`);
}
