import {
  type CallExpression,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type IfStatement,
  Node,
  Project,
  type SourceFile,
  type Statement,
  type WhileStatement,
} from "ts-morph";
import { extractJsDocMetadata, extractParameterInfo } from "./jsdoc.js";
import type {
  DiscoveredWorkflow,
  ParseError,
  ProjectParseResult,
  SourceRange,
  StepArgument,
  StepArgumentSource,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
} from "./types.js";

let nodeCounter = 0;
let currentWorkflowFile: string | undefined;

function nextId(): string {
  return `node_${++nodeCounter}`;
}

function getSourceRange(node: Node): SourceRange {
  const sf = node.getSourceFile();
  const start = node.getStart();
  const end = node.getEnd();
  const startPos = sf.getLineAndColumnAtPos(start);
  const endPos = sf.getLineAndColumnAtPos(end);
  const filePath = sf.getFilePath();
  const file =
    currentWorkflowFile && filePath !== currentWorkflowFile
      ? filePath
      : undefined;
  return {
    start,
    end,
    startLine: startPos.line,
    startColumn: startPos.column,
    endLine: endPos.line,
    endColumn: endPos.column,
    file,
  };
}

function findWorkflowFunction(
  sourceFile: SourceFile,
): FunctionDeclaration | undefined {
  for (const fn of sourceFile.getFunctions()) {
    const body = fn.getBody();
    if (!body || !Node.isBlock(body)) continue;

    const statements = body.getStatements();
    if (statements.length === 0) continue;

    const first = statements[0];
    if (
      Node.isExpressionStatement(first) &&
      first.getText().includes('"use workflow"')
    ) {
      return fn;
    }
  }
  return undefined;
}

function getCallName(node: CallExpression): string {
  return node.getExpression().getText();
}

function extractAwaitedCall(statement: Statement): CallExpression | undefined {
  if (Node.isExpressionStatement(statement)) {
    const expr = statement.getExpression();
    if (Node.isAwaitExpression(expr)) {
      const inner = expr.getExpression();
      return Node.isCallExpression(inner) ? inner : undefined;
    }
    return Node.isCallExpression(expr) ? expr : undefined;
  }

  if (Node.isVariableStatement(statement)) {
    for (const decl of statement.getDeclarationList().getDeclarations()) {
      const init = decl.getInitializer();
      if (init && Node.isAwaitExpression(init)) {
        const inner = init.getExpression();
        return Node.isCallExpression(inner) ? inner : undefined;
      }
    }
  }

  return undefined;
}

interface VariableInfo {
  displayName?: string;
  sourceNodeId?: string;
  sourceStepLabel?: string;
}

interface ParseContext {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  sourceFile: SourceFile;
  stepFunctions: Map<string, FunctionDeclaration>;
  variables: Map<string, VariableInfo>;
  workflowFile?: string;
}

function lookupStepMetadata(
  ctx: ParseContext,
  fnName: string,
): { displayName?: string; metadata: Record<string, string> } {
  const fn = ctx.stepFunctions.get(fnName);
  if (!fn) return { metadata: {} };
  const jsdoc = extractJsDocMetadata(fn);
  return { displayName: jsdoc.displayName, metadata: jsdoc.tags };
}

function lookupStepParams(ctx: ParseContext, fnName: string) {
  const fn = ctx.stepFunctions.get(fnName);
  if (!fn) return undefined;
  const jsdoc = extractJsDocMetadata(fn);
  const params = extractParameterInfo(fn, jsdoc.paramMetadata);
  return params.length > 0 ? params : undefined;
}

function addEdgesFromPrevious(
  ctx: ParseContext,
  previousIds: string[],
  targetId: string,
  type: WorkflowEdge["type"] = "sequential",
): void {
  for (const prev of previousIds) {
    ctx.edges.push({
      id: `${prev}->${targetId}`,
      source: prev,
      target: targetId,
      type,
    });
  }
}

function extractLeadingDisplayName(stmt: Statement): string | undefined {
  const ranges = stmt.getLeadingCommentRanges();
  for (const range of ranges) {
    const text = range.getText();
    const match = text.match(/@displayname\s+(.+?)(?:\s*\*\/|\s*$)/i);
    if (match?.[1]) {
      return match[1].trim();
    }
  }
  return undefined;
}

