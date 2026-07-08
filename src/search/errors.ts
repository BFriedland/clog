import { getSearchRuntimeRoot } from "../utils/paths.js";

export class SearchNotConfiguredError extends Error {
  constructor() {
    super('Search is not configured. Run "clog search --init".');
    this.name = "SearchNotConfiguredError";
  }
}

export class SearchDepsError extends Error {
  constructor(
    packages: string[],
    options: { reason?: "missing" | "unusable"; cause?: unknown } = {},
  ) {
    const problem = options.reason === "unusable"
      ? "could not be imported from"
      : "are missing from";
    const causeDetail = options.reason === "unusable" && options.cause instanceof Error
      ? `\nImport error: ${options.cause.message}`
      : "";
    super(
      `Search runtime packages ${problem} ${getSearchRuntimeRoot()}: ${packages.join(", ")}.\nRun "clog search --init" to install vector search support.${causeDetail}`,
      { cause: options.cause },
    );
    this.name = "SearchDepsError";
  }
}

export class SearchSetupIncompleteError extends Error {
  constructor() {
    super('Search setup is incomplete. Run "clog search --init" to finish installing packages and downloading the embedding model.');
    this.name = "SearchSetupIncompleteError";
  }
}
