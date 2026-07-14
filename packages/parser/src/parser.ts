import {
  type ArrowFunction,
  type CallExpression,
  type ForInStatement,
  type ForOfStatement,
  type ForStatement,
  type FunctionDeclaration,
  type FunctionExpression,
  type IfStatement,
  type MethodDeclaration,
  Node,
  type ObjectLiteralExpression,
  Project,
  type SourceFile,
  type Statement,
  type VariableDeclaration,
  type VariableStatement,
  type WhileStatement,
} from "ts-morph";
import { extractJsDocMetadata, extractParameterInfo } from "./jsdoc.js";
import type {
  DiscoveredWorkflow,
  ParameterInfo,
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

/**
 * ts-morph's in-memory file system normalizes every path to an absolute one
 * (e.g. "src/a.ts" becomes "/src/a.ts"). Callers on the outside pass and
 * expect repo-relative paths, so strip the leading slash before letting any
 * path escape this module.
 */
function normalizePath(p: string): string {
  return p.startsWith("/") ? p.slice(1) : p;
}

function getSourceRange(node: Node): SourceRange {
  const sf = node.getSourceFile();
  const start = node.getStart();
  const end = node.getEnd();
  const startPos = sf.getLineAndColumnAtPos(start);
  const endPos = sf.getLineAndColumnAtPos(end);
  const filePath = normalizePath(sf.getFilePath());
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

type StepFunction =
  | FunctionDeclaration
  | FunctionExpression
  | ArrowFunction
  | MethodDeclaration;

interface StepDefinition {
  fn: StepFunction;
  metadataSource?: VariableStatement;
  batchMetadata?: Record<string, string>;
}

interface ParseContext {
  nodes: WorkflowNode[];
  edges: WorkflowEdge[];
  returnNodeIds: string[];
  sourceFile: SourceFile;
  stepFunctions: Map<string, StepDefinition>;
  variables: Map<string, VariableInfo>;
  workflowFile?: string;
  returnLabel?: string;
}

function lookupStepMetadata(
  ctx: ParseContext,
  fnName: string,
): { displayName?: string; metadata: Record<string, string> } {
  if (fnName === "skipBatchItem") {
    return {
      displayName: "Skip item",
      metadata: { icon: "circle-slash-2" },
    };
  }
  const fn = ctx.stepFunctions.get(fnName);
  if (!fn) return { metadata: {} };
  const jsdoc = extractJsDocMetadata(fn.metadataSource ?? fn.fn);
  return {
    displayName: jsdoc.displayName,
    metadata: { ...jsdoc.tags, ...fn.batchMetadata },
  };
}

function lookupStepParams(ctx: ParseContext, fnName: string) {
  const fn = ctx.stepFunctions.get(fnName);
  if (!fn) return undefined;
  const jsdoc = extractJsDocMetadata(fn.fn);
  const params = extractParameterInfo(fn.fn, jsdoc.paramMetadata);
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
    ? extractJsDocMetadata(fn.fn).paramMetadata
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
      const expression = stmt.getExpression();
      const returnedExpression =
        expression && Node.isAwaitExpression(expression)
          ? expression.getExpression()
          : expression;
      if (returnedExpression && Node.isCallExpression(returnedExpression)) {
        const fnName = getCallName(returnedExpression);
        const stepMeta = lookupStepMetadata(ctx, fnName);
        const stepNodeId = nextId();
        ctx.nodes.push({
          id: stepNodeId,
          type: "step",
          label: stepMeta.displayName ?? fnName,
          sourceRange: getSourceRange(returnedExpression),
          metadata: stepMeta.metadata,
          functionName: fnName,
          parameters: lookupStepParams(ctx, fnName),
          arguments: extractCallArguments(returnedExpression, ctx, fnName),
          parentId,
        });
        addEdgesFromPrevious(ctx, currentIds, stepNodeId);
        currentIds = [stepNodeId];
      }
      const returnExpr = expression?.getText() ?? "";
      const nodeId = nextId();
      ctx.nodes.push({
        id: nodeId,
        type: "return",
        label: ctx.returnLabel ?? "Return",
        sourceRange: getSourceRange(stmt),
        metadata: {},
        returnExpression: returnExpr,
        parentId,
      });
      ctx.returnNodeIds.push(nodeId);
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
): Map<string, StepDefinition> {
  const map = new Map<string, StepDefinition>();
  for (const sf of sourceFiles) {
    for (const fn of sf.getFunctions()) {
      const name = fn.getName();
      if (!name) continue;
      map.set(name, { fn });
    }
    for (const declaration of sf.getVariableDeclarations()) {
      const initializer = declaration.getInitializer();
      if (
        !initializer ||
        !Node.isCallExpression(initializer) ||
        initializer.getExpression().getText() !== "defineBatchStep"
      ) {
        continue;
      }
      const definition = initializer.getArguments()[0];
      if (!definition || !Node.isObjectLiteralExpression(definition)) continue;
      const runProperty = definition.getProperty("run");
      const run =
        runProperty && Node.isPropertyAssignment(runProperty)
          ? runProperty.getInitializer()
          : runProperty && Node.isMethodDeclaration(runProperty)
            ? runProperty
            : undefined;
      if (
        run &&
        (Node.isArrowFunction(run) ||
          Node.isFunctionExpression(run) ||
          Node.isMethodDeclaration(run))
      ) {
        const variableStatement = declaration.getVariableStatement();
        map.set(declaration.getName(), {
          fn: run,
          metadataSource: variableStatement,
          batchMetadata: readBatchStepMetadata({
            definition,
            exported: variableStatement?.isExported() ?? false,
          }),
        });
      }
    }
  }
  return map;
}

function readBatchStepMetadata(args: {
  definition: ObjectLiteralExpression;
  exported: boolean;
}): Record<string, string> {
  const batchProperty = args.definition.getProperty("batch");
  const batch =
    batchProperty && Node.isPropertyAssignment(batchProperty)
      ? batchProperty.getInitializer()
      : undefined;
  const policy =
    batch && Node.isObjectLiteralExpression(batch) ? batch : undefined;
  const read = (name: string): string | undefined => {
    const property = policy?.getProperty(name);
    return property && Node.isPropertyAssignment(property)
      ? property.getInitializer()?.getText()
      : undefined;
  };
  return {
    batchStep: "true",
    batchStepExported: String(args.exported),
    ...(read("maxItems") ? { "batch:maxItems": read("maxItems") ?? "" } : {}),
    ...(read("maxWaitMs")
      ? { "batch:maxWaitMs": read("maxWaitMs") ?? "" }
      : {}),
    ...(read("maxBytes") ? { "batch:maxBytes": read("maxBytes") ?? "" } : {}),
  };
}

interface FoundRegularWorkflow {
  kind: "regular";
  fn: FunctionDeclaration;
  sourceFile: SourceFile;
  filePath: string;
}

interface FoundBatchWorkflow {
  kind: "batch";
  declaration: VariableDeclaration;
  sourceFile: SourceFile;
  filePath: string;
  name: string;
}

type FoundWorkflow = FoundRegularWorkflow | FoundBatchWorkflow;

/** Matches app convention: `src/<kebab>.ts` for a workflow identifier. */
export function defaultWorkflowSourcePath(workflowName: string): string {
  const fileSafe = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
  return `src/${fileSafe}.ts`;
}

function normalizeProjectPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

function projectPathsEqual(a: string, b: string): boolean {
  return normalizeProjectPath(a) === normalizeProjectPath(b);
}

/**
 * When the workflow function was renamed in source but the route still uses the
 * original identifier, resolve the graph from the expected workflow file (single
 * `"use workflow"` in that file).
 */
function resolveWorkflowByFilePathHint(
  workflows: FoundWorkflow[],
  workflowName: string,
  preferredFilePath: string | undefined,
  files: Record<string, string>,
): FoundWorkflow | undefined {
  const hintsInOrder: string[] = [];
  if (preferredFilePath) hintsInOrder.push(preferredFilePath);
  hintsInOrder.push(defaultWorkflowSourcePath(workflowName));

  const uniqueHints = [...new Set(hintsInOrder.map(normalizeProjectPath))];

  for (const hint of uniqueHints) {
    const matches = workflows.filter((w) =>
      projectPathsEqual(w.filePath, hint),
    );
    if (matches.length === 1) return matches[0];

    const fileKey = Object.keys(files).find((k) => projectPathsEqual(k, hint));
    if (fileKey) {
      const keyMatches = workflows.filter((w) =>
        projectPathsEqual(w.filePath, fileKey),
      );
      if (keyMatches.length === 1) return keyMatches[0];
    }
  }

  return undefined;
}

function findAllWorkflows(sourceFiles: readonly SourceFile[]): FoundWorkflow[] {
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
          kind: "regular",
          fn,
          sourceFile: sf,
          filePath: normalizePath(sf.getFilePath()),
        });
      }
    }

    for (const statement of sf.getVariableStatements()) {
      if (!statement.isExported()) continue;

      for (const declaration of statement.getDeclarations()) {
        const nameNode = declaration.getNameNode();
        const initializer = declaration.getInitializer();
        if (
          !Node.isIdentifier(nameNode) ||
          !initializer ||
          !Node.isCallExpression(initializer)
        ) {
          continue;
        }

        const helper = initializer.getExpression();
        if (
          !Node.isIdentifier(helper) ||
          helper.getText() !== "defineBatchWorkflow"
        ) {
          continue;
        }

        results.push({
          kind: "batch",
          declaration,
          sourceFile: sf,
          filePath: normalizePath(sf.getFilePath()),
          name: nameNode.getText(),
        });
      }
    }
  }
  return results;
}