function resolveArgumentSource(
  expression: string,
  ctx: ParseContext,
): StepArgumentSource | undefined {
  if (
    /^["'`]/.test(expression) ||
    /^-?\d/.test(expression) ||
    expression === "true" ||
    expression === "false" ||
    expression === "null" ||
    expression === "undefined"
  ) {
    return undefined;
  }

  const rootVar = expression.split(".")[0]?.split("[")[0]?.trim();
  if (!rootVar) return undefined;

  const info = ctx.variables.get(rootVar);
  if (!info) return undefined;

  return {
    variable: rootVar,
    variableDisplayName: info.displayName,
    stepNodeId: info.sourceNodeId,
    stepLabel: info.sourceStepLabel,
  };
}

function extractCallArguments(
  callNode: CallExpression,
  ctx: ParseContext,
  fnName: string,
): StepArgument[] | undefined {
  const args = callNode.getArguments();
  if (args.length === 0) return undefined;

  const firstArg = args[0];
  if (!firstArg || !Node.isObjectLiteralExpression(firstArg)) return undefined;

  const fn = ctx.stepFunctions.get(fnName);
  const paramMeta = fn
    ? extractJsDocMetadata(fn).paramMetadata
    : new Map<string, { displayName?: string; description?: string }>();

  const result: StepArgument[] = [];

  for (const prop of firstArg.getProperties()) {
    if (Node.isPropertyAssignment(prop)) {
      const name = prop.getName();
      const init = prop.getInitializer();
      if (!init) continue;
      const value = init.getText();
      const meta = paramMeta.get(name);
      result.push({
        name,
        displayName: meta?.displayName,
        value,
        source: resolveArgumentSource(value, ctx),
      });
    } else if (Node.isShorthandPropertyAssignment(prop)) {
      const name = prop.getName();
      const meta = paramMeta.get(name);
      result.push({
        name,
        displayName: meta?.displayName,
        value: name,
        source: resolveArgumentSource(name, ctx),
      });
    }
  }

  return result.length > 0 ? result : undefined;
}

function registerVariablesFromStatement(
  ctx: ParseContext,
  stmt: Statement,
  sourceNodeId?: string,
  sourceStepLabel?: string,
): void {
  if (!Node.isVariableStatement(stmt)) return;

  const varDisplayName = extractLeadingDisplayName(stmt);

  for (const decl of stmt.getDeclarationList().getDeclarations()) {
    const nameNode = decl.getNameNode();
    if (Node.isIdentifier(nameNode)) {
      ctx.variables.set(nameNode.getText(), {
        displayName: varDisplayName,
        sourceNodeId,
        sourceStepLabel,
      });
    }
  }
}

interface IfBranch {
  condition: string | undefined;
  statements: Statement[];
  sourceNode: Node;
}

function collectIfBranches(stmt: IfStatement): IfBranch[] {
  const branches: IfBranch[] = [];

  const thenBlock = stmt.getThenStatement();
  const thenStatements = Node.isBlock(thenBlock)
    ? thenBlock.getStatements()
    : [thenBlock];
  branches.push({
    condition: stmt.getExpression().getText(),
    statements: thenStatements,
    sourceNode: stmt,
  });

  const elseStatement = stmt.getElseStatement();
  if (elseStatement) {
    if (Node.isIfStatement(elseStatement)) {
      branches.push(...collectIfBranches(elseStatement));
    } else if (Node.isBlock(elseStatement)) {
      branches.push({
        condition: undefined,
        statements: elseStatement.getStatements(),
        sourceNode: elseStatement,
      });
    }
  }

  return branches;
}

function extractIIFECall(expr: Node): { body: Node; stmt: Node } | undefined {
  let callExpr: CallExpression | undefined;
  if (Node.isAwaitExpression(expr)) {
    const inner = expr.getExpression();
    if (Node.isCallExpression(inner)) callExpr = inner;
  } else if (Node.isCallExpression(expr)) {
    callExpr = expr;
  }
  if (!callExpr) return undefined;

  const callee = callExpr.getExpression();
  if (Node.isParenthesizedExpression(callee)) {
    const inner = callee.getExpression();
    if (Node.isArrowFunction(inner) || Node.isFunctionExpression(inner)) {
      const body = inner.getBody();
      if (Node.isBlock(body)) {
        return { body, stmt: expr };
      }
    }
  }
  if (Node.isArrowFunction(callee) || Node.isFunctionExpression(callee)) {
    const body = callee.getBody();
    if (Node.isBlock(body)) {
      return { body, stmt: expr };
    }
  }
  return undefined;
}

function parseScopeBlock(
  ctx: ParseContext,
  block: Node,
  previousIds: string[],
  parentId?: string,
  sourceNode?: Node,
): string[] {
  const stmtNode = sourceNode ?? block;
  const displayName = Node.isStatement(stmtNode)
    ? extractLeadingDisplayName(stmtNode)
    : undefined;
  const blockId = nextId();
  ctx.nodes.push({
    id: blockId,
    type: "scope-block",
    label: displayName ?? "Block",
    sourceRange: getSourceRange(stmtNode),
    metadata: {},
    parentId,
  });

  addEdgesFromPrevious(ctx, previousIds, blockId);

  if (Node.isBlock(block)) {
    const stmts = block.getStatements();
    if (stmts.length > 0) {
      parseStatements(ctx, stmts, [], blockId);
    }
  }

  return [blockId];
}

function parseStatements(
  ctx: ParseContext,
  statements: Statement[],
  previousIds: string[],
  parentId?: string,
): string[] {
  let currentIds = [...previousIds];

  for (const stmt of statements) {
    if (
      Node.isExpressionStatement(stmt) &&
      stmt.getText().includes('"use workflow"')
    ) {
      continue;
    }

    if (Node.isIfStatement(stmt)) {
      currentIds = parseIfStatement(ctx, stmt, currentIds, parentId);
      continue;
    }

    if (
      Node.isForStatement(stmt) ||
      Node.isForOfStatement(stmt) ||
      Node.isForInStatement(stmt) ||
      Node.isWhileStatement(stmt)
    ) {
      currentIds = parseLoopStatement(ctx, stmt, currentIds, parentId);
      continue;
    }

    if (Node.isReturnStatement(stmt)) {
      const returnExpr = stmt.getExpression()?.getText() ?? "";
      const nodeId = nextId();
      ctx.nodes.push({
        id: nodeId,
        type: "return",
        label: "Return",
        sourceRange: getSourceRange(stmt),
        metadata: {},
        returnExpression: returnExpr,
        parentId,
      });
      addEdgesFromPrevious(ctx, currentIds, nodeId);
      currentIds = [];
      break;
    }

    const callNode = extractAwaitedCall(stmt);
    if (callNode) {
      if (callNode.getExpression().getText() === "Promise.all") {
        currentIds = parsePromiseAll(ctx, callNode, stmt, currentIds, parentId);
        continue;
      }

      if (callNode.getExpression().getText() === "sleep") {
        const args = callNode.getArguments();
        const duration = args[0]?.getText().replace(/['"]/g, "") ?? "unknown";
        const nodeId = nextId();
        ctx.nodes.push({
          id: nodeId,
          type: "delay",
          label: `Sleep ${duration}`,
          sourceRange: getSourceRange(stmt),
          metadata: {},
          duration,
          parentId,
        });
        addEdgesFromPrevious(ctx, currentIds, nodeId);
        currentIds = [nodeId];
        continue;
      }

      const fnName = getCallName(callNode);
      const stepMeta = lookupStepMetadata(ctx, fnName);
      const nodeId = nextId();
      const stepArgs = extractCallArguments(callNode, ctx, fnName);
      ctx.nodes.push({
        id: nodeId,
        type: "step",
        label: stepMeta.displayName ?? fnName,
        sourceRange: getSourceRange(stmt),
        metadata: stepMeta.metadata,
        functionName: fnName,
        parameters: lookupStepParams(ctx, fnName),
        arguments: stepArgs,
        parentId,
      });
      addEdgesFromPrevious(ctx, currentIds, nodeId);
      registerVariablesFromStatement(
        ctx,
        stmt,
        nodeId,
        stepMeta.displayName ?? fnName,
      );
      currentIds = [nodeId];
      continue;
    }

    if (Node.isBlock(stmt)) {
      currentIds = parseScopeBlock(ctx, stmt, currentIds, parentId);
      continue;
    }

    if (Node.isExpressionStatement(stmt)) {
      const expr = stmt.getExpression();
      const iifeCall = extractIIFECall(expr);
      if (iifeCall) {
        currentIds = parseScopeBlock(
          ctx,
          iifeCall.body,
          currentIds,
          parentId,
          iifeCall.stmt,
        );
        continue;
      }
    }

    if (Node.isVariableStatement(stmt)) {
      registerVariablesFromStatement(ctx, stmt);
    }
  }

  return currentIds;
}

function parseIfStatement(
  ctx: ParseContext,
  stmt: IfStatement,
  previousIds: string[],
  parentId?: string,
): string[] {
  const branches = collectIfBranches(stmt);
  const allExitIds: string[] = [];
  let hasElse = false;

  const ifBlockId = nextId();
  ctx.nodes.push({
    id: ifBlockId,
    type: "if-block",
    label: "",
    sourceRange: getSourceRange(stmt),
    metadata: {},
    parentId,
  });

  branches.forEach((branch, i) => {
    if (!branch.condition) hasElse = true;

    if (branch.statements.length === 0) {
      allExitIds.push(...previousIds);
      return;
    }

    const branchType = !branch.condition ? "else" : i === 0 ? "if" : "else if";
    const branchId = nextId();
    ctx.nodes.push({
      id: branchId,
      type: "branch",
      label: branch.condition ?? "Otherwise",
      sourceRange: getSourceRange(branch.sourceNode),
      metadata: { branchType },
      condition: branch.condition ?? undefined,
      parentId: ifBlockId,
    });

    addEdgesFromPrevious(ctx, previousIds, branchId);
    const branchExits = parseStatements(ctx, branch.statements, [], branchId);
    if (branchExits.length > 0) {
      allExitIds.push(branchId);
    }
  });

  if (!hasElse && allExitIds.length === 0) {
    allExitIds.push(...previousIds);
  }

  return allExitIds;
}

function parseLoopStatement(
  ctx: ParseContext,
  stmt: ForStatement | ForOfStatement | ForInStatement | WhileStatement,
  previousIds: string[],
  parentId?: string,
): string[] {
  const loopId = nextId();
  let loopVariable = "";
  let loopIterable = "";

  if (Node.isForOfStatement(stmt)) {
    const initText = stmt.getInitializer().getText();
    loopVariable = initText.replace(/^(const|let|var)\s+/, "");
    loopIterable = stmt.getExpression().getText();
  } else if (Node.isForInStatement(stmt)) {
    const initText = stmt.getInitializer().getText();
    loopVariable = initText.replace(/^(const|let|var)\s+/, "");
    loopIterable = stmt.getExpression().getText();
  }

  ctx.nodes.push({
    id: loopId,
    type: "loop-block",
    label: loopVariable ? `for ${loopVariable} of ${loopIterable}` : "loop",
    sourceRange: getSourceRange(stmt),
    metadata: {},
    loopVariable,
    loopIterable,
    parentId,
  });

  addEdgesFromPrevious(ctx, previousIds, loopId);

  const body = stmt.getStatement();
  if (Node.isBlock(body)) {
    const bodyStatements = body.getStatements();
    if (bodyStatements.length > 0) {
      parseStatements(ctx, bodyStatements, [], loopId);
    }
  }

  return [loopId];
}

function parsePromiseAll(
  ctx: ParseContext,
  callNode: CallExpression,
  stmt: Statement,
  previousIds: string[],
  parentId?: string,
): string[] {
  const blockId = nextId();
  const displayName = extractLeadingDisplayName(stmt);
  ctx.nodes.push({
    id: blockId,
    type: "parallel-block",
    label: displayName ?? "Parallel",
    sourceRange: getSourceRange(stmt),
    metadata: {},
    parentId,
  });

  addEdgesFromPrevious(ctx, previousIds, blockId);

  const args = callNode.getArguments();
  const arrayArg = args[0];
  const branchExitIds: string[] = [];

  if (arrayArg && Node.isArrayLiteralExpression(arrayArg)) {
    for (const element of arrayArg.getElements()) {
      const iifeCall = extractIIFECall(element);
      if (iifeCall) {
        const scopeId = nextId();
        ctx.nodes.push({
          id: scopeId,
          type: "scope-block",
          label: "Block",
          sourceRange: getSourceRange(element),
          metadata: {},
          parentId: blockId,
        });
        if (Node.isBlock(iifeCall.body)) {
          const stmts = iifeCall.body.getStatements();
          if (stmts.length > 0) {
            parseStatements(ctx, stmts, [], scopeId);
          }
        }
        branchExitIds.push(scopeId);
        continue;
      }

      let fnName = element.getText();
      let actualCall: CallExpression | undefined;
      if (Node.isCallExpression(element)) {
        fnName = getCallName(element);
        actualCall = element;
      } else if (Node.isAwaitExpression(element)) {
        const inner = element.getExpression();
        if (Node.isCallExpression(inner)) {
          fnName = getCallName(inner);
          actualCall = inner;
        }
      }

      const stepMeta = lookupStepMetadata(ctx, fnName);
      const stepArgs = actualCall
        ? extractCallArguments(actualCall, ctx, fnName)
        : undefined;
      const stepId = nextId();
      ctx.nodes.push({
        id: stepId,
        type: "step",
        label: stepMeta.displayName ?? fnName,
        sourceRange: getSourceRange(element),
        metadata: stepMeta.metadata,
        functionName: fnName,
        arguments: stepArgs,
        parentId: blockId,
      });

      branchExitIds.push(stepId);
    }
  }

  if (Node.isVariableStatement(stmt)) {
    const decls = stmt.getDeclarationList().getDeclarations();
    for (const decl of decls) {
      const nameNode = decl.getNameNode();
      if (Node.isArrayBindingPattern(nameNode)) {
        const elements = nameNode.getElements();
        elements.forEach((el, i) => {
          if (Node.isBindingElement(el)) {
            const varName = el.getName();
            const correspondingId = branchExitIds[i];
            const correspondingNode = correspondingId
              ? ctx.nodes.find((n) => n.id === correspondingId)
              : undefined;
            ctx.variables.set(varName, {
              sourceNodeId: correspondingId,
              sourceStepLabel: correspondingNode?.label,
            });
          }
        });
      }
    }
  }

  return [blockId];
}

function collectStepFunctions(
  sourceFiles: readonly SourceFile[],
): Map<string, FunctionDeclaration> {
  const map = new Map<string, FunctionDeclaration>();
  for (const sf of sourceFiles) {
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      map.set(name, fn);
    }
  }
  return map;
}

interface FoundWorkflow {
  fn: FunctionDeclaration;
  sourceFile: SourceFile;
  filePath: string;
}

function findAllWorkflowFunctions(
  sourceFiles: readonly SourceFile[],
): FoundWorkflow[] {
  const results: FoundWorkflow[] = [];
  for (const sf of sourceFiles) {
    for (const fn of sf.getFunctions()) {
      const body = fn.getBody();
      if (!body || !Node.isBlock(body)) continue;
      const statements = body.getStatements();
      if (statements.length === 0) continue;
      const first = statements[0];
      if (
        Node.isExpressionStatement(first) &&
        first.getText().includes('"use workflow"')
      ) {
        results.push({
          fn,
          sourceFile: sf,
          filePath: sf.getFilePath(),
        });
      }
    }
  }
  return results;
}

function buildWorkflowGraph(
  workflowFn: FunctionDeclaration,
  stepFunctions: Map<string, FunctionDeclaration>,
  opts?: { filePath?: string; projectFiles?: string[]; sourceCode?: string },
): WorkflowGraph {
  const jsdoc = extractJsDocMetadata(workflowFn);
  const sourceFile = workflowFn.getSourceFile();

  const ctx: ParseContext = {
    nodes: [],
    edges: [],
    sourceFile,
    stepFunctions,
    variables: new Map(),
    workflowFile: sourceFile.getFilePath(),
  };

  currentWorkflowFile = ctx.workflowFile;

  const triggerParams = extractParameterInfo(workflowFn, jsdoc.paramMetadata);
  const triggerLabel = jsdoc.displayName ?? workflowFn.getName() ?? "Trigger";

  const triggerId = nextId();
  ctx.nodes.push({
    id: triggerId,
    type: "trigger",
    label: triggerLabel,
    description: jsdoc.description,
    sourceRange: getSourceRange(workflowFn),
    metadata: jsdoc.tags,
    parameters: triggerParams,
  });

  for (const param of triggerParams) {
    ctx.variables.set(param.name, {
      sourceNodeId: triggerId,
      sourceStepLabel: triggerLabel,
    });
  }

  const body = workflowFn.getBody();
  if (body && Node.isBlock(body)) {
    parseStatements(ctx, body.getStatements(), [triggerId]);
  }

  return {
    name: workflowFn.getName() ?? "unnamed",
    displayName: jsdoc.displayName,
    description: jsdoc.description,
    trigger: { parameters: triggerParams },
    nodes: ctx.nodes,
    edges: ctx.edges,
    sourceCode: opts?.sourceCode ?? workflowFn.getSourceFile().getFullText(),
    filePath: opts?.filePath,
    projectFiles: opts?.projectFiles,
  };
}

function createMultiFileProject(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: 99, // ESNext
      module: 199, // ESNext
      moduleResolution: 100, // Bundler
      esModuleInterop: true,
      skipLibCheck: true,
    },
  });

  project.createSourceFile(
    "tsconfig.json",
    JSON.stringify({
      compilerOptions: {
        strict: true,
        moduleResolution: "bundler",
      },
    }),
  );

  for (const [filePath, content] of Object.entries(files)) {
    if (filePath.endsWith(".ts") || filePath.endsWith(".tsx")) {
      project.createSourceFile(filePath, content);
    }
  }

  project.resolveSourceFileDependencies();
  return project;
}

