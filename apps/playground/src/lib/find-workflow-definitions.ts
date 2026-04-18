/**
 * Scan a TypeScript source file for workflow function definitions.
 *
 * A workflow is any `async function NAME(...)` whose body opens with the
 * `"use workflow"` directive. Returns the 1-based line number of the
 * `function` keyword so it can be used for Monaco decorations.
 *
 * Regex-based (not a full AST walk) because this runs in the browser on every
 * keystroke and must stay cheap. Matches the same heuristic used by
 * {@link findWorkflowFile} in workflow-page-client.
 */
export interface WorkflowDefinition {
  name: string;
  line: number;
}

const FUNCTION_LINE = /^\s*(?:export\s+)?async\s+function\s+(\w+)\s*\(/;
const USE_WORKFLOW = /"use workflow"/;

/**
 * How many lines after the `function` keyword we'll scan looking for the
 * `"use workflow"` directive. Long multi-line parameter destructurings can push
 * the directive far down, but 40 lines is more than enough in practice.
 */
const MAX_DIRECTIVE_SCAN_LINES = 40;

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
    const match = line.match(FUNCTION_LINE);
    const name = match?.[1];
    if (!name) continue;
    const end = Math.min(i + MAX_DIRECTIVE_SCAN_LINES, lines.length);
    for (let j = i + 1; j < end; j++) {
      const body = lines[j];
      if (body !== undefined && USE_WORKFLOW.test(body)) {
        results.push({ name, line: i + 1 });
        break;
      }
    }
  }

  return results;
}
