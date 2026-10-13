import {
  type KyselyPlugin,
  OperationNodeTransformer,
  type PluginTransformQueryArgs,
  type PluginTransformResultArgs,
  PrimitiveValueListNode,
  type QueryResult,
  type RootOperationNode,
  type UnknownRow,
  ValueNode,
} from "kysely";

/**
 * A `\u` escape of a lone surrogate or of U+0000, unless its backslash is
 * itself escaped. JSON.stringify writes a surrogate as an escape only when
 * the other half of its pair is missing, as a string cut at a length through
 * an emoji leaves it.
 */
const UNSTORABLE_ESCAPE = /(?<!\\)((?:\\\\)*)\\u(?:d[89a-f][0-9a-f]{2}|0000)/g;

/**
 * A JSON value as text jsonb accepts. jsonb refuses a lone surrogate
 * (`invalid input syntax for type json`) and U+0000, and with them the whole
 * statement; each arrives as U+FFFD. Bind it with `::jsonb` when the value
 * may be a bare string, which both drivers would otherwise send as raw text.
 */
export function jsonbText(value: unknown): string {
  // A value JSON cannot write (undefined, a function) is null, as in an array.
  return (JSON.stringify(value) ?? "null").replace(
    UNSTORABLE_ESCAPE,
    "$1\\ufffd",
  );
}

/**
 * A JSON value as jsonb gives it back: {@link jsonbText}, read. Keep a value
 * in this form when it is compared with one read from the database, so both
 * carry U+FFFD in the same places. `T` is JSON: as in JSON, a property whose
 * value is undefined is left out.
 */
export function storedJson<T>(value: T): T {
  return JSON.parse(jsonbText(value));
}

/** A value the drivers would send as JSON: an array, or a plain object. */
function isJsonContainer(value: unknown): value is object {
  if (Array.isArray(value)) return true;
  if (typeof value !== "object" || value === null) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

/**
 * U+0000 or a lone surrogate in a string: in Unicode mode a surrogate
 * matches on its own only when the other half of its pair is missing.
 */
// biome-ignore lint/suspicious/noControlCharactersInRegex: replacing U+0000 is the point
const UNSTORABLE_CHARACTER = /[\u0000\ud800-\udfff]/gu;

/**
 * Text as Postgres stores it: U+0000 and a lone surrogate become U+FFFD.
 * text refuses U+0000, and PGlite miscounts the bytes of a lone surrogate,
 * cutting the value short or refusing it. Name a thing in this form when the
 * name is also stored, so the two stay the same name.
 */
export function storableText(text: string): string {
  return text.replace(UNSTORABLE_CHARACTER, "\uFFFD");
}

/** A parameter as Postgres stores it (see {@link storableText}). */
function storable(value: unknown): unknown {
  if (typeof value === "string") return storableText(value);
  return isJsonContainer(value) ? jsonbText(value) : value;
}

/**
 * Every parameter as a value Postgres stores (see {@link storable}).
 * node-postgres sends a JS array as a Postgres array literal (`{a,b}`),
 * which jsonb reads as `{}` when empty and refuses otherwise; Catamorphic's
 * schema has no Postgres array columns and binds no arrays for `ANY()`, so
 * every array is meant for jsonb. Arrays and plain objects are sent as
 * {@link jsonbText}, which both drivers pass to jsonb as it is.
 */
class StorableParametersTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    const value = storable(node.value);
    if (value === node.value) return node;
    return node.immediate
      ? ValueNode.createImmediate(value)
      : ValueNode.create(value);
  }

  /**
   * An inserted row's values, or the right side of a comparison with an
   * array (`in (...)`): an array among them is a jsonb value.
   */
  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
  ): PrimitiveValueListNode {
    const values = node.values.map(storable);
    return values.some((value, index) => value !== node.values[index])
      ? PrimitiveValueListNode.create(values)
      : node;
  }
}

/**
 * Sends every parameter as a value Postgres stores (see
 * {@link StorableParametersTransformer}). Apply it with
 * `withStorableParameters` from this package.
 */
export class StorableParametersPlugin implements KyselyPlugin {
  private readonly transformer = new StorableParametersTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