export function parseProject(
  files: Record<string, string>,
): ProjectParseResult {
  nodeCounter = 0;

  const project = createMultiFileProject(files);
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().endsWith("tsconfig.json"));
  const fileNames = Object.keys(files);

  const allSteps = collectStepFunctions(sourceFiles);
  const workflows = findAllWorkflowFunctions(sourceFiles);

  const discovered: DiscoveredWorkflow[] = [];
  const errors: ParseError[] = [];

  for (const wf of workflows) {
    try {
      nodeCounter = 0;
      const graph = buildWorkflowGraph(wf.fn, allSteps, {
        filePath: wf.filePath,
        projectFiles: fileNames,
        sourceCode: wf.sourceFile.getFullText(),
      });
      discovered.push({
        functionName: wf.fn.getName() ?? "unnamed",
        filePath: wf.filePath,
        graph,
      });
    } catch (err) {
      errors.push({
        file: wf.filePath,
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }

  return { workflows: discovered, errors };
}

export function parseWorkflowFromProject(
  files: Record<string, string>,
  workflowName: string,
): WorkflowGraph | null {
  nodeCounter = 0;

  const project = createMultiFileProject(files);
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().endsWith("tsconfig.json"));
  const fileNames = Object.keys(files);

  const allSteps = collectStepFunctions(sourceFiles);
  const workflows = findAllWorkflowFunctions(sourceFiles);

  const target = workflows.find((w) => w.fn.getName() === workflowName);
  if (!target) return null;

  return buildWorkflowGraph(target.fn, allSteps, {
    filePath: target.filePath,
    projectFiles: fileNames,
    sourceCode: target.sourceFile.getFullText(),
  });
}

export function parseWorkflow(source: string): WorkflowGraph {
  nodeCounter = 0;
  currentWorkflowFile = undefined;

  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: { strict: true },
  });
  const sourceFile = project.createSourceFile("workflow.ts", source);

  const workflowFn = findWorkflowFunction(sourceFile);
  if (!workflowFn) {
    throw new Error('No function with "use workflow" directive found');
  }

  const stepFunctions = collectStepFunctions([sourceFile]);

  return buildWorkflowGraph(workflowFn, stepFunctions, {
    sourceCode: source,
  });
}