function buildWorkflowGraph(
  workflowFn: FunctionDeclaration,
  stepFunctions: Map<string, StepDefinition>,
  opts?: { filePath?: string; projectFiles?: string[]; sourceCode?: string },
): WorkflowGraph {
  const jsdoc = extractJsDocMetadata(workflowFn);
  const sourceFile = workflowFn.getSourceFile();

  const ctx: ParseContext = {
    nodes: [],
    edges: [],
    returnNodeIds: [],
    sourceFile,
    stepFunctions,
    variables: new Map(),
    workflowFile: normalizePath(sourceFile.getFilePath()),
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
    kind: "regular",
    displayName: jsdoc.displayName,
    description: jsdoc.description,
    trigger: { parameters: triggerParams },
    nodes: ctx.nodes,
    edges: ctx.edges,
    sourceCode: opts?.sourceCode ?? workflowFn.getSourceFile().getFullText(),
    filePath: opts?.filePath ? normalizePath(opts.filePath) : undefined,
    projectFiles: opts?.projectFiles?.map(normalizePath),
  };
}

type BatchCallback = ArrowFunction | FunctionExpression;

interface BatchWorkflowDefinition {
  source: BatchCallback;
  process: BatchCallback;
  sink?: Node;
}

function requireBatchProperty(opts: {
  objectLiteral: Node;
  propertyName: "source" | "process";
  workflowName: string;
}): Node {
  if (!Node.isObjectLiteralExpression(opts.objectLiteral)) {
    throw new Error(
      `Batch workflow '${opts.workflowName}' must pass an object literal to defineBatchWorkflow`,
    );
  }

  const property = opts.objectLiteral.getProperty(opts.propertyName);
  if (!property) {
    throw new Error(
      `Batch workflow '${opts.workflowName}' is missing required '${opts.propertyName}'`,
    );
  }
  if (!Node.isPropertyAssignment(property)) {
    throw new Error(
      `Batch workflow '${opts.workflowName}' must define '${opts.propertyName}' as a property`,
    );
  }

  const initializer = property.getInitializer();
  if (!initializer) {
    throw new Error(
      `Batch workflow '${opts.workflowName}' has an invalid '${opts.propertyName}'`,
    );
  }
  return initializer;
}

