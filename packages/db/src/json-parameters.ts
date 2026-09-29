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
 * node-postgres sends a JS array parameter as a Postgres array literal
 * (`{a,b}`), which a jsonb column reads as `{}` when empty and refuses
 * otherwise. Catamorphic's schema has no Postgres array columns and binds no
 * arrays for `ANY()`: every array parameter is meant for jsonb. This sends
 * each one as JSON text, which jsonb reads as the array it is. PGlite reads
 * the text the same way.
 */
class JsonArrayTransformer extends OperationNodeTransformer {
  protected override transformValue(node: ValueNode): ValueNode {
    if (!Array.isArray(node.value)) return node;
    const json = JSON.stringify(node.value);
    return node.immediate
      ? ValueNode.createImmediate(json)
      : ValueNode.create(json);
  }

  /**
   * An inserted row's values, or the right side of a comparison with an
   * array (`in (...)`): an array among them is a jsonb value.
   */
  protected override transformPrimitiveValueList(
    node: PrimitiveValueListNode,
  ): PrimitiveValueListNode {
    return node.values.some(Array.isArray)
      ? PrimitiveValueListNode.create(
          node.values.map((value) =>
            Array.isArray(value) ? JSON.stringify(value) : value,
          ),
        )
      : node;
  }
}

/**
 * Sends array parameters as JSON text (see {@link JsonArrayTransformer}).
 * Apply it with `withJsonArrayParameters` from this package.
 */
export class JsonArrayParametersPlugin implements KyselyPlugin {
  private readonly transformer = new JsonArrayTransformer();

  transformQuery(args: PluginTransformQueryArgs): RootOperationNode {
    return this.transformer.transformNode(args.node, args.queryId);
  }

  async transformResult(
    args: PluginTransformResultArgs,
  ): Promise<QueryResult<UnknownRow>> {
    return args.result;
  }
}
