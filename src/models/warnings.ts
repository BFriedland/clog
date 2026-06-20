export type ClogWarningCode =
  | "malformed_jsonl"
  | "missing_source_id"
  | "source_id_mismatch"
  | "path_filter_without_project"
  | "unsupported_source"
  | "missing_source_file"
  | PairWarningCode;

export type PairWarningCode =
  | "pair_incomplete"
  | "pair_invalid_metadata"
  | "pair_id_mismatch"
  | "pair_invalid_content"
  | "pair_layout_mismatch"
  | "pair_duplicate_identity";

// Codes safe to collapse into a single summary line when they repeat across a
// scan. Requirements for adding a code here:
//   1. Re-running "clog status --verbose-warnings" must re-emit the same set,
//      so users following the drill-down hint actually see the individuals.
//   2. The message text for the code must be a static string literal, not a
//      template embedding per-occurrence data (path, id, error text, count).
//      The collapser groups on code + source + message + guidance, so dynamic
//      text in those fields makes every firing a unique group and silently
//      disables aggregation. Put per-occurrence data in warning.path /
//      warning.paths instead; the renderer surfaces those separately.
//   3. The warning's user-meaningful identity must be fully represented by
//      code + source + message + guidance. Warnings with conversation, remote,
//      or other detail fields should not be added without updating the grouping
//      key and collapsed summary shape.
const AGGREGATABLE_WARNING_CODES = new Set<ClogWarningCode>([
  "malformed_jsonl",
  "missing_source_id",
  "source_id_mismatch",
]);

export function isAggregatableWarningCode(code: ClogWarningCode): boolean {
  return AGGREGATABLE_WARNING_CODES.has(code);
}

export interface ClogWarning {
  code: ClogWarningCode;
  message: string;
  source?: string;
  path?: string;
  guidance?: string;
  paths?: string[];
  conversation?: {
    id: string;
    source: string;
  };
  pair?: {
    author?: string;
    source: string;
    id: string;
  };
  remote?: {
    author: string;
    source: string;
    id: string;
  };
}
