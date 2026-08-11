import type {
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
} from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import type { z } from "zod";
import type {
  WorkflowEdgeSchema,
  WorkflowGraphSchema,
  WorkflowNodeSchema,
  WorkflowNodeTypeSchema,
} from "../schemas.js";

/**
 * The graph schemas in schemas.ts mirror `@catamorphic/parser` by hand so
 * OpenAPI-derived types stay assignable to the parser's in-memory types.
 * These are compile-time assertions: adding a node type, a graph field, or
 * a node field on one side without the other fails `typecheck`, not a
 * production request.
 */

type MutuallyAssignable<A, B> = [A] extends [B]
  ? [B] extends [A]
    ? true
    : never
  : never;

/** Every value the parser can produce must serialize through the schema. */
type Serializes<Parser, Schema extends z.ZodType> = [Parser] extends [
  z.input<Schema>,
]
  ? true
  : never;

const nodeTypeEnumInSync: MutuallyAssignable<
  z.infer<typeof WorkflowNodeTypeSchema>,
  WorkflowNodeType
> = true;

const edgeSerializes: Serializes<WorkflowEdge, typeof WorkflowEdgeSchema> =
  true;

const nodeSerializes: Serializes<WorkflowNode, typeof WorkflowNodeSchema> =
  true;

// `execution` is deliberately absent from the response schema (internals are
// redacted); assignability ignores the extra field, so this still guards
// every field the schema does declare.
const graphSerializes: Serializes<WorkflowGraph, typeof WorkflowGraphSchema> =
  true;

describe("parser ↔ fastify schema sync", () => {
  it("holds at compile time", () => {
    expect(nodeTypeEnumInSync).toBe(true);
    expect(edgeSerializes).toBe(true);
    expect(nodeSerializes).toBe(true);
    expect(graphSerializes).toBe(true);
  });
});
