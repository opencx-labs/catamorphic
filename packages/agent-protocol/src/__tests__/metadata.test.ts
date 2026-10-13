import { describe, expect, it } from "vitest";
import {
  assertSessionMetadata,
  SESSION_METADATA_LIMITS,
  SessionMetadataError,
  sessionPullRequests,
  withSessionMetadata,
} from "../metadata.js";
import type { JsonValue } from "../model.js";

describe("session metadata writes (ADR 0225)", () => {
  const pr = { url: "https://github.com/acme/web/pull/7", number: 7 };

  it("sets, replaces and removes keys, keeping the others", () => {
    const set = withSessionMetadata({ note: "kept" }, { pull_requests: [pr] });
    expect(set).toEqual({ note: "kept", pull_requests: [pr] });
    const replaced = withSessionMetadata(set, {
      pull_requests: [{ ...pr, state: "merged" }],
    });
    expect(replaced.pull_requests).toEqual([{ ...pr, state: "merged" }]);
    expect(withSessionMetadata(replaced, { pull_requests: null })).toEqual({
      note: "kept",
    });
  });

  it("returns the same object when nothing changes", () => {
    const current = { deploy: { url: "https://preview.example", ok: true } };
    expect(
      withSessionMetadata(current, {
        deploy: { ok: true, url: "https://preview.example" },
      }),
    ).toBe(current);
    expect(withSessionMetadata(current, { absent: null })).toBe(current);
    // Inherited names are not keys the session holds.
    expect(withSessionMetadata({}, { constructor: null })).toEqual({});
  });

  it("refuses malformed keys", () => {
    for (const key of [
      "",
      "Pull_Requests",
      "1st",
      "pull requests",
      "trailing_",
      "a__b",
      `k${"x".repeat(SESSION_METADATA_LIMITS.keyLength)}`,
    ])
      expect(() => withSessionMetadata({}, { [key]: 1 }), key).toThrow(
        SessionMetadataError,
      );
    for (const key of ["pull_requests", "deploy.preview", "ci-run", "v2"])
      expect(withSessionMetadata({}, { [key]: 1 })).toEqual({ [key]: 1 });
  });

  it("refuses what is not plain JSON", () => {
    const refused: unknown[] = [
      Number.NaN,
      Number.POSITIVE_INFINITY,
      () => 1,
      undefined,
      new Date(0),
      [1, Number.NaN],
    ];
    for (const value of refused)
      expect(() =>
        withSessionMetadata({}, { bad: value as JsonValue }),
      ).toThrow(SessionMetadataError);
    let deep: JsonValue = 1;
    for (let level = 0; level <= SESSION_METADATA_LIMITS.depth; level += 1)
      deep = [deep];
    expect(() => withSessionMetadata({}, { deep })).toThrow(/nests deeper/);
  });

  it("bounds a value, the key count and the whole object", () => {
    expect(() =>
      withSessionMetadata(
        {},
        { big: "x".repeat(SESSION_METADATA_LIMITS.valueBytes) },
      ),
    ).toThrow(/larger than/);
    const full = Object.fromEntries(
      Array.from({ length: SESSION_METADATA_LIMITS.keys }, (_, index) => [
        `key${index}`,
        index,
      ]),
    );
    expect(() => withSessionMetadata(full, { another: 1 })).toThrow(
      /at most 32 metadata keys/,
    );
    // Replacing or removing a key of a full session still works.
    expect(withSessionMetadata(full, { key0: "changed" }).key0).toBe("changed");
    const large = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `part${index}`,
        "x".repeat(SESSION_METADATA_LIMITS.valueBytes - 100),
      ]),
    );
    expect(() => withSessionMetadata({}, large)).toThrow(/at most 65536 bytes/);
    expect(() => withSessionMetadata({}, {})).toThrow(SessionMetadataError);
  });

  it("lets a write shrink an object past the limits, and refuses one that grows it", () => {
    // Written before a limit, or brought in by an older copy.
    const over = Object.fromEntries(
      Array.from({ length: SESSION_METADATA_LIMITS.keys + 2 }, (_, index) => [
        `key${index}`,
        index,
      ]),
    );
    expect(Object.keys(withSessionMetadata(over, { key0: null }))).toHaveLength(
      SESSION_METADATA_LIMITS.keys + 1,
    );
    expect(withSessionMetadata(over, { key1: 0 }).key1).toBe(0);
    expect(() => withSessionMetadata(over, { extra: 1 })).toThrow(
      /at most 32 metadata keys/,
    );
    const heavy = Object.fromEntries(
      Array.from({ length: 5 }, (_, index) => [
        `part${index}`,
        "x".repeat(SESSION_METADATA_LIMITS.valueBytes - 100),
      ]),
    );
    expect(withSessionMetadata(heavy, { part0: "short" }).part0).toBe("short");
    expect(() =>
      withSessionMetadata(
        { ...heavy, part0: "short" },
        { part0: "x".repeat(2_000) },
      ),
    ).toThrow(/at most 65536 bytes/);
  });
});

describe("assertSessionMetadata", () => {
  it("holds what a copy takes from another to a write's rules", () => {
    assertSessionMetadata({});
    assertSessionMetadata({ pull_requests: [{ url: "https://x/pull/1" }] });
    for (const metadata of [
      null,
      [],
      "text",
      { "Not A Key": 1 },
      { note: null },
      { count: Number.NaN },
      { big: "x".repeat(SESSION_METADATA_LIMITS.valueBytes) },
      Object.fromEntries(
        Array.from({ length: SESSION_METADATA_LIMITS.keys + 1 }, (_, index) => [
          `key${index}`,
          index,
        ]),
      ),
    ])
      expect(
        () => assertSessionMetadata(metadata),
        JSON.stringify(metadata),
      ).toThrow(SessionMetadataError);
  });
});

describe("sessionPullRequests", () => {
  it("keeps entries of the convention's shape and nothing else", () => {
    expect(
      sessionPullRequests({
        pull_requests: [
          { url: " https://github.com/a/b/pull/1 ", number: 1, state: "open" },
          { url: "https://github.com/a/b/pull/1", number: 1 },
          { url: "javascript:alert(1)" },
          { number: 2 },
          "https://github.com/a/b/pull/3",
          {
            url: "https://gitlab.com/a/b/-/merge_requests/4",
            number: 4.5,
            title: "  ",
            state: "approved",
          },
        ],
      }),
    ).toEqual([
      { url: "https://github.com/a/b/pull/1", number: 1, state: "open" },
      { url: "https://gitlab.com/a/b/-/merge_requests/4" },
    ]);
    expect(sessionPullRequests({ pull_requests: "nope" })).toEqual([]);
    expect(sessionPullRequests(undefined)).toEqual([]);
  });
});
