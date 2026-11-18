import { describe, expect, it } from "vitest";
import { validateAgentDefinition } from "../services/agent-definitions-service.js";
import {
  checkResultValue,
  PATTERN_INPUT_MAX,
  ResultValidators,
  unsafePattern,
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
    ["(a+)+$", /nests or over-repeats/],
    ["^(a|a)*b$", /alternatives/],
    ["^(\\w|\\d)+$", /alternatives/],
    ["^(a)\\1$", /backreference/],
    ["a".repeat(1_001), /over 1,000/],
    ["^a*a*a*a*a*b$", /more than one unbounded quantifier/],
    ["^\\d+-\\d{2,}$", /more than one unbounded quantifier/],
  ])(
    "refuses the unsafe pattern %s when the definition loads",
    (pattern, why) => {
      expect(unsafePattern(pattern)).toMatch(why);
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

  it("accepts ordinary patterns", () => {
    for (const pattern of [
      "^[0-9a-f]{40}$",
      "\\S",
      "^(COMMENT|REQUEST)$",
      "[|()]+",
      "^[*+]{2}\\*x+$",
    ])
      expect(unsafePattern(pattern), pattern).toBeUndefined();
    expect(
      "definition" in
        definition({
          review: { type: "string", pattern: "^[0-9a-f]{40}$" },
        }),
    ).toBe(true);
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
