import { createHash } from "node:crypto";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  Ajv2020,
  type ErrorObject,
  type ValidateFunction,
} from "ajv/dist/2020.js";
import { RE2JS } from "re2js";
import { z } from "zod";

/*
 * Typed results (ADR 0323): a committed agent definition names the values
 * its agent submits with `submit_result`, each by a JSON Schema. The
 * schemas are checked when the definition loads; a value is checked when
 * the agent submits it, and only an accepted value is recorded.
 */

/** A result's name: lowercase, as `review` or `vote`. */
export const RESULT_NAME_PATTERN = /^[a-z][a-z0-9_-]{0,63}$/;

export const RESULT_LIMITS = {
  /** Names one definition may declare. */
  names: 16,
  /** All of a definition's schemas, as JSON. */
  schemaBytes: 64 * 1024,
  /** One submitted value, as JSON. */
  valueBytes: 256 * 1024,
  /**
   * Submissions one turn may make, accepted or refused (ADR 0336): per
   * turn, not per chat, since a review chat lives as long as its pull
   * request; and refused ones count, since checking each costs the server.
   * A turn's results therefore fit one read of `results`.
   */
  perTurn: 100,
  /** Field errors one rejected submission reports. */
  errors: 20,
} as const;

/** The schemas a definition declares, by result name. */
export type ResultSchemas = Readonly<Record<string, JsonSchemaObject>>;
type JsonSchemaObject = { [key: string]: JsonValue } | boolean;

/** One reason a value does not match its schema. */
export interface ResultFieldError {
  /** JSON Pointer of the field (`/comments/0/line`); empty for the value itself. */
  path: string;
  message: string;
}

/** The `results` field of an agent definition. */
export const ResultSchemasSchema = z
  .record(z.string(), z.union([z.boolean(), z.record(z.string(), z.json())]))
  .superRefine((results, ctx) => {
    const names = Object.keys(results);
    for (const name of names)
      if (!RESULT_NAME_PATTERN.test(name))
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `Result name "${name}" must be lowercase letters, digits, "-" and "_", starting with a letter`,
        });
    if (names.length > RESULT_LIMITS.names)
      ctx.addIssue({
        code: "custom",
        message: `An agent declares at most ${RESULT_LIMITS.names} results`,
      });
    if (jsonBytes(results) > RESULT_LIMITS.schemaBytes)
      ctx.addIssue({
        code: "custom",
        message: `Result schemas total at most ${RESULT_LIMITS.schemaBytes / 1024} KiB of JSON`,
      });
    // Every name's patterns count toward the definition's total.
    let programs = 0;
    for (const name of names) {
      if (!RESULT_NAME_PATTERN.test(name)) continue;
      const checked = schemaProblem(results[name] ?? true);
      if ("problem" in checked)
        ctx.addIssue({
          code: "custom",
          path: [name],
          message: `Not a usable JSON Schema (2020-12): ${checked.problem}`,
        });
      else programs += checked.programs;
    }
    if (programs > PATTERN_PROGRAMS_MAX)
      ctx.addIssue({
        code: "custom",
        message: `Result schemas' patterns compile to ${programs.toLocaleString("en-US")} instructions together, over ${PATTERN_PROGRAMS_MAX.toLocaleString("en-US")}`,
      });
  });

/**
 * An Ajv of its own for every schema: a schema's `$id` registers in the
 * instance that compiles it, so a shared one would refuse a definition
 * edited with the same `$id`, and let two projects' schemas collide or
 * resolve each other's `$ref`.
 */
function compileSchema(schema: JsonSchemaObject): ValidateFunction {
  return new Ajv2020({
    allErrors: true,
    // Each error carries its schema, so a refusing `not` can say what.
    verbose: true,
    allowUnionTypes: true,
    // Formats would need ajv-formats; an unknown one is accepted unchecked.
    validateFormats: false,
    strict: "log",
    logger: false,
    code: { regExp: linearRegExp },
  }).compile(schema);
}

/** The longest `pattern` a schema may hold. */
const PATTERN_MAX = 1_000;

/**
 * The longest string a schema's pattern is tried on. A longer one refuses
 * the value (it fails closed, under `not` and `patternProperties` too).
 */
export const PATTERN_INPUT_MAX = 4_096;

/**
 * The largest program one pattern may compile to, in RE2 instructions,
 * and all of a definition's patterns together: a match takes time linear in
 * its input times its program, and compiling takes time in its program.
 */
export const PATTERN_PROGRAM_MAX = 2_000;
export const PATTERN_PROGRAMS_MAX = 50_000;

