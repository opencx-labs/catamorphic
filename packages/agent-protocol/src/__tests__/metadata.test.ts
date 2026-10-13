import { describe, expect, it } from "vitest";
import {
  SESSION_METADATA_LIMITS,
  SessionMetadataError,
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
});
