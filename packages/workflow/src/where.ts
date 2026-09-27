/**
 * Declarative event filters (ADR 0171). A `where` names positions of a
 * trigger's payload and what each must hold; the host evaluates it on the
 * control plane before a run starts, so filtering never runs project code.
 *
 * - A JSON primitive matches by equality.
 * - An array of primitives matches when the value is one of them.
 * - `{ exists: true }` matches a present, non-null value; `{ exists: false }`
 *   an absent or null one.
 * - `{ prefix: "slack:" }` matches a string that starts with it, such as a
 *   namespace of chat keys.
 * - An object descends: every key it names must match. Header names match
 *   case-insensitively.
 */

/** A JSON value a `where` leaf compares against. */
export type WherePrimitive = string | number | boolean | null;

/** Matches a present, non-null value (`true`) or an absent or null one. */
export interface WhereExists {
  readonly exists: boolean;
}

/** Matches a string that starts with `prefix` (never a non-string). */
export interface WherePrefix {
  readonly prefix: string;
}

/** A filter over a position whose type is not known: any shape is allowed. */
export type WhereAny =
  | WherePrimitive
  | readonly WherePrimitive[]
  | WhereExists
  | WherePrefix
  | { readonly [key: string]: WhereAny };

type WhereEquals<Value> = [Extract<Value, WherePrimitive>] extends [never]
  ? never
  : Extract<Value, WherePrimitive> | readonly Extract<Value, WherePrimitive>[];

type WhereString<Value> = [Extract<Value, string>] extends [never]
  ? never
  : WherePrefix;

type WhereObject<Value> = [
  Exclude<Value, WherePrimitive | readonly unknown[]>,
] extends [never]
  ? never
  : Exclude<Value, WherePrimitive | readonly unknown[]> extends infer Shape
    ? Shape extends object
      ? { readonly [Key in keyof Shape]?: Where<Shape[Key]> }
      : never
    : never;

/**
 * A filter typed against a payload: a deep partial whose leaves accept a
 * value, a list of values, `{ exists }`, or `{ prefix }` where the payload
 * holds a string. Arrays in the payload can only be tested for existence.
 */
export type Where<Payload> = unknown extends Payload
  ? WhereAny
  :
      | WhereEquals<Payload>
      | WhereString<Payload>
      | WhereObject<Payload>
      | WhereExists;

/**
 * `Base` with the positions `Patch` names typed more precisely: how a
 * project trigger kind states what its filtered events carry, e.g.
 * `Narrow<TriggerPayload<"webhook">, { payload: { body: PullRequestEvent } }>`.
 * Objects on both sides merge key by key; anything else in `Patch` replaces
 * the position.
 */
export type Narrow<Base, Patch> = [Patch] extends [readonly unknown[]]
  ? Patch
  : [Patch] extends [object]
    ? [Base] extends [readonly unknown[]]
      ? Patch
      : [Base] extends [object]
        ? Omit<Base, keyof Patch> & {
            [Key in keyof Patch]: Key extends keyof Base
              ? Narrow<Base[Key], Patch[Key]>
              : Patch[Key];
          }
        : Patch
    : Patch;