/**
 * The time one check of a value may spend matching patterns, in
 * milliseconds, checked before each match; a check that needs more is
 * refused, and says so. One match is at most {@link PATTERN_INPUT_MAX}
 * code points through {@link PATTERN_PROGRAM_MAX} instructions (tens of
 * milliseconds), so a check ends within about 0.2 s (ADR 0323).
 */
export const PATTERN_TIME_MAX = 100;

/**
 * The check of a value in progress: when it began, and why it stopped, if
 * it did. Outside one (Ajv checking a schema against its meta-schema while
 * it compiles) patterns run unbudgeted, on the schema's own short strings.
 */
const patternWork = {
  active: false,
  since: 0,
  refused: null as ResultFieldError | null,
};

const TOO_LONG_TO_MATCH: ResultFieldError = {
  path: "",
  message: `has text over ${PATTERN_INPUT_MAX.toLocaleString("en-US")} characters where a pattern applies; send shorter text`,
};
const TOO_MUCH_PATTERN_WORK: ResultFieldError = {
  path: "",
  message:
    "takes too long to check against the schema's patterns; send shorter text",
};

/**
 * Compiled patterns by source, bounded by their instructions together.
 * Replica memory (b): a cache keyed by the pattern's own text, which every
 * replica compiles alike.
 */
const compiledPatterns = new Map<
  string,
  { expression: RE2JS; size: number } | { problem: string }
>();
let compiledInstructions = 0;
const COMPILED_INSTRUCTIONS_MAX = 200_000;

/** JavaScript's whitespace, as the inside of a character class. */
const JS_SPACE =
  "\\t\\n\\v\\f\\r \\u00a0\\u1680\\u2000-\\u200a\\u2028\\u2029\\u202f\\u205f\\u3000\\ufeff";

/**
 * A pattern rewritten so RE2 reads it as ECMAScript does, where they
 * differ: `\s` and `\S` as JavaScript's whitespace (RE2's is ASCII), `.`
 * as anything but a line terminator (RE2's stops at `\n` alone). What it
 * cannot carry over is refused: a backreference (an escaped backslash
 * before a digit is not one), and `\S` inside a class.
 */
function withEcmaMeaning(pattern: string): string | { problem: string } {
  let rewritten = "";
  let inClass = false;
  for (let index = 0; index < pattern.length; index += 1) {
    const char = pattern[index] ?? "";
    if (char === "\\") {
      const next = pattern[index + 1] ?? "";
      index += 1;
      if (/[1-9]/.test(next) || (next === "k" && pattern[index + 1] === "<"))
        return {
          problem:
            "Work matches patterns in linear time (RE2), without backreferences",
        };
      if (next === "s") rewritten += inClass ? JS_SPACE : `[${JS_SPACE}]`;
      else if (next === "S" && inClass)
        return {
          problem:
            "write \\S outside a character class: RE2 cannot carry it in",
        };
      else if (next === "S") rewritten += `[^${JS_SPACE}]`;
      else rewritten += char + next;
    } else if (inClass) {
      if (char === "]") inClass = false;
      rewritten += char;
    } else if (char === "[") {
      inClass = true;
      rewritten += char;
    } else rewritten += char === "." ? "[^\\n\\r\\u2028\\u2029]" : char;
  }
  return rewritten;
}

/**
 * A pattern compiled with ECMAScript's meaning on RE2: refused unless
 * JavaScript itself accepts it (with the `u` flag Ajv uses), rewritten
 * where the two read alike syntax differently, then translated
 * (`\uXXXX`, `\u{...}`, `[^]`, `\cX`) and compiled; what RE2 cannot run
 * (lookaround, a repeat over 1,000) is refused with its reason.
 */
function compilePattern(
  pattern: string,
): { expression: RE2JS; size: number } | { problem: string } {
  const known = compiledPatterns.get(pattern);
  if (known) return known;
  const compiled = (():
    | { expression: RE2JS; size: number }
    | { problem: string } => {
    if (pattern.length > PATTERN_MAX)
      return {
        problem: `it is over ${PATTERN_MAX.toLocaleString("en-US")} characters`,
      };
    try {
      new RegExp(pattern, "u");
    } catch (error) {
      return {
        problem: `it is not an ECMAScript pattern: ${error instanceof Error ? error.message : String(error)}`,
      };
    }
    const rewritten = withEcmaMeaning(pattern);
    if (typeof rewritten !== "string") return rewritten;
    try {
      const expression = RE2JS.compile(RE2JS.translateRegExp(rewritten));
      const size = expression.programSize();
      return size > PATTERN_PROGRAM_MAX
        ? {
            problem: `it compiles to ${size.toLocaleString("en-US")} instructions, over ${PATTERN_PROGRAM_MAX.toLocaleString("en-US")}`,
          }
        : { expression, size };
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      return {
        problem: `Work matches patterns in linear time (RE2), without backreferences or lookaround: ${reason}`,
      };
    }
  })();
  compiledPatterns.set(pattern, compiled);
  compiledInstructions += "size" in compiled ? compiled.size : 1;
  for (const [oldest, entry] of compiledPatterns) {
    if (compiledInstructions <= COMPILED_INSTRUCTIONS_MAX) break;
    compiledPatterns.delete(oldest);
    compiledInstructions -= "size" in entry ? entry.size : 1;
  }
  return compiled;
}

