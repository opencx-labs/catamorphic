import { describe, expect, it } from "vitest";
import { validateAgentDefinition } from "../services/agent-definitions-service.js";
import {
  checkResultValue,
  PATTERN_INPUT_MAX,
  ResultValidators,
  unusablePattern,
} from "../services/agent-results.js";

/* Result schemas (ADR 0323): compiled per schema, patterns checked when a
 * definition loads, and errors that say what to fix. */

const definition = (results: Record<string, unknown>) =>
  validateAgentDefinition({
    version: 1,
    name: "Reviewer",
    kind: "builtin",
    results,
  });

describe("result schemas", () => {
  it("compiles every schema on its own, so a reused $id neither collides nor resolves another's", () => {
    const first = {
      $id: "https://example.test/review",
      type: "object",
      required: ["verdict"],
    };
    const edited = {
      $id: "https://example.test/review",
      type: "object",
      required: ["score"],
    };
    // A definition edited in place, and two projects using the same $id.
    expect("definition" in definition({ review: first })).toBe(true);
    expect("definition" in definition({ review: edited })).toBe(true);
    expect("definition" in definition({ review: first })).toBe(true);
    const validators = new ResultValidators();
    expect(
      validators.check({ schema: first, value: { verdict: "x" } }),
    ).toEqual({ value: { verdict: "x" } });
    expect(
      "errors" in validators.check({ schema: edited, value: { verdict: "x" } }),
    ).toBe(true);
    expect(validators.check({ schema: edited, value: { score: 1 } })).toEqual({
      value: { score: 1 },
    });
  });

  it("keeps a bounded number of compiled schemas", () => {
    const validators = new ResultValidators(2);
    for (const maximum of [1, 2, 3, 1])
      expect(
        validators.check({
          schema: { type: "integer", maximum },
          value: 1,
        }),
      ).toEqual({ value: 1 });
    expect(
      Reflect.get(validators, "compiled") instanceof Map &&
        (Reflect.get(validators, "compiled") as Map<string, unknown>).size,
    ).toBe(2);
  });

  it.each([
    ["^(a)\\1$", /invalid escape sequence/],
    ["(?=a)b", /unsupported Perl syntax/],
    ["(?!a)b", /unsupported Perl syntax/],
    ["(?<=a)b", /invalid named capture/],
    ["a{1001}", /invalid repeat count/],
    ["a".repeat(1_001), /over 1,000/],
  ])(
    "refuses the pattern %s, which RE2 cannot run, when the definition loads",
    (pattern, why) => {
      expect(unusablePattern(pattern)).toMatch(why);
      const refused = definition({
        review: {
          type: "object",
          properties: { text: { type: "string", pattern } },
        },
      });
      expect("error" in refused && refused.error).toMatch(/is refused/);
      const keyed = definition({
        review: { type: "object", patternProperties: { [pattern]: {} } },
      });
      expect("error" in keyed && keyed.error).toMatch(/is refused/);
    },
  );

  it("accepts ordinary patterns, and the ones that backtrack elsewhere", () => {
    for (const pattern of [
      "^[0-9a-f]{40}$",
      "\\S",
      "^(COMMENT|REQUEST)$",
      "[|()]+",
      "^[*+]{2}\\*x+$",
      "\\p{L}+",
      "(a+)+$",
      "^(a|a)*b$",
      "^a*a*a*a*a*b$",
    ])
      expect(unusablePattern(pattern), pattern).toBeUndefined();
    expect(
      "definition" in
        definition({
          review: { type: "string", pattern: "^[0-9a-f]{40}$" },
        }),
    ).toBe(true);
  });

  it("holds every pattern of a schema to its own expression", () => {
    const schema = {
      type: "object",
      properties: {
        commit: { type: "string", pattern: "^[0-9a-f]{40}$" },
        summary: { type: "string", pattern: "\\S" },
        ids: {
          type: "array",
          items: {
            type: "string",
            pattern: "^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$",
          },
        },
      },
    } as const;
    const refused = checkResultValue({
      schema,
      value: { commit: "main", summary: "   ", ids: ["ok", "a b"] },
    });
    expect(
      "errors" in refused && refused.errors.map((error) => error.path),
    ).toEqual(["/commit", "/summary", "/ids/1"]);
    expect(
      checkResultValue({
        schema,
        value: { commit: "a".repeat(40), summary: "Fine.", ids: ["f.1"] },
      }),
    ).toHaveProperty("value");
    // Compiled by a core, alike.
    const validators = new ResultValidators();
    expect(
      validators.check({ schema, value: { commit: "main" } }),
    ).toHaveProperty("errors");
  });

  it("matches in linear time, however a pattern repeats, and bounds a check's pattern work", () => {
    const timed = (
      schema: Parameters<typeof checkResultValue>[0]["schema"],
      value: unknown,
    ) => {
      const started = performance.now();
      const checked = checkResultValue({ schema, value });
      return { checked, ms: performance.now() - started };
    };
    // Each would backtrack for ages in JavaScript's engine.
    for (const pattern of ["(a+)+$", "^(a|a)*b$", "^a*a*a*a*a*b$"]) {
      const { checked, ms } = timed(
        { type: "string", pattern },
        `${"a".repeat(PATTERN_INPUT_MAX - 1)}!`,
      );
      expect(ms, pattern).toBeLessThan(500);
      expect("errors" in checked && checked.errors[0]?.message).toMatch(
        /pattern/,
      );
    }
    // Bounded repeats: about 10^11 steps of backtracking on 4,001
    // characters; here a check refuses the work before it starts.
    const repeated = timed(
      { type: "string", pattern: "^a{0,999}a{0,999}a{0,999}a{0,999}$" },
      "a".repeat(4_001),
    );
    expect(repeated.ms).toBeLessThan(500);
    expect(repeated.checked).toEqual({
      errors: [
        {
          path: "",
          message:
            "takes too long to check against the schema's patterns; send shorter text",
        },
      ],
    });
    // Many strings, each cheap alone, share one budget.
    const many = timed(
      {
        type: "array",
        items: { type: "string", pattern: "^[a-z]{0,999}$" },
      },
      Array.from({ length: 64 }, () => "a".repeat(4_000)),
    );
    expect(many.ms).toBeLessThan(1_000);
    expect("errors" in many.checked && many.checked.errors[0]?.message).toMatch(
      /too long to check/,
    );
    // An ordinary value is checked whole.
    expect(
      timed(
        { type: "array", items: { type: "string", pattern: "^[a-z]{0,999}$" } },
        Array.from({ length: 64 }, () => "a".repeat(100)),
      ).checked,
    ).toHaveProperty("value");
  });

  it("tries a pattern on no string longer than the cap, so one quantifier stays fast", () => {
    // Unanchored, one quantifier: slow only on a long run of spaces.
    const schema = { type: "string", pattern: "\\s*x" } as const;
    const started = performance.now();
    const long = checkResultValue({
      schema,
      value: `${" ".repeat(256 * 1024 - 2)}`,
    });
    expect(performance.now() - started).toBeLessThan(1_000);
    expect("errors" in long && long.errors[0]?.message).toMatch(/pattern/);
    expect(
      checkResultValue({
        schema,
        value: `${" ".repeat(PATTERN_INPUT_MAX - 1)}x`,
      }),
    ).toHaveProperty("value");
  });

  it("reports the decoded value's fields when a value arrives as JSON text", () => {
    const schema = {
      type: "object",
      required: ["score"],
      properties: { score: { type: "integer" } },
    };
    const checked = checkResultValue({
      schema,
      value: JSON.stringify({ score: "high" }),
    });
    expect("errors" in checked && checked.errors).toEqual([
      { path: "", message: expect.stringMatching(/arrived as JSON text/) },
      { path: "/score", message: "must be integer" },
    ]);
    // Text that is not JSON of another kind is reported as it is.
    expect(
      "errors" in checked && checkResultValue({ schema, value: "not json" }),
    ).toEqual({ errors: [{ path: "", message: "must be object" }] });
  });
});
