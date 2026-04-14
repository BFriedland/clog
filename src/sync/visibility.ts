const PROBE_TIMEOUT_MS = 5_000;

export type VisibilityResult =
  | { kind: "public" }
  | { kind: "unverified"; reason: string };

export interface ParsedGitHubUrl {
  host: string;
  owner: string;
  repo: string;
  apiUrl: string;
}

export function parseGitHubUrl(url: string): ParsedGitHubUrl | null {
  const trimmed = url.trim();
  if (trimmed.length === 0) {
    return null;
  }

  const match =
    matchSshUrl(trimmed) ?? matchScpUrl(trimmed) ?? matchHttpsUrl(trimmed);

  if (!match) {
    return null;
  }

  const { host, owner, repo } = match;
  if (!isGitHubHost(host)) {
    return null;
  }

  const apiUrl = buildApiUrl(host, owner, repo);

  return { host, owner, repo, apiUrl };
}

function matchSshUrl(
  url: string,
): { host: string; owner: string; repo: string } | null {
  const sshRegex = /^ssh:\/\/(?:[^@]+@)?([^/:]+)(?::\d+)?\/([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
  const match = sshRegex.exec(url);
  if (!match) {
    return null;
  }
  return { host: match[1], owner: match[2], repo: match[3] };
}

function matchScpUrl(
  url: string,
): { host: string; owner: string; repo: string } | null {
  const scpRegex = /^(?:[^@]+@)?([^:/]+):([^/]+)\/([^/]+?)(?:\.git)?\/?$/;
  if (url.startsWith("http://") || url.startsWith("https://") || url.startsWith("ssh://")) {
    return null;
  }
  const match = scpRegex.exec(url);
  if (!match) {
    return null;
  }
  return { host: match[1], owner: match[2], repo: match[3] };
}

function matchHttpsUrl(
  url: string,
): { host: string; owner: string; repo: string } | null {
  if (!url.startsWith("http://") && !url.startsWith("https://")) {
    return null;
  }

  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return null;
  }

  const segments = parsed.pathname.split("/").filter(Boolean);
  if (segments.length < 2) {
    return null;
  }

  const owner = segments[0];
  const rawRepo = segments[1];
  const repo = rawRepo.endsWith(".git") ? rawRepo.slice(0, -4) : rawRepo;

  return { host: parsed.hostname, owner, repo };
}

function isGitHubHost(host: string): boolean {
  const lower = host.toLowerCase();
  if (lower === "github.com") {
    return true;
  }
  return lower.startsWith("github.") || lower.includes(".github.");
}

function buildApiUrl(host: string, owner: string, repo: string): string {
  if (host.toLowerCase() === "github.com") {
    return `https://api.github.com/repos/${owner}/${repo}`;
  }
  return `https://${host}/api/v3/repos/${owner}/${repo}`;
}

export interface CheckVisibilityOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export async function checkVisibility(
  url: string,
  options: CheckVisibilityOptions = {},
): Promise<VisibilityResult> {
  const parsed = parseGitHubUrl(url);

  if (!parsed) {
    return {
      kind: "unverified",
      reason: "non-GitHub host — clog cannot probe visibility over REST",
    };
  }

  const fetchImpl = options.fetchImpl ?? globalThis.fetch;
  const timeoutMs = options.timeoutMs ?? PROBE_TIMEOUT_MS;

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetchImpl(parsed.apiUrl, {
      method: "GET",
      headers: { Accept: "application/vnd.github+json" },
      signal: controller.signal,
    });
  } catch (error) {
    const err = error as Error;
    if (err.name === "AbortError") {
      return {
        kind: "unverified",
        reason: `network error: request timed out after ${timeoutMs}ms`,
      };
    }
    return {
      kind: "unverified",
      reason: `network error: ${err.message}`,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 404) {
    return {
      kind: "unverified",
      reason: "repository not found or private (GitHub returns 404 for both)",
    };
  }

  if (response.status === 403) {
    return {
      kind: "unverified",
      reason: "GitHub API rate limited (HTTP 403)",
    };
  }

  if (response.status !== 200) {
    return {
      kind: "unverified",
      reason: `unexpected GitHub API response (HTTP ${response.status})`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      kind: "unverified",
      reason: "could not parse GitHub API response",
    };
  }

  if (!isGitHubRepoResponse(body)) {
    return {
      kind: "unverified",
      reason: "GitHub API response did not include expected visibility fields",
    };
  }

  if (body.private === false) {
    return { kind: "public" };
  }

  return {
    kind: "unverified",
    reason:
      "GitHub returned a privacy claim clog did not expect; please verify manually",
  };
}

interface GitHubRepoResponse {
  private: boolean;
}

function isGitHubRepoResponse(value: unknown): value is GitHubRepoResponse {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { private?: unknown }).private === "boolean"
  );
}
