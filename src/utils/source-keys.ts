const SOURCE_KEY_REGEX =
  /^(?:[a-z0-9]|[a-z0-9][a-z0-9._-]{0,78}[a-z0-9])$/;

// Shared checkout source directories must remain usable on Windows even when a
// source key was first written on macOS or Linux.
const WINDOWS_RESERVED_SOURCE_BASENAMES = new Set([
  "con",
  "prn",
  "aux",
  "nul",
  "com1",
  "com2",
  "com3",
  "com4",
  "com5",
  "com6",
  "com7",
  "com8",
  "com9",
  "lpt1",
  "lpt2",
  "lpt3",
  "lpt4",
  "lpt5",
  "lpt6",
  "lpt7",
  "lpt8",
  "lpt9",
]);

export type SourceKeyValidationError =
  | "invalid_syntax"
  | "reserved_path_name";

export type SourceKeyValidationResult =
  | { ok: true }
  | { ok: false; reason: SourceKeyValidationError };

interface ParsedSourceQualifiedId {
  prefix: string;
  source: string | null;
}

type SourceQualifiedIdParseError =
  | "missing_prefix"
  | "missing_source"
  | "invalid_prefix"
  | SourceKeyValidationError;

export type SourceQualifiedIdParseResult =
  | { ok: true; value: ParsedSourceQualifiedId }
  | { ok: false; reason: SourceQualifiedIdParseError };

export function validateSourceKey(value: string): SourceKeyValidationResult {
  if (usesWindowsReservedPathBasename(value)) {
    return { ok: false, reason: "reserved_path_name" };
  }

  if (!SOURCE_KEY_REGEX.test(value)) {
    return { ok: false, reason: "invalid_syntax" };
  }

  return { ok: true };
}

export function isValidSourceKey(value: string): boolean {
  return validateSourceKey(value).ok;
}

export function parseSourceQualifiedId(
  input: string,
): SourceQualifiedIdParseResult {
  const atIndex = input.lastIndexOf("@");

  if (atIndex === -1) {
    return { ok: true, value: { prefix: input, source: null } };
  }

  const prefix = input.slice(0, atIndex);
  const source = input.slice(atIndex + 1);

  if (!prefix) {
    return { ok: false, reason: "missing_prefix" };
  }

  if (!source) {
    return { ok: false, reason: "missing_source" };
  }

  if (prefix.includes("@")) {
    return { ok: false, reason: "invalid_prefix" };
  }

  const sourceValidation = validateSourceKey(source);
  if (!sourceValidation.ok) {
    return { ok: false, reason: sourceValidation.reason };
  }

  return { ok: true, value: { prefix, source } };
}

export function usesWindowsReservedPathBasename(value: string): boolean {
  const basename = value.split(".")[0]?.toLowerCase();
  return basename != null && WINDOWS_RESERVED_SOURCE_BASENAMES.has(basename);
}
