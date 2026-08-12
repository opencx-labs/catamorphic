/**
 * Typed holes — the mechanism behind parameterized trigger kinds (ADR 0042).
 *
 * A host-defined trigger kind may leave named positions of its payload (or
 * output) template deliberately open: `hole("Args")` on the host side emits
 * `Hole<"Args">` into the generated `catamorphic-triggers.d.ts`. Each
 * workflow that binds the kind instantiates every hole with its own input
 * type — nothing is written at the `trigger()` call site; the workflow's
 * first-step input (and last-step output) IS the instantiation, and the
 * derived JSON Schemas freeze it per binding at scan time.
 */

declare const holeName: unique symbol;

/**
 * A named open position in a trigger kind's payload or output template,
 * filled in by each bound workflow's own types. Never constructed at
 * runtime — it only appears in generated trigger-kind types.
 */
export interface Hole<Name extends string = string> {
  readonly [holeName]: Name;
}

type IsHole<Value> = [Exclude<Value, undefined>] extends [never]
  ? false
  : [Exclude<Value, undefined>] extends [Hole<string>]
    ? true
    : false;

/**
 * Does the workflow's first-step input accept what the kind fires?
 * Fixed template parts are host-produced, so the input must accept them
 * (the pre-hole `[Payload] extends [Input]` rule, applied per part); a
 * hole is defined BY the input at that position, so it always matches —
 * the scan then fails closed if the derived schema there is permissive.
 */
export type PayloadTemplateMatches<Template, Input> =
  IsHole<Template> extends true
    ? true
    : [Template] extends [Input]
      ? true
      : [Template] extends [readonly (infer TemplateItem)[]]
        ? [Input] extends [readonly (infer InputItem)[]]
          ? // Element-wise matching is only sound when the input accepts any
            // length; a tuple input demands exact assignability, which the
            // fast path above already decided.
            number extends Input["length"]
            ? PayloadTemplateMatches<TemplateItem, InputItem>
            : false
          : false
        : [Template] extends [object]
          ? [Input] extends [object]
            ? PayloadObjectMatches<Template, Input>
            : false
          : false;

type PayloadObjectMatches<Template, Input> = {
  [Key in keyof Input]-?: Key extends keyof Template
    ? PayloadTemplateMatches<Template[Key], Input[Key]>
    : // The workflow may declare extra optional fields the host never
      // sends; a required field outside the template can never be filled.
      undefined extends Input[Key]
      ? true
      : false;
} extends { [Key in keyof Input]-?: true }
  ? true
  : false;

/**
 * Does the workflow's final-step output satisfy the kind's output template?
 * The mirror of {@link PayloadTemplateMatches}: fixed parts flow FROM the
 * workflow TO the host (e.g. an HTTP response envelope), so the output must
 * provide them; holes are defined by the output itself.
 */
export type OutputTemplateMatches<Template, Output> = [unknown] extends [
  Template,
]
  ? true // the kind declares no output template
  : IsHole<Template> extends true
    ? true
    : [Output] extends [Template]
      ? true
      : [Template] extends [readonly (infer TemplateItem)[]]
        ? [Output] extends [readonly (infer OutputItem)[]]
          ? // Mirrored soundness guard: a tuple template demands exact
            // assignability (fast path); element-wise covers plain arrays.
            number extends Template["length"]
            ? OutputTemplateMatches<TemplateItem, OutputItem>
            : false
          : false
        : [Template] extends [object]
          ? [Output] extends [object]
            ? OutputObjectMatches<Template, Output>
            : false
          : false;

type OutputObjectMatches<Template, Output> = {
  [Key in keyof Template]-?: Key extends keyof Output
    ? OutputTemplateMatches<Template[Key], Output[Key]>
    : // The output may omit template fields the kind marked optional.
      undefined extends Template[Key]
      ? true
      : false;
} extends { [Key in keyof Template]-?: true }
  ? true
  : false;
