import type {
  SourceRange,
  WorkflowNode,
  WorkflowNodeType,
} from "@catamorphic/parser";

export interface EditorPosition {
  /** 1-based line number, matching parser `SourceRange` and Monaco. */
  line: number;
  /** 1-based column number, matching parser `SourceRange` and Monaco. */
  column: number;
}

/**
 * Container nodes wrap other nodes, so their ranges contain everything
 * inside them. They only win when no leaf node contains the position
 * (e.g. the cursor is on the `if (...)` line itself). The trigger belongs
 * here because its range is the entire workflow function.
 */
const CONTAINER_TYPES: ReadonlySet<WorkflowNodeType> = new Set([
  "trigger",
  "if-block",
  "loop-block",
  "parallel-block",
  "scope-block",
]);

function rangeContains(range: SourceRange, position: EditorPosition): boolean {
  if (position.line < range.startLine || position.line > range.endLine) {
    return false;
  }
  if (
    position.line === range.startLine &&
    position.column < range.startColumn
  ) {
    return false;
  }
  if (position.line === range.endLine && position.column > range.endColumn) {
    return false;
  }
  return true;
}

function smallestSpan(nodes: readonly WorkflowNode[]): WorkflowNode {
  return nodes.reduce((best, node) =>
    node.sourceRange.end - node.sourceRange.start <
    best.sourceRange.end - best.sourceRange.start
      ? node
      : best,
  );
}

/**
 * Finds the node whose source range contains the given cursor position —
 * the code → canvas half of bidirectional linking. Prefers the
 * smallest-span non-container node; falls back to the smallest container
 * when the position only hits structural code (block keywords, braces).
 */
export function findNodeAtPosition({
  nodes,
  position,
}: {
  nodes: readonly WorkflowNode[];
  position: EditorPosition;
}): WorkflowNode | null {
  const containing = nodes.filter((node) =>
    rangeContains(node.sourceRange, position),
  );
  if (containing.length === 0) return null;

  const leaves = containing.filter((node) => !CONTAINER_TYPES.has(node.type));
  return leaves.length > 0 ? smallestSpan(leaves) : smallestSpan(containing);
}
