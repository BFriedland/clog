import { describe, expect, it } from "vitest";

import {
  parseSourceQualifiedId,
  validateSourceKey,
} from "../src/utils/source-keys.js";

describe("source key validation", () => {
  it("accepts path-safe lowercase source keys", () => {
    expect(validateSourceKey("a")).toEqual({ ok: true });
    expect(validateSourceKey("future.agent_2")).toEqual({ ok: true });
    expect(validateSourceKey("codex-cli")).toEqual({ ok: true });
  });

  it("rejects source keys with invalid syntax", () => {
    expect(validateSourceKey("Future-Agent")).toEqual({
      ok: false,
      reason: "invalid_syntax",
    });
    expect(validateSourceKey("future/agent")).toEqual({
      ok: false,
      reason: "invalid_syntax",
    });
    expect(validateSourceKey("future-agent-")).toEqual({
      ok: false,
      reason: "invalid_syntax",
    });
  });

  it("rejects Windows reserved path names", () => {
    expect(validateSourceKey("con")).toEqual({
      ok: false,
      reason: "reserved_path_name",
    });
    expect(validateSourceKey("con.agent")).toEqual({
      ok: false,
      reason: "reserved_path_name",
    });
    expect(validateSourceKey("COM1")).toEqual({
      ok: false,
      reason: "reserved_path_name",
    });
  });
});

describe("source-qualified ID parsing", () => {
  it("parses unqualified and source-qualified prefixes", () => {
    expect(parseSourceQualifiedId("a123")).toEqual({
      ok: true,
      value: { prefix: "a123", source: null },
    });
    expect(parseSourceQualifiedId("a123@future.agent")).toEqual({
      ok: true,
      value: { prefix: "a123", source: "future.agent" },
    });
  });

  it("rejects malformed source-qualified prefixes", () => {
    expect(parseSourceQualifiedId("@future.agent")).toEqual({
      ok: false,
      reason: "missing_prefix",
    });
    expect(parseSourceQualifiedId("a123@")).toEqual({
      ok: false,
      reason: "missing_source",
    });
    expect(parseSourceQualifiedId("a123@extra@future.agent")).toEqual({
      ok: false,
      reason: "invalid_prefix",
    });
  });

  it("leaves ID-prefix shape to the resolver", () => {
    expect(parseSourceQualifiedId("zzzz@future.agent")).toEqual({
      ok: true,
      value: { prefix: "zzzz", source: "future.agent" },
    });
  });
});