function getBatchCallback(opts: {
  expression: Node;
  propertyName: "source" | "process";
  workflowName: string;
}): BatchCallback {
  if (
    !Node.isArrowFunction(opts.expression) &&
    !Node.isFunctionExpression(opts.expression)
  ) {
    throw new Error(
      `Batch workflow '${opts.workflowName}' '${opts.propertyName}' must be an inline function`,
    );
  }
  return opts.expression;
}

function parseBatchDefinition(
  workflow: FoundBatchWorkflow,
): BatchWorkflowDefinition {
  const initializer = workflow.declaration.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer)) {
    throw new Error(
      `Batch workflow '${workflow.name}' must be initialized with defineBatchWorkflow`,
    );
  }

  const args = initializer.getArguments();
  const config = args[0];
  if (!config || !Node.isObjectLiteralExpression(config)) {
    throw new Error(
      `Batch workflow '${workflow.name}' must pass an object literal to defineBatchWorkflow`,
    );
  }

  const sourceExpression = requireBatchProperty({
    objectLiteral: config,
    propertyName: "source",
    workflowName: workflow.name,
  });
  const processExpression = requireBatchProperty({
    objectLiteral: config,
    propertyName: "process",
    workflowName: workflow.name,
  });
  const source = getBatchCallback({
    expression: sourceExpression,
    propertyName: "source",
    workflowName: workflow.name,
  });
  const process = getBatchCallback({
    expression: processExpression,
    propertyName: "process",
    workflowName: workflow.name,
  });

  if (!Node.isBlock(process.getBody())) {
    throw new Error(
      `Batch workflow '${workflow.name}' 'process' must have a block body`,
    );
  }

  const sinkProperty = config.getProperty("sink");
  if (sinkProperty && !Node.isPropertyAssignment(sinkProperty)) {
    throw new Error(
      `Batch workflow '${workflow.name}' must define 'sink' as a property`,
    );
  }

  return {
    source,
    process,
    sink: sinkProperty?.getInitializer(),
  };
}