/** Whether text is over the code points a pattern is tried on, as `maxLength` counts. */
function tooLongToMatch(value: string): boolean {
  if (value.length <= PATTERN_INPUT_MAX) return false;
  let points = 0;
  for (const _ of value) if (++points > PATTERN_INPUT_MAX) return true;
  return false;
}

/**
 * Ajv's regular expressions for result schemas (ADR 0336): RE2's, which
 * match in time linear in the input, through re2js, so an agent's value
 * cannot make a project's pattern backtrack on the server's event loop.
 * Each match spends from the check's time, and a string too long to match
 * refuses the value. Ajv keeps one per `toString()`, so each says its own
 * pattern.
 */
const linearRegExp = Object.assign(
  (pattern: string) => {
    const compiled = compilePattern(pattern);
    if ("problem" in compiled)
      throw new Error(
        `pattern ${JSON.stringify(pattern)}: ${compiled.problem}`,
      );
    const { expression } = compiled;
    return {
      test: (value: string) => {
        if (!patternWork.active)
          return !tooLongToMatch(value) && expression.test(value);
        if (patternWork.refused) return false;
        if (tooLongToMatch(value)) {
          patternWork.refused = TOO_LONG_TO_MATCH;
          return false;
        }
        if (performance.now() - patternWork.since > PATTERN_TIME_MAX) {
          patternWork.refused = TOO_MUCH_PATTERN_WORK;
          return false;
        }
        return expression.test(value);
      },
      toString: () => `/${pattern}/`,
    };
  },
  { code: "linearRegExp" },
);

/**
 * Why a pattern is refused when its definition loads, or undefined:
 * patterns run with RE2's semantics, which has no backreferences or
 * lookaround, and a program over {@link PATTERN_PROGRAM_MAX} instructions
 * is refused too.
 */
export function unusablePattern(pattern: string): string | undefined {
  const compiled = compilePattern(pattern);
  return "problem" in compiled ? compiled.problem : undefined;
}

/** Every regular expression a schema holds: `pattern`s and `patternProperties` keys. */
function schemaPatterns(node: unknown, found: string[] = []): string[] {
  if (Array.isArray(node))
    for (const entry of node) schemaPatterns(entry, found);
  else if (node && typeof node === "object")
    for (const [key, value] of Object.entries(node)) {
      if (key === "pattern" && typeof value === "string") found.push(value);
      if (key === "patternProperties" && value && typeof value === "object")
        found.push(...Object.keys(value));
      schemaPatterns(value, found);
    }
  return found;
}

/** Why a schema cannot be used, or the instructions its patterns compile to. */
function schemaProblem(
  schema: JsonSchemaObject,
): { problem: string } | { programs: number } {
  let programs = 0;
  for (const pattern of schemaPatterns(schema)) {
    const compiled = compilePattern(pattern);
    if ("problem" in compiled)
      return {
        problem: `pattern ${JSON.stringify(pattern)} is refused: ${compiled.problem}`,
      };
    programs += compiled.size;
  }
  try {
    compileSchema(schema);
    return { programs };
  } catch (error) {
    return { problem: error instanceof Error ? error.message : String(error) };
  }
}

/**
 * Compiled validators of one core, bounded: definitions reload on every
 * turn, so recompiling each submission's schema would waste the work.
 */
export class ResultValidators {
  /**
   * Replica memory (b): compiled validators keyed by the schema's digest,
   * the least recently used dropped past the limit.
   */
  private readonly compiled = new Map<string, ValidateFunction>();

  constructor(private readonly limit = 256) {}

  check(input: {
    schema: JsonSchemaObject;
    value: unknown;
  }): { value: JsonValue } | { errors: ResultFieldError[] } {
    return checkWith(this.validator(input.schema), input.value);
  }

