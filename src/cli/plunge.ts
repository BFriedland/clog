import fs from "node:fs/promises";
import path from "node:path";

import { Command } from "commander";
import type { Database } from "sql.js";

import { getAdapter } from "../adapters/registry.js";
import { parseConfig } from "../config/schema.js";
import { getDefaultConfig } from "../config/index.js";
import { CURRENT_SCHEMA_VERSION } from "../db/schema.js";
import { isGitConversation, isLocalConversation, withDb } from "../db/index.js";
import type { OriginKind } from "../models/conversation.js";
import {
  BUILTIN_SOURCES,
  getClogHome,
  getClogIgnorePath,
  getConfigPath,
  getRawConversationPath,
  normalizeUserPath,
} from "../utils/paths.js";
import { pathExists } from "../utils/fs.js";
import { nowIso } from "../utils/time.js";
import { formatForSingleLine } from "./common.js";
import { isRecognizedClogIgnoreRule } from "./clogignore.js";

type PlungeSubsystem =
  | "database"
  | "raw"
  | "checkpoints"
  | "clogignore"
  | "config";

type PlungeSeverity = "fatal" | "corruption" | "info";

interface PlungeFindingInternal {
  check: number;
  subsystem: PlungeSubsystem;
  severity: PlungeSeverity;
  message: string;
  recovery?: string;
  conversation?: { id: string; source: string };
  conversationTitle?: string;
  conversationAuthor?: string | null;
  conversationProject?: string | null;
  conversationOrigin?: string | null;
  paths?: string[];
  sortKey: string;
}

export interface PlungeV1Finding {
  check: number;
  subsystem: PlungeSubsystem;
  severity: PlungeSeverity;
  message: string;
  recovery?: string;
  conversation?: { id: string; source: string };
  paths?: string[];
}

export interface PlungeV1Report {
  clogHome: string;
  ranAt: string;
  exitCode: 0 | 1 | 2;
  summary: {
    fatal: number;
    corruption: number;
    info: number;
  };
  findings: PlungeV1Finding[];
}

interface PlungeV1ReportInternal {
  clogHome: string;
  ranAt: string;
  exitCode: 0 | 1 | 2;
  summary: {
    fatal: number;
    corruption: number;
    info: number;
  };
  findings: PlungeFindingInternal[];
}

interface RawConversationRow {
  id: string;
  source_id: string;
  source: string;
  title: string;
  author: string | null;
  project_name: string | null;
  state: string;
  tags_json: unknown;
  modified_at: unknown;
  saved_at: unknown;
  saved_message_count: unknown;
  save_version: unknown;
  file_path: unknown;
  source_path: unknown;
  originKind: OriginKind;
  originRef: unknown;
}

interface ClogIgnoreLine {
  kind: "literal";
  value: string;
  lineNumber: number;
  raw: string;
}

const SUBSYSTEM_ORDER: PlungeSubsystem[] = [
  "database",
  "raw",
  "checkpoints",
  "clogignore",
  "config",
];

const BUILTIN_SOURCE_SET = new Set<string>(BUILTIN_SOURCES);
const VALID_STATES = new Set(["unsaved", "saved"]);

export function buildPlungeCommand(): Command {
  return new Command("plunge")
    .description("Audit local clog state for obvious corruption")
    .option("--json", "Emit a machine-readable report")
    .option("--verbose", "Show conversation metadata details in human-readable output")
    .action(async (options: { json?: boolean; verbose?: boolean }) => {
      const report = await runPlungeCommand({
        json: options.json === true,
        verbose: options.verbose === true,
      });
      process.exitCode = report.exitCode;
    });
}

export async function runPlungeCommand(
  options: { json: boolean; verbose: boolean },
): Promise<PlungeV1Report> {
  try {
    const internalReport = await generatePlungeReportInternal();
    const report = stripInternalReport(internalReport);
    renderPlungeReport(internalReport, options);
    return report;
  } catch (error) {
    if (!isPlungeRuntimeError(error)) {
      throw error;
    }

    const message =
      error instanceof Error ? error.message : "Unknown plunge error.";
    const internalReport = buildPlungeRuntimeFailureReport();
    renderPlungeReport(internalReport, options, { runtimeMessage: message });
    return stripInternalReport(internalReport);
  }
}

