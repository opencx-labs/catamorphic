/**
 * Scan a TypeScript source file for workflow definitions.
 *
 * A workflow is a `const NAME = defineWorkflow(...)` declaration (exported or
 * not). Returns the 1-based line number of the declaration so it can be used
 * for Monaco decorations.
 *
 * Regex-based (not a full AST walk) because this runs in the browser on every
 * keystroke and must stay cheap.
 */
export interface WorkflowDefinition {
  name: string;
  line: number;
}

const DEFINE_WORKFLOW_LINE =
  /^\s*(?:export\s+)?const\s+(\w+)\s*=\s*defineWorkflow\s*\(/;

export function findWorkflowDefinitions({
  source,
}: {
  source: string;
}): WorkflowDefinition[] {
  const lines = source.split("\n");
  const results: WorkflowDefinition[] = [];

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === undefined) continue;
    const match = line.match(DEFINE_WORKFLOW_LINE);
    const name = match?.[1];
    if (!name) continue;
    results.push({ name, line: i + 1 });
  }

  return results;
}
