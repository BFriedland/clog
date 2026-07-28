import fs from "node:fs/promises";
import path from "node:path";

import {
  unzipSync,
  zipSync,
  type UnzipFileInfo,
  type Zippable,
} from "fflate";

import { ClogError } from "../utils/errors.js";
import { usesWindowsReservedPathBasename } from "../utils/source-keys.js";
import { compareCodePoints } from "./conversation-files.js";

export const MAX_ARCHIVE_BYTES = 1024 * 1024 * 1024;
export const MAX_ARCHIVE_ENTRIES = 60_000;
export const MAX_SELECTED_ARCHIVE_BYTES = 2 * 1024 * 1024 * 1024;

const ZIP_LOCAL_FILE_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x03, 0x04);
const ZIP_EMPTY_SIGNATURE = Uint8Array.of(0x50, 0x4b, 0x05, 0x06);
const PAIR_SUFFIXES = [".jsonl", ".meta.json"] as const;
const FORBIDDEN_COMPONENT_CHARACTERS = /[\u0000-\u001f/\\<>:"|?*]/u;

export type ZipSignatureKind = "non-empty" | "empty";

export class ArchiveError extends ClogError {}

export class ArchiveResourceError extends ArchiveError {}

export function classifyZipSignature(bytes: Uint8Array): ZipSignatureKind | null {
  if (startsWith(bytes, ZIP_LOCAL_FILE_SIGNATURE)) {
    return "non-empty";
  }
  if (startsWith(bytes, ZIP_EMPTY_SIGNATURE)) {
    return "empty";
  }
  return null;
}

function isPairArchiveEntryName(name: string): boolean {
  return PAIR_SUFFIXES.some((suffix) => name.endsWith(suffix));
}

export function validateArchiveEntryName(name: string): void {
  if (name.length === 0) {
    throw new ArchiveError("Archive entry name cannot be empty.");
  }

  if (path.posix.isAbsolute(name) || path.win32.isAbsolute(name)) {
    throw new ArchiveError(`Archive entry is absolute: ${JSON.stringify(name)}.`);
  }

  const components = name.split("/");
  for (const component of components) {
    validateArchivePathComponent(component, name);
  }
}

export function validateArchivePathComponent(
  component: string,
  completeName = component,
): void {
  if (component.length === 0) {
    throw new ArchiveError(
      `Archive entry contains an empty path component: ${JSON.stringify(completeName)}.`,
    );
  }
  if (component === "." || component === "..") {
    throw new ArchiveError(
      `Archive entry contains a traversal component: ${JSON.stringify(completeName)}.`,
    );
  }
  if (FORBIDDEN_COMPONENT_CHARACTERS.test(component)) {
    throw new ArchiveError(
      `Archive entry contains a forbidden path character: ${JSON.stringify(completeName)}.`,
    );
  }
  if (component.endsWith(" ") || component.endsWith(".")) {
    throw new ArchiveError(
      `Archive entry contains a path component ending in a space or period: ${JSON.stringify(completeName)}.`,
    );
  }
  if (usesWindowsReservedPathBasename(component)) {
    throw new ArchiveError(
      `Archive entry contains a reserved Windows path name: ${JSON.stringify(completeName)}.`,
    );
  }
}

export function assertArchiveByteLimit(observed: number): void {
  assertBudget("zip file bytes", observed, MAX_ARCHIVE_BYTES);
}

export function assertArchiveEntryLimit(observed: number): void {
  assertBudget("archive entries", observed, MAX_ARCHIVE_ENTRIES);
}

export function assertSelectedArchiveByteLimit(observed: number): void {
  assertBudget("selected conversation bytes", observed, MAX_SELECTED_ARCHIVE_BYTES);
}

export async function createDeterministicArchive(
  pairRoot: string,
): Promise<Uint8Array> {
  const entries = await collectPairFiles(pairRoot, pairRoot);
  entries.sort((left, right) => compareCodePoints(left.name, right.name));

  assertArchiveEntryLimit(entries.length);
  for (const entry of entries) {
    validateArchiveEntryName(entry.name);
  }

  let selectedBytes = 0;
  for (const entry of entries) {
    let stat;
    try {
      stat = await fs.lstat(entry.physicalPath);
    } catch (error) {
      throw new ArchiveError(
        `Could not inspect staged entry ${JSON.stringify(entry.name)}${formatErrorCode(error)}.`,
      );
    }
    if (!stat.isFile()) {
      throw new ArchiveError(
        `Staged entry is not an ordinary file: ${JSON.stringify(entry.name)}.`,
      );
    }
    selectedBytes += stat.size;
    assertSelectedArchiveByteLimit(selectedBytes);
  }

  const zippable = Object.create(null) as Zippable;
  const fixedModificationTime = new Date(2000, 0, 1, 12, 0, 0);

  for (const entry of entries) {
    let data;
    try {
      data = await fs.readFile(entry.physicalPath);
    } catch (error) {
      throw new ArchiveError(
        `Could not read staged entry ${JSON.stringify(entry.name)}${formatErrorCode(error)}.`,
      );
    }
    zippable[entry.name] = [data, { mtime: fixedModificationTime, level: 6 }];
  }

  let archive: Uint8Array;
  try {
    archive = zipSync(zippable, { level: 6 });
  } catch {
    throw new ArchiveError("Could not create the archive from the staged conversation files.");
  }
  assertArchiveByteLimit(archive.byteLength);
  return archive;
}

export async function extractArchive(
  archiveData: Uint8Array,
  destinationRoot: string,
  archiveDisplayPath: string,
): Promise<void> {
  let archiveEntryCount = 0;
  let selectedArchiveBytes = 0;
  let selectedRecordCount = 0;
  const expectedLengths = new Map<string, number>();
  let decoded: Record<string, Uint8Array>;

  try {
    decoded = unzipSync(archiveData, {
      filter(file): boolean {
        archiveEntryCount += 1;
        assertArchiveEntryLimit(archiveEntryCount);

        if (!isPairArchiveEntryName(file.name)) {
          return false;
        }

        validateArchiveEntryName(file.name);
        const chargedBytes = selectedEntryBytes(file);
        selectedArchiveBytes += chargedBytes;
        assertSelectedArchiveByteLimit(selectedArchiveBytes);
        selectedRecordCount += 1;
        expectedLengths.set(file.name, chargedBytes);
        return true;
      },
    });
  } catch (error) {
    if (error instanceof ArchiveError) {
      throw error;
    }
    throw new ArchiveError(`Archive ${archiveDisplayPath} could not be decoded.`);
  }

  if (selectedRecordCount === 0) {
    throw new ArchiveError(
      `Archive ${archiveDisplayPath} contains no conversation files.`,
    );
  }

  const selectedNames = Object.keys(decoded).sort(compareCodePoints);
  for (const name of selectedNames) {
    const expectedLength = expectedLengths.get(name);
    if (expectedLength == null || decoded[name]!.byteLength !== expectedLength) {
      throw new ArchiveError(
        `Archive ${archiveDisplayPath} returned an inconsistent decoded length for entry ${JSON.stringify(name)}.`,
      );
    }
  }

  for (const name of selectedNames) {
    await writeExtractedEntry(
      destinationRoot,
      name,
      decoded[name]!,
      archiveDisplayPath,
    );
  }
}

function selectedEntryBytes(file: UnzipFileInfo): number {
  if (file.compression === 0) {
    if (file.size !== file.originalSize) {
      throw new ArchiveError(
        `Stored archive entry ${JSON.stringify(file.name)} declares inconsistent compressed and uncompressed sizes.`,
      );
    }
    return file.size;
  }

  if (file.compression === 8) {
    return file.originalSize;
  }

  throw new ArchiveError(
    `Archive entry ${JSON.stringify(file.name)} uses unsupported compression method ${file.compression}.`,
  );
}

async function writeExtractedEntry(
  destinationRoot: string,
  name: string,
  data: Uint8Array,
  archiveDisplayPath: string,
): Promise<void> {
  const destination = path.join(destinationRoot, ...name.split("/"));
  try {
    await fs.mkdir(path.dirname(destination), { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new ArchiveError(
      `Could not create parent directories for archive entry ${archiveDisplayPath}:${name}${formatErrorCode(error)}.`,
    );
  }

  try {
    await fs.writeFile(destination, data, { flag: "wx", mode: 0o600 });
  } catch (error) {
    throw new ArchiveError(
      `Could not create archive entry ${archiveDisplayPath}:${name}${formatErrorCode(error)}.`,
    );
  }
}

interface CollectedPairFile {
  name: string;
  physicalPath: string;
}

async function collectPairFiles(
  root: string,
  current: string,
): Promise<CollectedPairFile[]> {
  let dirEntries;
  try {
    dirEntries = await fs.readdir(current, { withFileTypes: true });
  } catch (error) {
    throw new ArchiveError(
      `Could not read the staging directory${formatErrorCode(error)}.`,
    );
  }

  dirEntries.sort((left, right) => compareCodePoints(left.name, right.name));
  const files: CollectedPairFile[] = [];

  for (const entry of dirEntries) {
    const physicalPath = path.join(current, entry.name);
    if (entry.isDirectory()) {
      files.push(...await collectPairFiles(root, physicalPath));
      continue;
    }
    if (!entry.isFile() || !isPairArchiveEntryName(entry.name)) {
      continue;
    }

    files.push({
      name: path.relative(root, physicalPath).split(path.sep).join("/"),
      physicalPath,
    });
  }

  return files;
}

function assertBudget(label: string, observed: number, limit: number): void {
  if (observed <= limit) {
    return;
  }
  throw new ArchiveResourceError(
    `Archive ${label} observed ${observed}; limit is ${limit}. Use directory input or output instead.`,
  );
}

function startsWith(bytes: Uint8Array, signature: Uint8Array): boolean {
  if (bytes.byteLength < signature.byteLength) {
    return false;
  }
  return signature.every((value, index) => bytes[index] === value);
}

function formatErrorCode(error: unknown): string {
  const code = (error as NodeJS.ErrnoException | null | undefined)?.code;
  return typeof code === "string" && code.length > 0 ? ` (${code})` : "";
}