export async function generatePlungeReport(): Promise<PlungeV1Report> {
  return stripInternalReport(await generatePlungeReportInternal());
}

async function generatePlungeReportInternal(): Promise<PlungeV1ReportInternal> {
  const ranAt = nowIso();
  const clogHome = getClogHome();

  if (!(await pathExists(clogHome))) {
    return {
      clogHome,
      ranAt,
      exitCode: 2,
      summary: { fatal: 0, corruption: 0, info: 0 },
      findings: [],
    };
  }

  const dbExists = await pathExists(path.join(clogHome, "clog.db"));
  const findings: PlungeFindingInternal[] = [];

  let configForParsing = getDefaultConfig("");
  let configAvailable = false;

  const configFinding = await inspectConfig();
  findings.push(...configFinding.findings);
  if (configFinding.config) {
    configForParsing = configFinding.config;
    configAvailable = true;
  }

  try {
    const dbFindings = await withDb(
      async (db) => inspectDatabase(db, {
        dbExists,
        configForParsing,
      }),
      {
        applyMigrations: false,
        flush: false,
        requireExistingHome: true,
      },
    );
    findings.push(...dbFindings);
  } catch (error) {
    if (isPlungeRuntimeError(error)) {
      throw error;
    }

    findings.push({
      check: 1,
      subsystem: "database",
      severity: "fatal",
      message: `Database could not be opened for integrity inspection: ${error instanceof Error ? error.message : "unknown database error"}`,
      recovery: 'Run "clog init" and restore from backup if you have one.',
      paths: [path.join(clogHome, "clog.db")],
      sortKey: "database-open",
    });
  }

  findings.push(...(await inspectClogIgnoreFile()));

  if (configAvailable) {
    findings.push(...(await inspectConfigPaths(configForParsing)));
  }

  const sorted = findings
    .slice()
    .sort(
      (left, right) =>
        left.check - right.check ||
        left.sortKey.localeCompare(right.sortKey),
    );

  const summary = {
    fatal: sorted.filter((finding) => finding.severity === "fatal").length,
    corruption: sorted.filter((finding) => finding.severity === "corruption").length,
    info: sorted.filter((finding) => finding.severity === "info").length,
  };

  const exitCode =
    summary.fatal > 0 || summary.corruption > 0 ? 1 : 0;

  return {
    clogHome,
    ranAt,
    exitCode,
    summary,
    findings: sorted,
  };
}