function extractCallbackParameters(callback: BatchCallback): ParameterInfo[] {
  const extracted = extractParameterInfo(callback, new Map());
  const parameter = callback.getParameters()[0];
  const nameNode = parameter?.getNameNode();
  if (!nameNode || !Node.isObjectBindingPattern(nameNode)) return extracted;

  if (parameter?.getTypeNode()) return extracted;

  return nameNode.getElements().map((element) => ({
    name: element.getName(),
    type: "unknown",
    optional: false,
    defaultValue: element.getInitializer()?.getText(),
  }));
}

function registerCallbackVariables(opts: {
  ctx: ParseContext;
  callback: BatchCallback;
  sourceNodeId: string;
  sourceLabel: string;
}): void {
  for (const parameter of extractCallbackParameters(opts.callback)) {
    opts.ctx.variables.set(parameter.name, {
      sourceNodeId: opts.sourceNodeId,
      sourceStepLabel: opts.sourceLabel,
    });
  }
}

function buildBatchWorkflowGraph(
  workflow: FoundBatchWorkflow,
  stepFunctions: Map<string, StepDefinition>,
  opts?: { filePath?: string; projectFiles?: string[]; sourceCode?: string },
): WorkflowGraph {
  const definition = parseBatchDefinition(workflow);
  const sourceFile = workflow.sourceFile;
  const ctx: ParseContext = {
    nodes: [],
    edges: [],
    returnNodeIds: [],
    sourceFile,
    stepFunctions,
    variables: new Map(),
    workflowFile: normalizePath(sourceFile.getFilePath()),
    returnLabel: "Item result",
  };
  currentWorkflowFile = ctx.workflowFile;

  const sourceParameters = extractCallbackParameters(definition.source);
  const sourceId = nextId();
  ctx.nodes.push({
    id: sourceId,
    type: "source",
    label: "Source",
    sourceRange: getSourceRange(definition.source),
    metadata: {},
    parameters: sourceParameters,
  });
  registerCallbackVariables({
    ctx,
    callback: definition.source,
    sourceNodeId: sourceId,
    sourceLabel: "Source",
  });
  registerCallbackVariables({
    ctx,
    callback: definition.process,
    sourceNodeId: sourceId,
    sourceLabel: "Source",
  });

  const processBody = definition.process.getBody();
  const processExits = Node.isBlock(processBody)
    ? parseStatements(ctx, processBody.getStatements(), [sourceId])
    : [sourceId];
  const unexportedBatchStep = ctx.nodes.find(
    (node) =>
      node.metadata.batchStep === "true" &&
      node.metadata.batchStepExported !== "true",
  );
  if (unexportedBatchStep?.functionName) {
    throw new Error(
      `Batch step '${unexportedBatchStep.functionName}' must be exported`,
    );
  }

  if (definition.sink) {
    const sinkId = nextId();
    ctx.nodes.push({
      id: sinkId,
      type: "sink",
      label: "Sink",
      sourceRange: getSourceRange(definition.sink),
      metadata: {},
    });
    const previousIds =
      processExits.length > 0
        ? processExits
        : ctx.returnNodeIds.length > 0
          ? ctx.returnNodeIds
          : [sourceId];
    addEdgesFromPrevious(ctx, previousIds, sinkId);
  }

  return {
    name: workflow.name,
    kind: "batch",
    trigger: { parameters: sourceParameters },
    nodes: ctx.nodes,
    edges: ctx.edges,
    sourceCode: opts?.sourceCode ?? sourceFile.getFullText(),
    filePath: opts?.filePath ? normalizePath(opts.filePath) : undefined,
    projectFiles: opts?.projectFiles?.map(normalizePath),
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

  // Callers occasionally pass both "src/a.ts" and "/src/a.ts" (e.g. after
  // legacy drafts). ts-morph normalizes these to the same absolute path and
  // throws on the second createSourceFile call, so dedupe by normalized key
  // and use overwrite: true for safety.
  const seen = new Set<string>();
  for (const [filePath, content] of Object.entries(files)) {
    if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue;
    const key = normalizePath(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    project.createSourceFile(key, content, { overwrite: true });
  }

  project.resolveSourceFileDependencies();
  return project;
}

function getWorkflowName(workflow: FoundWorkflow): string {
  return workflow.kind === "regular"
    ? (workflow.fn.getName() ?? "unnamed")
    : workflow.name;
}

function buildFoundWorkflowGraph(opts: {
  workflow: FoundWorkflow;
  stepFunctions: Map<string, StepDefinition>;
  fileNames: string[];
}): WorkflowGraph {
  const graphOptions = {
    filePath: opts.workflow.filePath,
    projectFiles: opts.fileNames,
    sourceCode: opts.workflow.sourceFile.getFullText(),
  };
  return opts.workflow.kind === "regular"
    ? buildWorkflowGraph(opts.workflow.fn, opts.stepFunctions, graphOptions)
    : buildBatchWorkflowGraph(opts.workflow, opts.stepFunctions, graphOptions);
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
  const workflows = findAllWorkflows(sourceFiles);

  const discovered: DiscoveredWorkflow[] = [];
  const errors: ParseError[] = [];

  for (const wf of workflows) {
    try {
      nodeCounter = 0;
      const graph = buildFoundWorkflowGraph({
        workflow: wf,
        stepFunctions: allSteps,
        fileNames,
      });
      discovered.push({
        functionName: getWorkflowName(wf),
        kind: wf.kind,
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
  options?: { preferredFilePath?: string },
): WorkflowGraph | null {
  nodeCounter = 0;

  const project = createMultiFileProject(files);
  const sourceFiles = project
    .getSourceFiles()
    .filter((sf) => !sf.getFilePath().endsWith("tsconfig.json"));
  const fileNames = Object.keys(files);

  const allSteps = collectStepFunctions(sourceFiles);
  const workflows = findAllWorkflows(sourceFiles);

  const target =
    workflows.find((workflow) => getWorkflowName(workflow) === workflowName) ??
    resolveWorkflowByFilePathHint(
      workflows,
      workflowName,
      options?.preferredFilePath,
      files,
    );
  if (!target) return null;

  return buildFoundWorkflowGraph({
    workflow: target,
    stepFunctions: allSteps,
    fileNames,
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
  if (workflowFn) {
    const stepFunctions = collectStepFunctions([sourceFile]);
    return buildWorkflowGraph(workflowFn, stepFunctions, {
      sourceCode: source,
    });
  }

  const batchWorkflow = findAllWorkflows([sourceFile]).find(
    (workflow): workflow is FoundBatchWorkflow => workflow.kind === "batch",
  );
  if (!batchWorkflow) {
    throw new Error('No function with "use workflow" directive found');
  }

  const stepFunctions = collectStepFunctions([sourceFile]);
  return buildBatchWorkflowGraph(batchWorkflow, stepFunctions, {
    sourceCode: source,
  });
}
