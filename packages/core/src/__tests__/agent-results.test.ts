import { describe, expect, it } from "vitest";
import { validateAgentDefinition } from "../services/agent-definitions-service.js";
import {
  checkResultValue,
  PATTERN_INPUT_MAX,
  PATTERN_PROGRAM_MAX,
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
    ["^(a)\\1$", /without backreferences/],
    ["(?<n>a)\\k<n>", /without backreferences/],
    ["(?=a)b", /unsupported Perl syntax/],
    ["(?!a)b", /unsupported Perl syntax/],
    ["(?<=a)b", /invalid named capture/],
    ["a{1001}", /invalid repeat count/],
    ["(?:[a-z]{1000}){1000}", /invalid repeat count/],
    ["[a-z]{999}".repeat(3), /instructions, over 2,000/],
    ["^a{0,999}a{0,999}a{0,999}a{0,999}$", /instructions, over 2,000/],
    ["\\a", /not an ECMAScript pattern/],
    ["[\\Sa]", /outside a character class/],
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
    // The largest program a pattern may be, on the longest text it is
    // tried on: one match in a few tens of milliseconds.
    const largest = timed(
      { type: "string", pattern: "^a{0,499}a{0,499}$" },
      "a".repeat(PATTERN_INPUT_MAX),
    );
    expect(largest.ms).toBeLessThan(500);
    expect(
      "errors" in largest.checked && largest.checked.errors[0]?.message,
    ).toMatch(/must match pattern/);
    // A large ordinary value against a modest bounded repeat is checked
    // whole: the budget is the time matching takes, not an estimate.
    const many = timed(
      {
        type: "array",
        items: { type: "string", pattern: "^[a-z]{0,500}$" },
      },
      Array.from({ length: 64 }, () => "a".repeat(500)),
    );
    expect(many.checked).toHaveProperty("value");
    expect(many.ms).toBeLessThan(1_000);
  });

  it("refuses at load what compiles too large, alone or together, and compiles a pattern once", () => {
    const started = performance.now();
    expect(unusablePattern("(?:[a-z]{1000}){1000}")).toMatch(/repeat count/);
    expect(performance.now() - started).toBeLessThan(100);
    const big = "[a-z]{999}[0-9]{799}";
    expect(unusablePattern(big)).toBeUndefined();
    // Patterns count toward one total across every result name.
    const schemaOf = (from: number) => ({
      type: "object",
      properties: Object.fromEntries(
        Array.from({ length: 15 }, (_, n) => [
          `f${n}`,
          { type: "string", pattern: `${big}${from + n}` },
        ]),
      ),
    });
    expect("definition" in definition({ one: schemaOf(0) })).toBe(true);
    const together = definition({ one: schemaOf(0), two: schemaOf(100) });
    expect("error" in together && together.error).toMatch(
      /instructions together, over 50,000/,
    );
    expect(PATTERN_PROGRAM_MAX).toBe(2_000);
    // A pattern compiles once, however often its definition loads.
    const again = performance.now();
    for (let load = 0; load < 50; load += 1) unusablePattern(big);
    expect(performance.now() - again).toBeLessThan(20);
  });

  it("reads ECMAScript patterns with ECMAScript's meaning", () => {
    const validators = new ResultValidators();
    const ok = (pattern: string, value: string) =>
      "value" in
      validators.check({ schema: { type: "string", pattern }, value });
    expect(ok("^\\u00e9$", "é")).toBe(true);
    expect(ok("^\\u{1F600}$", "😀")).toBe(true);
    expect(ok("^[^]$", "\n")).toBe(true);
    expect(ok("^\\cJ$", "\n")).toBe(true);
    expect(ok("^\\u00e9$", "e")).toBe(false);
    expect(ok("^.$", "😀")).toBe(true);
    // Where RE2 reads alike syntax otherwise, JavaScript's meaning holds:
    // \s is Unicode whitespace, and . stops at every line terminator.
    for (let code = 0; code < 0x3100; code += 1) {
      const char = String.fromCharCode(code);
      if (code >= 0xd800) break;
      expect(ok("\\S", char), code.toString(16)).toBe(/\S/u.test(char));
      expect(ok("^[\\s]$", char), code.toString(16)).toBe(/^[\s]$/u.test(char));
      expect(ok("^.$", char), code.toString(16)).toBe(/^.$/u.test(char));
    }
    // An escaped backslash before a digit is no backreference.
    expect(ok("^\\\\1$", "\\1")).toBe(true);
  });

  it("refuses text too long to match, wherever a pattern applies", () => {
    // Counted in code points, as maxLength counts: 4,096 astral
    // characters (8,192 UTF-16 units) are tried.
    expect(
      checkResultValue({
        schema: { type: "string", pattern: "^😀+$" },
        value: "😀".repeat(PATTERN_INPUT_MAX),
      }),
    ).toHaveProperty("value");
    const long = "x".repeat(PATTERN_INPUT_MAX + 1);
    for (const [schema, value] of [
      [{ type: "string", pattern: "x" }, long],
      [{ not: { type: "string", pattern: "^safe$" } }, long],
      [
        {
          type: "object",
          patternProperties: { "^a": { type: "number" } },
        },
        { [`a${long}`]: "not a number" },
      ],
    ] as const)
      expect(checkResultValue({ schema, value })).toEqual({
        errors: [
          {
            path: "",
            message:
              "has text over 4,096 characters where a pattern applies; send shorter text",
          },
        ],
      });
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
