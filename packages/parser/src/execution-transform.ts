import { Project, type SourceFile, SyntaxKind } from "ts-morph";
import { parseProject } from "./parser.js";
import type {
  DiscoveredWorkflow,
  SourceRange,
  WorkflowGraph,
  WorkflowNode,
} from "./types.js";

export const EXECUTION_TRANSFORM_VERSION = "execution-transform-v3";

export interface PreparedProjectExecution {
  files: Record<string, string>;
  workflows: DiscoveredWorkflow[];
}

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
  const prepared = prepareProjectExecution({ files: opts.files });
  const selected = prepared.workflows.find(
    (workflow) => workflow.functionName === opts.workflowName,
  );
  if (!selected) return null;

  return { files: prepared.files, graph: selected.graph };
}

export function prepareProjectExecution(opts: {
  files: Record<string, string>;
}): PreparedProjectExecution {
  const parsed = parseProject(opts.files);
  if (parsed.errors.length > 0) {
    throw new Error(
      parsed.errors
        .map((error) =>
          error.file ? `${error.file}: ${error.message}` : error.message,
        )
        .join("\n"),
    );
  }

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
  const workflows = [...parsed.workflows].sort((left, right) =>
    compareWorkflows({ left, right }),
  );
  for (const workflow of workflows) {
    collectWorkflowEdits({
      graph: workflow.graph,
      sourceFiles,
      editsByFile,
    });
  }

  const transformed = { ...opts.files };
  for (const [filePath, edits] of editsByFile) {
    const original = opts.files[filePath];
    if (original === undefined) {
      throw new Error(`Workflow source file '${filePath}' was not found`);
    }
    transformed[filePath] = applyEdits(original, edits);
  }

  return { files: transformed, workflows: parsed.workflows };
}

function collectWorkflowEdits(opts: {
  graph: WorkflowGraph;
  sourceFiles: ReadonlyMap<string, SourceFile>;
  editsByFile: Map<string, SourceEdit[]>;
}): void {
  for (const node of opts.graph.nodes) {
    if (!isOwnedByWorkflow({ graph: opts.graph, node })) continue;
    if (node.type === "call-workflow" && node.workflowName) {
      collectWorkflowCallEdit({ ...opts, node });
    }
  }
  for (const node of opts.graph.nodes) {
    if (
      !isOwnedByWorkflow({ graph: opts.graph, node }) ||
      node.type !== "step" ||
      !node.functionName ||
      (opts.graph.capabilities.persistedContinuations &&
        !hasAncestorOfType({
          graph: opts.graph,
          nodeId: node.id,
          type: "batch",
        }))
    ) {
      continue;
    }
    const filePath = nodeFilePath({ graph: opts.graph, node });
    const sourceFile = opts.sourceFiles.get(filePath);
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
    addEdit({
      editsByFile: opts.editsByFile,
      filePath,
      edit: {
        start: call.getStart(),
        end: call.getEnd(),
        replacement: [
          "globalThis.__catamorphicRunStep(",
          JSON.stringify(node.id),
          ", ",
          JSON.stringify(node.label),
          ", (__catamorphicInput) => ",
          callable,
          "(__catamorphicInput), ",
          input,
          ", ",
          JSON.stringify(node.functionName),
          ")",
        ].join(""),
      },
    });
  }
}

function collectWorkflowCallEdit(opts: {
  graph: WorkflowGraph;
  node: WorkflowNode;
  sourceFiles: ReadonlyMap<string, SourceFile>;
  editsByFile: Map<string, SourceEdit[]>;
}): void {
  const filePath = nodeFilePath(opts);
  const sourceFile = opts.sourceFiles.get(filePath);
  if (!sourceFile) return;
  const call = sourceFile
    .getDescendantsOfKind(SyntaxKind.CallExpression)
    .find(
      (candidate) =>
        candidate.getStart() === opts.node.sourceRange.start &&
        candidate.getExpression().getText() === "callWorkflow",
    );
  if (!call) return;
  const args = call.getArguments().map((argument) => argument.getText());
  args.push(
    JSON.stringify({
      callSiteId: opts.node.id,
      workflowName: opts.node.workflowName,
      modulePath:
        opts.node.workflowTarget?.exportTarget.modulePath ??
        opts.node.metadata.childModulePath,
      exportName:
        opts.node.workflowTarget?.exportTarget.exportName ??
        opts.node.metadata.childExportName,
      capabilities: opts.node.workflowTarget?.capabilities,
      execution: opts.node.workflowTarget?.execution,
      boundaries: opts.graph.nodes
        .filter(
          (candidate) =>
            candidate.type === "durable-boundary" &&
            candidate.parentId === opts.node.id,
        )
        .map((candidate, index) => ({
          id: candidate.id,
          index,
          retry: {
            maxAttempts: Number(candidate.metadata["retry:maxAttempts"] ?? 1),
            initial: candidate.metadata["retry:backoff.initial"] ?? null,
            maximum: candidate.metadata["retry:backoff.maximum"] ?? null,
            multiplier: Number(
              candidate.metadata["retry:backoff.multiplier"] ?? 2,
            ),
          },
        })),
    }),
  );
  addEdit({
    editsByFile: opts.editsByFile,
    filePath,
    edit: {
      start: call.getStart(),
      end: call.getEnd(),
      replacement: `callWorkflow(${args.join(", ")})`,
    },
  });
}

function isOwnedByWorkflow(opts: {
  graph: WorkflowGraph;
  node: WorkflowNode;
}): boolean {
  const trigger = opts.graph.nodes.find(
    (node) => node.type === "input" && !node.parentId,
  );
  if (
    !trigger ||
    nodeFilePath(opts) !== normalizePath(opts.graph.filePath ?? "")
  ) {
    return false;
  }
  return (
    opts.node.sourceRange.start >= trigger.sourceRange.start &&
    opts.node.sourceRange.end <= trigger.sourceRange.end
  );
}

function nodeFilePath(opts: {
  graph: WorkflowGraph;
  node: WorkflowNode;
}): string {
  return normalizePath(opts.node.sourceRange.file ?? opts.graph.filePath ?? "");
}

function addEdit(opts: {
  editsByFile: Map<string, SourceEdit[]>;
  filePath: string;
  edit: SourceEdit;
}): void {
  const edits = opts.editsByFile.get(opts.filePath) ?? [];
  const existing = edits.find(
    (edit) => edit.start === opts.edit.start && edit.end === opts.edit.end,
  );
  if (existing && existing.replacement !== opts.edit.replacement) {
    throw new Error(
      `Conflicting execution transforms in '${opts.filePath}' at ${opts.edit.start}`,
    );
  }
  if (!existing) edits.push(opts.edit);
  opts.editsByFile.set(opts.filePath, edits);
}

function compareWorkflows(opts: {
  left: DiscoveredWorkflow;
  right: DiscoveredWorkflow;
}): number {
  return (
    opts.left.filePath.localeCompare(opts.right.filePath) ||
    opts.left.functionName.localeCompare(opts.right.functionName)
  );
}

function hasAncestorOfType(opts: {
  graph: WorkflowGraph;
  nodeId: string;
  type: WorkflowGraph["nodes"][number]["type"];
}): boolean {
  const nodes = new Map(opts.graph.nodes.map((node) => [node.id, node]));
  let current = nodes.get(opts.nodeId);
  while (current?.parentId) {
    current = nodes.get(current.parentId);
    if (current?.type === opts.type) return true;
  }
  return false;
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
