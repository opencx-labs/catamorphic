import { Project, type SourceFile, SyntaxKind } from "ts-morph";
import { parseWorkflowFromProject } from "./parser.js";
import type { SourceRange, WorkflowGraph } from "./types.js";

export interface PreparedWorkflowExecution {
  files: Record<string, string>;
  graph: WorkflowGraph;
}

interface SourceEdit {
  start: number;
  end: number;
  replacement: string;
}

export function prepareWorkflowExecution(opts: {
  files: Record<string, string>;
  workflowName: string;
}): PreparedWorkflowExecution | null {
  const graph = parseWorkflowFromProject(opts.files, opts.workflowName);
  if (!graph) return null;

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true },
  });
  const sourceFiles = new Map<string, SourceFile>();
  for (const [filePath, source] of Object.entries(opts.files)) {
    sourceFiles.set(
      normalizePath(filePath),
      project.createSourceFile(filePath, source, { overwrite: true }),
    );
  }

  const editsByFile = new Map<string, SourceEdit[]>();
  for (const node of graph.nodes) {
    if (node.type !== "step" || !node.functionName) continue;
    const filePath = normalizePath(
      node.sourceRange.file ?? graph.filePath ?? "",
    );
    const sourceFile = sourceFiles.get(filePath);
    if (!sourceFile) {
      throw new Error(`Step source file '${filePath}' was not found`);
    }
    const call = findStepCall({
      sourceFile,
      range: node.sourceRange,
      functionName: node.functionName,
    });
    const args = call.getArguments();
    if (args.length > 1) {
      throw new Error(
        `Step '${node.functionName}' must receive one object argument`,
      );
    }
    const input = args[0]?.getText() ?? "undefined";
    const callable = call.getExpression().getText();
    const replacement = [
      "globalThis.__catamorphicRunStep(",
      JSON.stringify(node.id),
      ", ",
      JSON.stringify(node.label),
      ", (__catamorphicInput) => ",
      callable,
      "(__catamorphicInput), ",
      input,
      ")",
    ].join("");
    const edits = editsByFile.get(filePath) ?? [];
    edits.push({
      start: call.getStart(),
      end: call.getEnd(),
      replacement,
    });
    editsByFile.set(filePath, edits);
  }

  const transformed = { ...opts.files };
  for (const [filePath, edits] of editsByFile) {
    const original = opts.files[filePath];
    if (original === undefined) {
      throw new Error(`Workflow source file '${filePath}' was not found`);
    }
    transformed[filePath] = applyEdits(original, edits);
  }

  return { files: transformed, graph };
}

function findStepCall(opts: {
  sourceFile: SourceFile;
  range: SourceRange;
  functionName: string;
}) {
  const candidates = opts.sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .filter(
      (call) =>
        call.getStart() >= opts.range.start &&
        call.getEnd() <= opts.range.end &&
        call.getExpression().getText() === opts.functionName,
    );
  const call = candidates[0];
  if (!call) {
    throw new Error(
      `Could not locate call site for step '${opts.functionName}'`,
    );
  }
  return call;
}

function applyEdits(source: string, edits: SourceEdit[]): string {
  return [...edits]
    .sort((left, right) => right.start - left.start)
    .reduce(
      (current, edit) =>
        `${current.slice(0, edit.start)}${edit.replacement}${current.slice(edit.end)}`,
      source,
    );
}

function normalizePath(filePath: string): string {
  return filePath.startsWith("/") ? filePath.slice(1) : filePath;
}
