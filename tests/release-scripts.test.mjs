import { spawnSync } from "node:child_process";
import path from "node:path";

import {
  assertNoUnexpectedPackChanges,
  assertOnlyVersionMetadataChanged,
  assertReleaseVersionWorkingTree,
  assertVersionIncreases,
  assertVersionFields,
  getExpectedTarballFilename,
  parseExactVersion,
  validatePackManifest,
} from "../scripts/release-shared.mjs";

describe("release scripts", () => {
  describe("parseExactVersion", () => {
    it.each(["0.2.1", "1.0.0"])("accepts exact version %s", (version) => {
      expect(parseExactVersion(version)).toBe(version);
    });

    it.each([
      undefined,
      "v0.2.1",
      "0.2",
      "latest",
      "1.2.3 || 2.0.0",
      "1.0.0-beta.1",
      "1.0.0-01",
    ])(
      "rejects non-exact version %s",
      (version) => {
        expect(() => parseExactVersion(version)).toThrow(/must be an exact stable semantic version/u);
      },
    );
  });

  it.each([
    ["0.2.1", "0.2.2"],
    ["0.9.9", "0.10.0"],
    ["9007199254740992.0.0", "9007199254740993.0.0"],
  ])("accepts release version %s increasing to %s", (committed, release) => {
    expect(() => assertVersionIncreases(committed, release)).not.toThrow();
  });

  it.each([
    ["0.2.1", "0.2.1"],
    ["0.2.1", "0.1.9"],
  ])("rejects release version %s changing to %s", (committed, release) => {
    expect(() => assertVersionIncreases(committed, release)).toThrow(
      `Release version ${release} must be greater than committed package version ${committed}.`,
    );
  });

  it("requires every package-owned version field to match", () => {
    const state = packageState("0.2.1");
    state.packageLock.packages[""].version = "0.2.0";

    expect(() => assertVersionFields(state, "0.2.1")).toThrow(
      /package-lock\.json packages\[''\] version is "0\.2\.0"/u,
    );
  });

  it("allows only the three package-owned version changes", () => {
    const headState = packageState("0.2.0");
    const workingState = packageState("0.2.1");

    expect(() => assertOnlyVersionMetadataChanged(headState, workingState)).not.toThrow();

    workingState.packageJson.description = "unexpected rewrite";
    expect(() => assertOnlyVersionMetadataChanged(headState, workingState)).toThrow(
      /package\.json contains changes other than the release version/u,
    );
  });

  it("requires exactly two unstaged release-version files", () => {
    expect(() =>
      assertReleaseVersionWorkingTree(" M package.json\n M package-lock.json\n"),
    ).not.toThrow();
    expect(() =>
      assertReleaseVersionWorkingTree("M  package.json\n M package-lock.json\n"),
    ).toThrow(/must contain exactly unstaged version changes/u);
    expect(() =>
      assertReleaseVersionWorkingTree(
        " M package.json\n M package-lock.json\n?? release-notes.txt\n",
      ),
    ).toThrow(/release-notes\.txt/u);
  });

  it.each(["", "?? getclog-clog-0.2.1.tgz\n"])(
    "accepts a release artifact whether Git reports it or ignores it",
    (status) => {
      expect(() =>
        assertNoUnexpectedPackChanges(status, "getclog-clog-0.2.1.tgz"),
      ).not.toThrow();
    },
  );

  it("rejects other checkout changes after packing", () => {
    expect(() =>
      assertNoUnexpectedPackChanges(
        "?? getclog-clog-0.2.1.tgz\n M package.json\n?? unexpected.txt\n",
        "getclog-clog-0.2.1.tgz",
      ),
    ).toThrow(/ M package\.json\n\?\? unexpected\.txt/u);
  });

  it("accepts the intended package manifest and executable modes", () => {
    const manifest = validManifest();

    expect(
      validatePackManifest(manifest, {
        name: "@getclog/clog",
        version: "0.2.1",
      }),
    ).toBe(manifest[0]);
  });

  it("rejects unexpected source paths in the package artifact", () => {
    const manifest = validManifest();
    manifest[0].files.push({ path: "src/index.ts", mode: 0o644, size: 10 });
    manifest[0].entryCount += 1;

    expect(() =>
      validatePackManifest(manifest, {
        name: "@getclog/clog",
        version: "0.2.1",
      }),
    ).toThrow(/unexpected path src\/index\.ts/u);
  });

  it("rejects package entry points without executable modes", () => {
    const manifest = validManifest();
    manifest[0].files.find((file) => file.path === "dist/index.js").mode = 0o644;

    expect(() =>
      validatePackManifest(manifest, {
        name: "@getclog/clog",
        version: "0.2.1",
      }),
    ).toThrow(/dist\/index\.js does not have an executable mode/u);
  });

  it("derives the npm tarball filename from the scoped package name", () => {
    expect(getExpectedTarballFilename("@getclog/clog", "0.2.1")).toBe(
      "getclog-clog-0.2.1.tgz",
    );
  });

  it.each([
    ["release-check.mjs", "Usage: npm run release:check"],
    ["release-pack.mjs", "Usage: npm run release:pack"],
    ["release-smoke.mjs", "Usage: npm run release:smoke"],
  ])("prints command help for %s", (script, expectedUsage) => {
    const result = runReleaseScript(script, ["--help"]);

    expect(result.status).toBe(0);
    expect(result.stdout).toContain(expectedUsage);
  });

  it("requires explicit network consent before a registry smoke test", () => {
    const result = runReleaseScript("release-smoke.mjs", [
      "@getclog/clog@0.2.1",
      "0.2.1",
    ]);

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("--allow-network is required");
  });
});

function runReleaseScript(script, args) {
  return spawnSync(process.execPath, [path.join(process.cwd(), "scripts", script), ...args], {
    cwd: process.cwd(),
    encoding: "utf8",
  });
}

function packageState(version) {
  return {
    packageJson: {
      name: "@getclog/clog",
      version,
      description: "Conversation log exploration",
    },
    packageLock: {
      name: "@getclog/clog",
      version,
      lockfileVersion: 3,
      packages: {
        "": {
          name: "@getclog/clog",
          version,
        },
      },
    },
  };
}

function validManifest() {
  const files = [
    { path: "LICENSE", mode: 0o644, size: 10 },
    { path: "README.md", mode: 0o644, size: 10 },
    { path: "clog.png", mode: 0o644, size: 10 },
    { path: "package.json", mode: 0o644, size: 10 },
    { path: "dist/index.js", mode: 0o755, size: 10 },
    { path: "dist/mcp/server.js", mode: 0o755, size: 10 },
  ];
  return [
    {
      name: "@getclog/clog",
      version: "0.2.1",
      filename: "getclog-clog-0.2.1.tgz",
      files,
      entryCount: files.length,
      size: 60,
      shasum: "example",
    },
  ];
}
