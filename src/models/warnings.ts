export type ClogWarningCode =
  | "malformed_jsonl"
  | "missing_source_id"
  | "source_id_mismatch"
  | "path_filter_without_project"
  | "unsupported_source"
  | "missing_source_file"
  | "invalid_excluded_file"
  | "duplicate_excluded_entry"
  | "remote_incomplete_pair"
  | "remote_invalid_metadata"
  | "remote_invalid_content";

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
  remote?: {
    author: string;
    source: string;
    id: string;
  };
}