async function inspectConfig(): Promise<{
  config: ReturnType<typeof getDefaultConfig> | null;
  findings: PlungeFindingInternal[];
}> {
  const configPath = getConfigPath();
  let raw = "";

  try {
    raw = await fs.readFile(configPath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return {
        config: null,
        findings: [
          {
            check: 15,
            subsystem: "config",
            severity: "fatal",
            message: "config.json is missing.",
            recovery: 'Run "clog init" and restore from backup if you have one.',
            paths: [configPath],
            sortKey: configPath,
          },
        ],
      };
    }

    return {
      config: null,
      findings: [
        {
          check: 15,
          subsystem: "config",
          severity: "fatal",
          message: `config.json could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
          recovery: 'Run "clog init" and restore from backup if you have one.',
          paths: [configPath],
          sortKey: configPath,
        },
      ],
    };
  }

  try {
    const parsed = parseConfig(JSON.parse(raw));
    const findings: PlungeFindingInternal[] = [];

    if (!parsed.author.trim()) {
      findings.push({
        check: 16,
        subsystem: "config",
        severity: "info",
        message: "config.author is empty.",
        recovery: 'Run "clog config set author <name>" if you want authorship-sensitive commands to behave predictably.',
        paths: [configPath],
        sortKey: configPath,
      });
    }

    return { config: parsed, findings };
  } catch (error) {
    const detail =
      error instanceof SyntaxError
        ? "config.json is invalid JSON."
        : "config.json does not match the current config schema.";
    return {
      config: null,
      findings: [
        {
          check: 15,
          subsystem: "config",
          severity: "fatal",
          message: detail,
          recovery: 'Run "clog init" and restore from backup if you have one.',
          paths: [configPath],
          sortKey: configPath,
        },
      ],
    };
  }
}

async function inspectDatabase(
  db: Database,
  options: { dbExists: boolean; configForParsing: ReturnType<typeof getDefaultConfig> },
): Promise<PlungeFindingInternal[]> {
  const findings: PlungeFindingInternal[] = [];
  const integrityMessage = readPragmaSingleString(db, "PRAGMA integrity_check");

  if (integrityMessage !== "ok") {
    findings.push({
      check: 1,
      subsystem: "database",
      severity: "fatal",
      message: `PRAGMA integrity_check returned ${integrityMessage == null ? "no result" : JSON.stringify(integrityMessage)}.`,
      recovery: 'Run "clog init" and restore from backup if you have one.',
      paths: [path.join(getClogHome(), "clog.db")],
      sortKey: "integrity",
    });
  }

  const schemaTableExists = tableExists(db, "schema_version");
  if (options.dbExists && !schemaTableExists) {
    findings.push({
      check: 2,
      subsystem: "database",
      severity: "fatal",
      message: "schema_version is missing from the database.",
      recovery: 'Run "clog init" and restore from backup if you have one.',
      paths: [path.join(getClogHome(), "clog.db")],
      sortKey: "schema-version-missing",
    });
  } else if (schemaTableExists) {
    const version = readSchemaVersion(db);
    if (version !== CURRENT_SCHEMA_VERSION) {
      findings.push({
        check: 2,
        subsystem: "database",
        severity: "fatal",
        message: `schema_version is ${String(version)} but clog expects ${CURRENT_SCHEMA_VERSION}.`,
        recovery: 'Run "clog init" and restore from backup if you have one.',
        paths: [path.join(getClogHome(), "clog.db")],
        sortKey: "schema-version-mismatch",
      });
    }
  }

  if (findings.some((finding) => finding.severity === "fatal")) {
    return findings;
  }

  if (!tableExists(db, "conversations")) {
    return findings;
  }

  const rows = getConversationRows(db);
  const localRows = rows.filter(isLocalConversation);
  for (const row of localRows) {
    if (!BUILTIN_SOURCE_SET.has(row.source)) {
      findings.push(conversationFinding(row, {
        check: 3,
        subsystem: "database",
        severity: "corruption",
        message: `Local row uses unrecognized source "${row.source}".`,
        recovery: "Investigate this row manually.",
        sortKey: row.id,
      }));
    }
  }

  for (const row of rows) {
    if (BUILTIN_SOURCE_SET.has(row.source) && row.id !== row.source_id) {
      findings.push(conversationFinding(row, {
        check: 4,
        subsystem: "database",
        severity: "corruption",
        message: `Built-in source row has id ${JSON.stringify(row.id)} but source_id ${JSON.stringify(row.source_id)}.`,
        recovery: "Investigate this row manually.",
        sortKey: row.id,
      }));
    }

    if (!VALID_STATES.has(row.state)) {
      findings.push(conversationFinding(row, {
        check: 5,
        subsystem: "database",
        severity: "corruption",
        message: `Row has invalid state ${JSON.stringify(row.state)}.`,
        recovery: "Investigate this row manually.",
        sortKey: row.id,
      }));
    }

    const tagsCheck = validateTagsJson(row.tags_json);
    if (!tagsCheck.ok) {
      findings.push(conversationFinding(row, {
        check: 6,
        subsystem: "database",
        severity: "corruption",
        message: tagsCheck.message,
        recovery: "Investigate this row manually.",
        sortKey: row.id,
      }));
    }

    const modifiedAt = parseComparableInstant(row.modified_at);
    const savedAt = parseComparableInstant(row.saved_at);
    const invalidTimestampParts: string[] = [];

    if (!modifiedAt.valid) {
      invalidTimestampParts.push("modified_at");
    }
    if (row.saved_at != null && !savedAt.valid) {
      invalidTimestampParts.push("saved_at");
    }

    if (invalidTimestampParts.length > 0) {
      findings.push(conversationFinding(row, {
        check: 12,
        subsystem: "checkpoints",
        severity: "corruption",
        message: `Row has invalid timestamp field${invalidTimestampParts.length === 1 ? "" : "s"}: ${invalidTimestampParts.join(", ")}.`,
        recovery: "Investigate this row manually. Do not rewrite history.",
        sortKey: row.id,
      }));
    } else if (
      modifiedAt.instant != null &&
      savedAt.instant != null &&
      savedAt.instant.getTime() > modifiedAt.instant.getTime()
    ) {
      findings.push(conversationFinding(row, {
        check: 12,
        subsystem: "checkpoints",
        severity: "corruption",
        message: "saved_at is later than modified_at when parsed as instants.",
        recovery: "Investigate this row manually. Do not rewrite history.",
        sortKey: row.id,
      }));
    }
  }

  for (const row of rows.filter((candidate) => candidate.state === "unsaved")) {
    const hasDirtyCurationFields =
      row.file_path != null ||
      row.saved_at != null ||
      row.saved_message_count != null ||
      Number(row.save_version ?? 0) !== 0;

    if (hasDirtyCurationFields) {
      findings.push(conversationFinding(row, {
        check: 10,
        subsystem: "checkpoints",
        severity: "corruption",
        message: "Unsaved row still has curation or save checkpoint fields set.",
        recovery: "Investigate this row manually.",
        sortKey: row.id,
      }));
    }
  }

  for (const row of localRows) {
    if (!BUILTIN_SOURCE_SET.has(row.source)) {
      continue;
    }

    if (row.state !== "saved") {
      continue;
    }

    const filePath = nullableString(row.file_path);
    const expectedPath = getRawConversationPath(row.source, row.id);
    const pathProblems: string[] = [];

    if (!filePath) {
      pathProblems.push("file_path is null");
    } else {
      if (normalizePath(filePath) !== normalizePath(expectedPath)) {
        pathProblems.push(`file_path points outside the expected raw location (${filePath})`);
      }
      if (!(await pathExists(filePath))) {
        pathProblems.push(`raw file is missing (${filePath})`);
      }
    }

    if (pathProblems.length > 0) {
      findings.push(conversationFinding(row, {
        check: 7,
        subsystem: "raw",
        severity: "corruption",
        message: pathProblems.join("; "),
        recovery: rawRecoveryForRow(row),
        paths: [expectedPath, ...(filePath ? [filePath] : [])],
        sortKey: row.id,
      }));
      continue;
    }

    const verifiedFilePath = filePath as string;

    try {
      const adapter = getAdapter(row.source, options.configForParsing);
      await adapter.parseMessages(verifiedFilePath);
    } catch (error) {
      findings.push(conversationFinding(row, {
        check: 8,
        subsystem: "raw",
        severity: "corruption",
        message: `Curated raw file could not be parsed by the ${row.source} adapter: ${error instanceof Error ? error.message : "unknown parse error"}`,
        recovery:
          await pathExists(String(row.source_path))
            ? `Run "clog save ${row.id}" to recreate the curated raw file from source.`
            : "Inspect the raw file manually.",
        paths: [verifiedFilePath],
        sortKey: row.id,
      }));
      continue;
    }

    if (row.state === "saved") {
      const saveMetadataProblems: string[] = [];
      const savedMessageCount = toFiniteNumber(row.saved_message_count);
      const saveVersion = toFiniteNumber(row.save_version);

      if (row.saved_at == null) {
        saveMetadataProblems.push("saved_at is null");
      }
      if (row.saved_message_count == null) {
        saveMetadataProblems.push("saved_message_count is null");
      }
      if (saveVersion == null || saveVersion < 1) {
        saveMetadataProblems.push(`save_version is ${String(row.save_version)}`);
      }

      if (saveMetadataProblems.length > 0) {
        findings.push(conversationFinding(row, {
          check: 11,
          subsystem: "checkpoints",
          severity: "corruption",
          message: saveMetadataProblems.join("; "),
          recovery: `Run "clog save ${row.id}" after verifying the conversation with "clog show ${row.id}".`,
          sortKey: row.id,
        }));
      }

      if (savedMessageCount != null) {
        try {
          const adapter = getAdapter(row.source, options.configForParsing);
          const parsedMessages = await adapter.parseMessages(verifiedFilePath);
          if (parsedMessages.length < savedMessageCount) {
            findings.push(conversationFinding(row, {
              check: 9,
              subsystem: "checkpoints",
              severity: "info",
              message: `Current parsed message count is ${parsedMessages.length}, below saved_message_count ${savedMessageCount}.`,
              recovery: `Run "clog show ${row.id}" and then "clog save ${row.id}" after verification to refresh the stored message-count checkpoint.`,
              sortKey: row.id,
            }));
          }
        } catch {
          // Check #8 already covers parse failure.
        }
      }
    }
  }

  return findings;
}

async function inspectClogIgnoreFile(): Promise<PlungeFindingInternal[]> {
  const filePath = getClogIgnorePath();
  let raw = "";

  try {
    raw = await fs.readFile(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return [];
    }

    return [
      {
        check: 13,
        subsystem: "clogignore",
        severity: "corruption",
        message: `clogignore could not be read: ${error instanceof Error ? error.message : "unknown error"}`,
        recovery: `Manually edit ${filePath}.`,
        paths: [filePath],
        sortKey: filePath,
      },
    ];
  }

  const findings: PlungeFindingInternal[] = [];

  for (const rule of parseClogIgnoreLines(raw)) {
    if (!isRecognizedClogIgnoreRule(rule.value)) {
      findings.push({
        check: 14,
        subsystem: "clogignore",
        severity: "corruption",
        message: `Unsupported clogignore rule at line ${rule.lineNumber}: ${JSON.stringify(rule.value)}.`,
        recovery: `Manually edit ${filePath}.`,
        paths: [filePath],
        sortKey: `${String(rule.lineNumber).padStart(6, "0")}`,
      });
    }
  }

  return findings;
}

async function inspectConfigPaths(
  config: ReturnType<typeof getDefaultConfig>,
): Promise<PlungeFindingInternal[]> {
  const findings: PlungeFindingInternal[] = [];

  for (const source of BUILTIN_SOURCES) {
    const sourceConfig = config.sources[source];
    const candidatePaths = [
      ...sourceConfig.paths,
      ...sourceConfig.includePaths,
      ...sourceConfig.excludePaths,
    ];

    for (const candidatePath of candidatePaths) {
      const normalized = normalizePath(candidatePath);
      if (!(await pathExists(normalized))) {
        findings.push({
          check: 17,
          subsystem: "config",
          severity: "info",
          message: `Configured path does not exist for ${source}: ${normalized}`,
          paths: [getConfigPath(), normalized],
          sortKey: `${source}:${normalized}`,
        });
      }
    }
  }

  return findings;
}

function renderPlungeReport(
  report: PlungeV1ReportInternal,
  options: { json: boolean; verbose: boolean },
  runtime: { runtimeMessage?: string } = {},
): void {
  if (options.json) {
    process.stdout.write(`${JSON.stringify(stripInternalReport(report), null, 2)}\n`);
    return;
  }

  if (report.exitCode === 2) {
    process.stdout.write(
      `${runtime.runtimeMessage ?? "No existing clog state to inspect."}\n`,
    );
    return;
  }

  if (report.findings.length === 0) {
    process.stdout.write(
      "Found 0 fatal/corruption finding(s) and 0 info finding(s).\n",
    );
    return;
  }

  for (const subsystem of SUBSYSTEM_ORDER) {
    const subsystemFindings = report.findings.filter((finding) => finding.subsystem === subsystem);
    if (subsystemFindings.length === 0) {
      continue;
    }

    process.stdout.write(`${humanSubsystemLabel(subsystem)}:\n`);
    for (const finding of subsystemFindings) {
      if (finding.conversation && finding.conversationTitle) {
        process.stdout.write(
          `- [${finding.severity}] ${finding.conversation.id.slice(0, 8)}: ${finding.conversationTitle}:\n`,
        );
        if (options.verbose) {
          process.stdout.write(
            `    Conversation ID: ${finding.conversation.id}\n`,
          );
          process.stdout.write(`    Source: ${finding.conversation.source}\n`);
          process.stdout.write(
            `    Project: ${finding.conversationProject ?? "-"}\n`,
          );
          process.stdout.write(
            `    Author: ${finding.conversationAuthor ?? "-"}\n`,
          );
          process.stdout.write(
            `    Origin: ${finding.conversationOrigin ?? "local"}\n`,
          );
        }
        process.stdout.write(`    ${finding.message}\n`);
      } else {
        process.stdout.write(`- [${finding.severity}] ${finding.message}\n`);
      }

      if (finding.recovery) {
        process.stdout.write(`    Recovery: ${finding.recovery}\n`);
      }
    }
    process.stdout.write("\n");
  }

  process.stdout.write(
    `Found ${report.summary.fatal + report.summary.corruption} fatal/corruption finding(s) and ${report.summary.info} info finding(s).\n`,
  );
}

function buildPlungeRuntimeFailureReport(): PlungeV1ReportInternal {
  return {
    clogHome: getClogHome(),
    ranAt: nowIso(),
    exitCode: 2,
    summary: { fatal: 0, corruption: 0, info: 0 },
    findings: [],
  };
}

function stripInternalReport(report: PlungeV1ReportInternal): PlungeV1Report {
  return {
    clogHome: report.clogHome,
    ranAt: report.ranAt,
    exitCode: report.exitCode,
    summary: report.summary,
    findings: report.findings.map(stripSortKey),
  };
}

function humanSubsystemLabel(subsystem: PlungeSubsystem): string {
  switch (subsystem) {
    case "database":
      return "Database";
    case "raw":
      return "Raw files";
    case "checkpoints":
      return "Save checkpoints";
    case "clogignore":
      return "clogignore";
    case "config":
      return "Config";
  }
}

function stripSortKey(finding: PlungeFindingInternal): PlungeV1Finding {
  return {
    check: finding.check,
    subsystem: finding.subsystem,
    severity: finding.severity,
    message: finding.message,
    recovery: finding.recovery,
    conversation: finding.conversation,
    paths: finding.paths,
  };
}

function conversationFinding(
  row: RawConversationRow,
  finding: Omit<PlungeFindingInternal, "conversation"> & {
    conversation?: { id: string; source: string };
  },
): PlungeFindingInternal {
  return {
    ...finding,
    conversation: finding.conversation ?? {
      id: row.id,
      source: row.source,
    },
    conversationTitle: formatForSingleLine(row.title),
    conversationAuthor: row.author,
    conversationProject: row.project_name,
    conversationOrigin: formatConversationOrigin(row),
  };
}

function tableExists(db: Database, tableName: string): boolean {
  const result = db.exec(
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name = ?",
    [tableName],
  );
  return result.length > 0 && (result[0]?.values.length ?? 0) > 0;
}

function readSchemaVersion(db: Database): number | null {
  const result = db.exec("SELECT version FROM schema_version LIMIT 1");
  if (result.length === 0 || (result[0]?.values.length ?? 0) === 0) {
    return null;
  }

  const value = result[0]?.values[0]?.[0];
  return value == null ? null : Number(value);
}

function readPragmaSingleString(db: Database, sql: string): string | null {
  const result = db.exec(sql);
  if (result.length === 0 || (result[0]?.values.length ?? 0) === 0) {
    return null;
  }

  const value = result[0]?.values[0]?.[0];
  return value == null ? null : String(value);
}

function getConversationRows(db: Database): RawConversationRow[] {
  const result = db.exec(
    `
      SELECT
        id,
        source_id,
        source,
        title,
        author,
        project_name,
        state,
        tags_json,
        modified_at,
        saved_at,
        saved_message_count,
        save_version,
        file_path,
        source_path,
        origin_kind AS originKind,
        origin_ref AS originRef
      FROM conversations
      ORDER BY id ASC
    `,
  );

  if (result.length === 0) {
    return [];
  }

  const [rows] = result;
  if (!rows) {
    return [];
  }

  return rows.values.map((values) => {
    const record = Object.fromEntries(
      rows.columns.map((column, index) => [column, values[index]]),
    );

    return {
      id: String(record.id),
      source_id: String(record.source_id),
      source: String(record.source),
      title: String(record.title ?? ""),
      author: nullableString(record.author),
      project_name: nullableString(record.project_name),
      state: String(record.state ?? ""),
      tags_json: record.tags_json,
      modified_at: record.modified_at,
      saved_at: record.saved_at,
      saved_message_count: record.saved_message_count,
      save_version: record.save_version,
      file_path: record.file_path,
      source_path: record.source_path,
      originKind: parseOriginKind(record.originKind),
      originRef: record.originRef,
    };
  });
}

function formatConversationOrigin(row: RawConversationRow): string | null {
  if (isLocalConversation(row)) {
    return null;
  }

  if (isGitConversation(row)) {
    return nullableString(row.originRef);
  }

  return row.originKind;
}

function parseOriginKind(value: unknown): OriginKind {
  if (value === "local" || value === "git" || value === "file") {
    return value;
  }

  return "local";
}

function validateTagsJson(value: unknown): { ok: true } | { ok: false; message: string } {
  if (typeof value !== "string") {
    return { ok: false, message: "tags_json is not a JSON string." };
  }

  try {
    const parsed = JSON.parse(value);
    if (!Array.isArray(parsed) || parsed.some((entry) => typeof entry !== "string")) {
      return { ok: false, message: "tags_json is not a JSON array of strings." };
    }

    return { ok: true };
  } catch {
    return { ok: false, message: "tags_json is not valid JSON." };
  }
}

function parseComparableInstant(value: unknown): {
  valid: boolean;
  instant: Date | null;
} {
  if (value == null) {
    return { valid: true, instant: null };
  }

  if (typeof value !== "string" || !value.trim()) {
    return { valid: false, instant: null };
  }

  const instant = new Date(value);
  if (Number.isNaN(instant.getTime())) {
    return { valid: false, instant: null };
  }

  return { valid: true, instant };
}

function parseClogIgnoreLines(raw: string): ClogIgnoreLine[] {
  const rules: ClogIgnoreLine[] = [];

  for (const [index, line] of raw.split(/\r?\n/).entries()) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }

    rules.push({
      kind: "literal",
      value: trimmed,
      lineNumber: index + 1,
      raw: line,
    });
  }

  return rules;
}

function rawRecoveryForRow(row: RawConversationRow): string {
  if (row.state === "saved") {
    return `Run "clog save ${row.id}" after verifying the conversation with "clog show ${row.id}".`;
  }

  return "Investigate this row manually.";
}

function nullableString(value: unknown): string | null {
  return value == null ? null : String(value);
}

function toFiniteNumber(value: unknown): number | null {
  if (value == null) {
    return null;
  }

  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function normalizePath(value: string): string {
  return normalizeUserPath(value);
}

function isPlungeRuntimeError(error: unknown): boolean {
  if (!(error instanceof Error)) {
    return false;
  }

  const code = (error as NodeJS.ErrnoException).code;
  return (
    code === "ELOCKED" ||
    error.message.includes("Cannot replace legacy DB lock file") ||
    error.message.includes("clog home is missing") ||
    error.message.includes("clog home is inaccessible")
  );
}
