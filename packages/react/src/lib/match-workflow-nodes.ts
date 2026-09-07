import type { WorkflowNode } from "@catamorphic/parser";

/** View identity only. Parser ids remain untouched for execution and provenance. */
export function workflowNodeKeys(
  nodes: readonly WorkflowNode[],
): Map<string, string> {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const keys = new Map<string, string>();
  const occurrences = new Map<string, number>();
  const visit = (node: WorkflowNode): string => {
    const existing = keys.get(node.id);
    if (existing) return existing;
    const parent = node.parentId ? byId.get(node.parentId) : undefined;
    const signature = JSON.stringify([
      parent ? visit(parent) : "root",
      node.type,
      node.sourceRange.file ?? "",
      node.functionName ?? (node.type === "input" ? "input" : node.label),
    ]);
    const occurrence = occurrences.get(signature) ?? 0;
    occurrences.set(signature, occurrence + 1);
    const key = `${signature}:${occurrence}`;
    keys.set(node.id, key);
    return key;
  };
  for (const node of nodes) visit(node);
  return keys;
}

export function matchWorkflowNodes({
  previous,
  next,
}: {
  previous: readonly WorkflowNode[];
  next: readonly WorkflowNode[];
}): Map<string, string> {
  const previousIds = new Map(
    [...workflowNodeKeys(previous)].map(([id, key]) => [key, id]),
  );
  return new Map(
    [...workflowNodeKeys(next)].flatMap(([id, key]) => {
      const previousId = previousIds.get(key);
      return previousId ? [[id, previousId]] : [];
    }),
  );
}
