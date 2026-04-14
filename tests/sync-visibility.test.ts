import { describe, expect, it } from "vitest";

import {
  checkVisibility,
  parseGitHubUrl,
} from "../src/sync/visibility.js";

describe("parseGitHubUrl", () => {
  it("parses github.com SSH scp-style URLs", () => {
    expect(parseGitHubUrl("git@github.com:myorg/clog-team.git")).toEqual({
      host: "github.com",
      owner: "myorg",
      repo: "clog-team",
      apiUrl: "https://api.github.com/repos/myorg/clog-team",
    });
  });

  it("parses github.com HTTPS URLs with and without .git suffix", () => {
    expect(parseGitHubUrl("https://github.com/myorg/clog-team.git")?.apiUrl).toBe(
      "https://api.github.com/repos/myorg/clog-team",
    );
    expect(parseGitHubUrl("https://github.com/myorg/clog-team")?.apiUrl).toBe(
      "https://api.github.com/repos/myorg/clog-team",
    );
  });

  it("parses GitHub Enterprise hosts using /api/v3", () => {
    expect(
      parseGitHubUrl("git@github.mycorp.com:myorg/clog-team.git")?.apiUrl,
    ).toBe("https://github.mycorp.com/api/v3/repos/myorg/clog-team");

    expect(
      parseGitHubUrl("https://github.mycorp.com/myorg/clog-team.git")?.apiUrl,
    ).toBe("https://github.mycorp.com/api/v3/repos/myorg/clog-team");
  });

  it("returns null for non-GitHub hosts", () => {
    expect(parseGitHubUrl("git@gitlab.com:myorg/repo.git")).toBeNull();
    expect(parseGitHubUrl("https://bitbucket.org/myorg/repo.git")).toBeNull();
    expect(parseGitHubUrl("file:///tmp/bare.git")).toBeNull();
  });

  it("returns null for garbage input", () => {
    expect(parseGitHubUrl("")).toBeNull();
    expect(parseGitHubUrl("not a url")).toBeNull();
  });
});

describe("checkVisibility", () => {
  it("returns public when the unauthenticated probe returns 200 + private:false", async () => {
    const fetchImpl = fakeFetch({
      status: 200,
      json: { private: false },
    });

    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result).toEqual({ kind: "public" });
  });

  it("returns unverified for 404 with a clear reason", async () => {
    const fetchImpl = fakeFetch({ status: 404 });
    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/404/);
    }
  });

  it("returns unverified for 403 (rate limit)", async () => {
    const fetchImpl = fakeFetch({ status: 403 });
    const result = await checkVisibility(
      "https://github.com/myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/rate limited/);
    }
  });

  it("returns unverified for other non-200 statuses", async () => {
    const fetchImpl = fakeFetch({ status: 500 });
    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/HTTP 500/);
    }
  });

  it("returns unverified on a network error", async () => {
    const fetchImpl: typeof fetch = async () => {
      throw new TypeError("fetch failed");
    };

    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/network error/);
    }
  });

  it("returns unverified on timeout", async () => {
    const fetchImpl: typeof fetch = async (_input, init) => {
      return new Promise((_resolve, reject) => {
        init?.signal?.addEventListener("abort", () => {
          const error = new Error("aborted");
          error.name = "AbortError";
          reject(error);
        });
      });
    };

    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl, timeoutMs: 10 },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/timed out/);
    }
  });

  it("returns unverified when the 200 body is malformed", async () => {
    const fetchImpl: typeof fetch = async () => {
      return new Response("not json", { status: 200 });
    };

    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/could not parse/);
    }
  });

  it("returns unverified when 200 JSON is missing the private field", async () => {
    const fetchImpl = fakeFetch({ status: 200, json: { name: "repo" } });
    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/visibility fields/);
    }
  });

  it("treats an unexpected 200 + private:true as unverified", async () => {
    const fetchImpl = fakeFetch({ status: 200, json: { private: true } });
    const result = await checkVisibility(
      "git@github.com:myorg/clog-team.git",
      { fetchImpl },
    );

    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/did not expect/);
    }
  });

  it("short-circuits non-GitHub URLs without calling fetch", async () => {
    let called = false;
    const fetchImpl: typeof fetch = async () => {
      called = true;
      return new Response("", { status: 200 });
    };

    const result = await checkVisibility(
      "git@gitlab.com:myorg/repo.git",
      { fetchImpl },
    );

    expect(called).toBe(false);
    expect(result.kind).toBe("unverified");
    if (result.kind === "unverified") {
      expect(result.reason).toMatch(/non-GitHub/);
    }
  });
});

function fakeFetch({
  status,
  json,
}: {
  status: number;
  json?: unknown;
}): typeof fetch {
  return async () => {
    const body =
      json === undefined ? null : new Blob([JSON.stringify(json)], { type: "application/json" });
    return new Response(body, { status });
  };
}