  private validator(schema: JsonSchemaObject): ValidateFunction {
    const key = createHash("sha256")
      .update(JSON.stringify(schema))
      .digest("hex");
    const known = this.compiled.get(key);
    if (known) {
      this.compiled.delete(key);
      this.compiled.set(key, known);
      return known;
    }
    const validate = compileSchema(schema);
    this.compiled.set(key, validate);
    for (const oldest of this.compiled.keys()) {
      if (this.compiled.size <= this.limit) break;
      this.compiled.delete(oldest);
    }
    return validate;
  }
}

function jsonBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? "", "utf8");
}

function fieldErrors(
  errors: readonly ErrorObject[] | null | undefined,
): ResultFieldError[] {
  return (errors ?? []).slice(0, RESULT_LIMITS.errors).map((error) => {
    const extra =
      error.keyword === "additionalProperties" &&
      typeof error.params.additionalProperty === "string"
        ? `: ${error.params.additionalProperty}`
        : error.keyword === "enum" && Array.isArray(error.params.allowedValues)
          ? `: ${error.params.allowedValues.map((value: unknown) => JSON.stringify(value)).join(", ")}`
          : "";
    // A `not` says what it refuses with its own description, if it has one.
    const refusing =
      error.keyword === "not" &&
      typeof error.schema === "object" &&
      error.schema !== null &&
      "description" in error.schema &&
      typeof error.schema.description === "string"
        ? error.schema.description
        : undefined;
    return {
      path: error.instancePath,
      message:
        refusing ?? `${error.message ?? `fails ${error.keyword}`}${extra}`,
    };
  });
}

/**
 * Check a submitted value against its schema, compiling it afresh (a
 * core checks submissions through its {@link ResultValidators}). A string
 * that does not match but decodes once as JSON to a value that does is
 * accepted decoded: models often send objects and arrays as JSON text.
 */
export function checkResultValue(input: {
  schema: JsonSchemaObject;
  value: unknown;
}): { value: JsonValue } | { errors: ResultFieldError[] } {
  return checkWith(compileSchema(input.schema), input.value);
}

function checkWith(
  validate: ValidateFunction,
  submitted: unknown,
): { value: JsonValue } | { errors: ResultFieldError[] } {
  const text = JSON.stringify(submitted);
  if (text === undefined)
    return { errors: [{ path: "", message: "must be a JSON value" }] };
  const value = JSON.parse(text) as JsonValue;
  // One budget of pattern time for the value, its decoded text included.
  patternWork.since = performance.now();
  patternWork.refused = null;
  if (validated(validate, value)) return { value };
  if (patternWork.refused) return { errors: [patternWork.refused] };
  const errors = fieldErrors(validate.errors);
  if (typeof value !== "string") return { errors };
  const decoded = decodeOnce(value);
  if (decoded === undefined || typeof decoded === "string") return { errors };
  if (validated(validate, decoded)) return { value: decoded };
  if (patternWork.refused) return { errors: [patternWork.refused] };
  // It was the right kind of value sent as text: say so, and what to fix in it.
  return {
    errors: [
      {
        path: "",
        message:
          "arrived as JSON text; decoded once, it still does not match. Send it as JSON, and fix",
      },
      ...fieldErrors(validate.errors),
    ],
  };
}

/** One check of a value, spending from the check's time for patterns. */
function validated(validate: ValidateFunction, value: JsonValue): boolean {
  patternWork.active = true;
  try {
    return validate(value) && !patternWork.refused;
  } finally {
    patternWork.active = false;
  }
}

function decodeOnce(text: string): JsonValue | undefined {
  try {
    return JSON.parse(text) as JsonValue;
  } catch {
    return undefined;
  }
}

/** Whether a value fits the per-result bound, as JSON. */
export function resultValueFits(value: JsonValue): boolean {
  return jsonBytes(value) <= RESULT_LIMITS.valueBytes;
}

/** The tool's description: what it does, and each result's schema. */
export function submitResultDescription(schemas: ResultSchemas): string {
  const names = Object.keys(schemas).sort();
  return [
    "Submit a result your definition declares. Only an accepted result counts: whoever reads your work (a workflow, the session that started you) reads results, not your messages. The value must match the result's JSON Schema; a rejected call records nothing and lists each failing field, so correct those fields and call again. Pass value as JSON, not as text. Submit again after a later message asks for something new (a person's, a workflow's, another chat's): a result made before it no longer counts. Your own subsessions' reports and task notifications do not make it stale.",
    "Results:",
    ...names.map((name) => `- ${name}: ${JSON.stringify(schemas[name])}`),
  ].join("\n");
}

export const submitResultInputSchema = z.object({
  name: z.string().min(1).describe("The result's name"),
  // Any JSON: the named schema decides, and its errors say what to fix.
  value: z.unknown().describe("The value, matching that result's JSON Schema"),
});
