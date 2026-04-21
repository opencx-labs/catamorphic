// Browser-safe entrypoint: layout + shared types only. Importing the main
// `@catamorphic/parser` entry pulls in `ts-morph` (→ `node:fs`), which cannot
// run in a browser bundle. Clients that just need to layout a
// pre-parsed `WorkflowGraph` should import from `@catamorphic/parser/layout`.
export type { LayoutedGraph, LayoutedNode } from "./layout.js";
export { layoutGraph } from "./layout.js";
export type {
  SourceRange,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowNodeType,
} from "./types.js";
