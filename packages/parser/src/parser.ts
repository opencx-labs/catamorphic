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
  SyntaxKind,
  type VariableDeclaration,
  type VariableStatement,
  type WhileStatement,
} from "ts-morph";
import { extractJsDocMetadata, extractParameterInfo } from "./jsdoc.js";
import {
  jsonSchemaFromBoundaryReturn,
  jsonSchemaFromType,
  WORKFLOW_STUB_DTS,
} from "./schema-extract.js";
import type {
  AppApiEntry,
  AppApiSurface,
  BatchExecutionDescriptor,
  BoundaryExecutionDescriptor,
  BoundaryRateLimitDescriptor,
  DeclaredSecret,
  DiscoveredWorkflow,
  JsonConstant,
  ParameterInfo,
  ParseError,
  PhysicalBatchStepPolicyDescriptor,
  ProjectParseResult,
  SourceRange,
  StepArgument,
  StepArgumentSource,
  WorkflowCallTargetDescriptor,
  WorkflowEdge,
  WorkflowGraph,
  WorkflowNode,
  WorkflowTriggerBinding,
} from "./types.js";
import {
  APP_API_SOURCE_PATH,
  APP_SOURCE_ROOT,
  CONTRACTS_SOURCE_ROOT,
  WORKFLOW_SOURCE_ROOT,
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
  batch?: {
    exported: boolean;
    exportName: string;
    modulePath: string;
    policy: Partial<PhysicalBatchStepPolicyDescriptor>;
  };
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
  statementMode?: "boundary" | "batch-process";
  workflowStack?: Set<string>;
}

type DurableCallback = ArrowFunction | FunctionExpression | MethodDeclaration;

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

function validateStepCall(ctx: ParseContext, fnName: string): void {
  const step = ctx.stepFunctions.get(fnName);
  if (step?.batch && ctx.statementMode !== "batch-process") {
    throw new Error(
      `Batch step '${fnName}' may only be called inside defineBatch.process`,
    );
  }
}

function validateBatchStepCallLocations(opts: {
  root: Node;
  stepFunctions: Map<string, StepDefinition>;
  processCallbacks: BatchCallback[];
}): void {
  const processRanges = opts.processCallbacks.map((callback) => ({
    start: callback.getStart(),
    end: callback.getEnd(),
  }));
  for (const call of opts.root.getDescendantsOfKind(
    SyntaxKind.CallExpression,
  )) {
    const fnName = getCallName(call);
    if (!opts.stepFunctions.get(fnName)?.batch) continue;
    const inProcess = processRanges.some(
      (range) => call.getStart() >= range.start && call.getEnd() <= range.end,
    );
    if (!inProcess) {
      throw new Error(
        `Batch step '${fnName}' may only be called inside defineBatch.process`,
      );
    }
  }
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

function extractLeadingJsDocMetadata(node: Node): {
  displayName?: string;
  description?: string;
  icon?: string;
  tags: Record<string, string>;
  paramMetadata: Map<string, { displayName?: string; description?: string }>;
} {
  const result: {
    displayName?: string;
    description?: string;
    icon?: string;
    tags: Record<string, string>;
    paramMetadata: Map<string, { displayName?: string; description?: string }>;
  } = { tags: {}, paramMetadata: new Map() };
  const text = node
    .getLeadingCommentRanges()
    .map((range) => range.getText())
    .reverse()
    .find((comment) => comment.startsWith("/**"));
  if (!text) return result;

  const readTag = (tagName: string): string | undefined =>
    text.match(new RegExp(`@${tagName}\\s+([^\\n*]+)`, "i"))?.[1]?.trim();
  result.displayName = readTag("displayname");
  result.description = readTag("description");
  result.icon = readTag("icon");
  if (result.displayName) result.tags.displayname = result.displayName;
  if (result.description) result.tags.description = result.description;
  if (result.icon) result.tags.icon = result.icon;

  const paramPattern = /@param\s+(\w+)\s*-?\s*([^\n*]*)/gi;
  for (const match of text.matchAll(paramPattern)) {
    const name = match[1];
    if (!name) continue;
    const content = match[2]?.trim() ?? "";
    const displayName = content.match(/@displayname\s+([^|@]+)/i)?.[1]?.trim();
    const description = content.match(/@description\s+([^|@]+)/i)?.[1]?.trim();
    result.paramMetadata.set(name, {
      displayName,
      description:
        description ?? (!displayName && content ? content : undefined),
    });
    result.tags[`param:${name}`] = content;
  }
  return result;
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

function extractCallArgumentsAt(
  callNode: CallExpression,
  ctx: ParseContext,
  fnName: string,
  argumentIndex: number,
): StepArgument[] | undefined {
  const args = callNode.getArguments();
  const objectArgument = args[argumentIndex];
  if (!objectArgument || !Node.isObjectLiteralExpression(objectArgument)) {
    return undefined;
  }

  const fn = ctx.stepFunctions.get(fnName);
  const paramMeta = fn
    ? extractJsDocMetadata(fn.fn).paramMetadata
    : new Map<string, { displayName?: string; description?: string }>();

  const result: StepArgument[] = [];

  for (const prop of objectArgument.getProperties()) {
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

function extractCallArguments(
  callNode: CallExpression,
  ctx: ParseContext,
  fnName: string,
): StepArgument[] | undefined {
  return extractCallArgumentsAt(callNode, ctx, fnName, 0);
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
    } else {
      branches.push({
        condition: undefined,
        statements: [elseStatement],
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
      if (
        ctx.statementMode === "boundary" &&
        returnedExpression &&
        parseDurableTransitionExpression(
          ctx,
          returnedExpression,
          currentIds,
          parentId,
        )
      ) {
        currentIds = [];
        break;
      }
      if (returnedExpression && Node.isCallExpression(returnedExpression)) {
        const fnName = getCallName(returnedExpression);
        validateStepCall(ctx, fnName);
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
      if (ctx.statementMode === "boundary") {
        currentIds = [];
        break;
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
      validateStepCall(ctx, fnName);
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

function unwrapExpression(expression: Node): Node {
  if (Node.isParenthesizedExpression(expression)) {
    return unwrapExpression(expression.getExpression());
  }
  if (Node.isAwaitExpression(expression)) {
    return unwrapExpression(expression.getExpression());
  }
  return expression;
}

function unquoteExpression(value: string): string | undefined {
  const trimmed = value.trim();
  const quoted =
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'")) ||
    (trimmed.startsWith("`") && trimmed.endsWith("`"));
  const unquoted = quoted ? trimmed.slice(1, -1) : trimmed;
  return unquoted.length > 0 ? unquoted : undefined;
}

function readObjectPropertyText(
  object: ObjectLiteralExpression | undefined,
  propertyName: string,
): string | undefined {
  const property = object?.getProperty(propertyName);
  return property && Node.isPropertyAssignment(property)
    ? property.getInitializer()?.getText()
    : undefined;
}

function durableTransitionKind(
  expression: Node,
): "pause" | "callWorkflow" | "conditional" | undefined {
  const unwrapped = unwrapExpression(expression);
  if (Node.isConditionalExpression(unwrapped)) return "conditional";
  if (!Node.isCallExpression(unwrapped)) return undefined;
  const callName = getCallName(unwrapped);
  return callName === "pause" || callName === "callWorkflow"
    ? callName
    : undefined;
}

function workflowCallLabel(ctx: ParseContext, workflowName: string): string {
  for (const sourceFile of ctx.sourceFile.getProject().getSourceFiles()) {
    const declaration = sourceFile
      .getVariableDeclarations()
      .find((candidate) => candidate.getName() === workflowName);
    const statement = declaration?.getVariableStatement();
    if (statement) {
      const displayName = extractJsDocMetadata(statement).displayName;
      if (displayName) return `Call ${displayName}`;
    }
    const fn = sourceFile
      .getFunctions()
      .find((candidate) => candidate.getName() === workflowName);
    if (fn) {
      const displayName = extractJsDocMetadata(fn).displayName;
      if (displayName) return `Call ${displayName}`;
    }
  }
  const readable = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/[-_]+/g, " ")
    .replace(/^./, (character) => character.toUpperCase());
  return `Call ${readable}`;
}

function findWorkflowCallTarget(
  ctx: ParseContext,
  workflowName: string,
): FoundDefinedWorkflow | undefined {
  for (const sourceFile of ctx.sourceFile.getProject().getSourceFiles()) {
    for (const statement of sourceFile.getVariableStatements()) {
      if (!statement.isExported()) continue;
      for (const declaration of statement.getDeclarations()) {
        const initializer = declaration.getInitializer();
        if (
          declaration.getName() !== workflowName ||
          !initializer ||
          !Node.isCallExpression(initializer) ||
          getCallName(initializer) !== "defineWorkflow"
        ) {
          continue;
        }
        return {
          type: "defined",
          declaration,
          sourceFile,
          filePath: normalizePath(sourceFile.getFilePath()),
          name: workflowName,
        };
      }
    }
  }
  return undefined;
}

function workflowTargetMetadataSource(
  workflow: FoundDefinedWorkflow,
): VariableStatement | undefined {
  return workflow.declaration.getVariableStatement();
}

function workflowTargetName(workflow: FoundDefinedWorkflow): string {
  return workflow.name;
}

function definedWorkflowCancellation(
  definition: DurableWorkflowDefinition,
): boolean {
  const controlsProperty = definition.config.getProperty("controls");
  const controlsObject =
    controlsProperty && Node.isPropertyAssignment(controlsProperty)
      ? controlsProperty.getInitializer()
      : undefined;
  return (
    controlsObject !== undefined &&
    Node.isObjectLiteralExpression(controlsObject) &&
    readObjectPropertyText(controlsObject, "cancel") === "true"
  );
}

function parseWorkflowCallTarget(opts: {
  ctx: ParseContext;
  workflow: FoundDefinedWorkflow;
  parentId: string;
}): WorkflowCallTargetDescriptor {
  const exportName = workflowTargetName(opts.workflow);
  const exportTarget = {
    modulePath: opts.workflow.filePath,
    exportName,
  };
  const definition = parseDurableDefinition(opts.workflow);
  const parsed = parseWorkflowSteps({
    ctx: opts.ctx,
    definitions: definition.steps,
    parentId: opts.parentId,
    previousIds: [],
  });
  const capabilities = {
    batchProcessing: definition.steps.some((step) => step.type === "batch"),
    cancellation: definedWorkflowCancellation(definition),
  };
  return {
    exportTarget,
    capabilities,
    execution: { exportTarget, steps: parsed.descriptors },
  };
}

function parseDurableTransitionExpression(
  ctx: ParseContext,
  expression: Node,
  previousIds: string[],
  parentId?: string,
): boolean {
  const unwrapped = unwrapExpression(expression);
  const kind = durableTransitionKind(unwrapped);
  if (!kind) return false;

  if (kind === "conditional" && Node.isConditionalExpression(unwrapped)) {
    const ifBlockId = nextId();
    ctx.nodes.push({
      id: ifBlockId,
      type: "if-block",
      label: "",
      sourceRange: getSourceRange(unwrapped),
      metadata: {},
      parentId,
    });

    const arms = [
      {
        condition: unwrapped.getCondition().getText(),
        expression: unwrapped.getWhenTrue(),
        branchType: "if",
      },
      {
        condition: undefined,
        expression: unwrapped.getWhenFalse(),
        branchType: "else",
      },
    ] as const;
    for (const arm of arms) {
      const branchId = nextId();
      ctx.nodes.push({
        id: branchId,
        type: "branch",
        label: arm.condition ?? "Otherwise",
        condition: arm.condition,
        sourceRange: getSourceRange(arm.expression),
        metadata: { branchType: arm.branchType },
        parentId: ifBlockId,
      });
      addEdgesFromPrevious(ctx, previousIds, branchId);
      parseDurableTransitionExpression(ctx, arm.expression, [], branchId);
    }
    return true;
  }

  if (!Node.isCallExpression(unwrapped)) return false;
  if (kind === "pause") {
    const options = unwrapped.getArguments()[0];
    const object =
      options && Node.isObjectLiteralExpression(options) ? options : undefined;
    const timeout = readObjectPropertyText(object, "timeout");
    const stateExpression = readObjectPropertyText(object, "state");
    const signalExpression = readObjectPropertyText(object, "signal");
    const signalName = signalExpression
      ? unquoteExpression(signalExpression)
      : undefined;
    const nodeId = nextId();
    ctx.nodes.push({
      id: nodeId,
      type: "pause",
      label: signalName
        ? `Wait for '${signalName}'`
        : timeout
          ? "Pause with timeout"
          : "Pause until resumed",
      sourceRange: getSourceRange(unwrapped),
      metadata: signalName ? { signal: signalName } : {},
      functionName: "pause",
      arguments: extractCallArgumentsAt(unwrapped, ctx, "pause", 0),
      duration: timeout,
      stateExpression,
      parentId,
    });
    addEdgesFromPrevious(ctx, previousIds, nodeId);
    return true;
  }

  const target = unwrapped.getArguments()[0]?.getText() ?? "workflow";
  const options = unwrapped.getArguments()[1];
  const object =
    options && Node.isObjectLiteralExpression(options) ? options : undefined;
  const workflowInputExpression = readObjectPropertyText(object, "input");
  const childWorkflow = findWorkflowCallTarget(ctx, target);
  const childMetadataSource = childWorkflow
    ? workflowTargetMetadataSource(childWorkflow)
    : undefined;
  const childJsDoc = childMetadataSource
    ? extractJsDocMetadata(childMetadataSource)
    : undefined;
  const nodeId = nextId();
  const stack = ctx.workflowStack ?? new Set<string>();
  const childKey = childWorkflow
    ? `${childWorkflow.filePath}#${workflowTargetName(childWorkflow)}`
    : undefined;
  const isRecursive = childKey !== undefined && stack.has(childKey);
  const callNode: WorkflowNode = {
    id: nodeId,
    type: "call-workflow",
    label: workflowCallLabel(ctx, target),
    sourceRange: getSourceRange(unwrapped),
    description: childJsDoc?.description,
    metadata: {
      ...(childJsDoc?.tags ?? {}),
      workflowScope: "true",
      ...(childWorkflow
        ? {
            childModulePath: childWorkflow.filePath,
            childExportName: workflowTargetName(childWorkflow),
          }
        : {}),
      ...(isRecursive ? { recursiveWorkflow: "true" } : {}),
    },
    functionName: "callWorkflow",
    arguments: extractCallArgumentsAt(unwrapped, ctx, "callWorkflow", 1),
    workflowName: target,
    workflowInputExpression,
    parentId,
  };
  ctx.nodes.push(callNode);
  addEdgesFromPrevious(ctx, previousIds, nodeId);

  if (childWorkflow && childKey && !isRecursive) {
    stack.add(childKey);
    try {
      callNode.workflowTarget = parseWorkflowCallTarget({
        ctx,
        workflow: childWorkflow,
        parentId: nodeId,
      });
    } finally {
      stack.delete(childKey);
    }
  }

  return true;
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
      validateStepCall(ctx, fnName);
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
          batch: {
            exported: variableStatement?.isExported() ?? false,
            exportName: declaration.getName(),
            modulePath: normalizePath(sf.getFilePath()),
            policy: readBatchStepPolicy(definition),
          },
        });
      }
    }
  }
  return map;
}

function readBatchStepPolicy(
  definition: ObjectLiteralExpression,
): Partial<PhysicalBatchStepPolicyDescriptor> {
  const batchProperty = definition.getProperty("batch");
  const batch =
    batchProperty && Node.isPropertyAssignment(batchProperty)
      ? batchProperty.getInitializer()
      : undefined;
  const policy =
    batch && Node.isObjectLiteralExpression(batch) ? batch : undefined;
  const partitionByProperty = definition.getProperty("partitionBy");
  const partitionBy =
    partitionByProperty && Node.isPropertyAssignment(partitionByProperty)
      ? partitionByProperty.getInitializer()?.getText()
      : undefined;
  const read = (name: string): string | undefined =>
    readObjectPropertyText(policy, name);
  return {
    ...(read("maxItems") ? { maxItemsExpression: read("maxItems") ?? "" } : {}),
    ...(read("maxWaitMs")
      ? { maxWaitMsExpression: read("maxWaitMs") ?? "" }
      : {}),
    ...(read("maxBytes") ? { maxBytesExpression: read("maxBytes") ?? "" } : {}),
    ...(read("rateLimits")
      ? { rateLimitsExpression: read("rateLimits") ?? "" }
      : {}),
    ...(partitionBy ? { partitionByExpression: partitionBy } : {}),
  };
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
    ...(read("rateLimits")
      ? { "batch:rateLimits": read("rateLimits") ?? "" }
      : {}),
  };
}

interface FoundDefinedWorkflow {
  type: "defined";
  declaration: VariableDeclaration;
  sourceFile: SourceFile;
  filePath: string;
  name: string;
}

interface FoundObsoleteBatchWorkflow {
  type: "obsolete-batch";
  sourceFile: SourceFile;
  filePath: string;
  name: string;
}

type FoundWorkflow = FoundDefinedWorkflow | FoundObsoleteBatchWorkflow;

/** Matches project convention: `workflows/src/<kebab>.ts` for a workflow identifier. */
export function defaultWorkflowSourcePath(workflowName: string): string {
  const fileSafe = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
  return `${WORKFLOW_SOURCE_ROOT}/src/${fileSafe}.ts`;
}

function normalizeProjectPath(p: string): string {
  return p.replace(/\\/g, "/").replace(/^\/+/, "");
}

/**
 * Frontend app sources are excluded from workflow parsing. Step functions are
 * collected into one flat name-keyed map, so an app-side function sharing a
 * name with a step would otherwise override it in both the rendered graph and
 * the execution transform.
 */
function isAppSourcePath(filePath: string): boolean {
  return normalizeProjectPath(filePath).startsWith(`${APP_SOURCE_ROOT}/`);
}

function projectPathsEqual(a: string, b: string): boolean {
  return normalizeProjectPath(a) === normalizeProjectPath(b);
}

/**
 * When the workflow was renamed in source but the route still uses the
 * original identifier, resolve the graph from the expected workflow file
 * (single workflow definition in that file).
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
        if (!Node.isIdentifier(helper)) {
          continue;
        }

        const helperName = helper.getText();
        if (helperName === "defineBatchWorkflow") {
          results.push({
            type: "obsolete-batch",
            sourceFile: sf,
            filePath: normalizePath(sf.getFilePath()),
            name: nameNode.getText(),
          });
          continue;
        }
        if (helperName !== "defineWorkflow") {
          continue;
        }

        results.push({
          type: "defined",
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

type BatchCallback = ArrowFunction | FunctionExpression | MethodDeclaration;

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

interface DurableBoundaryDefinition {
  type: "boundary";
  topLevelIndex: number;
  call: CallExpression;
  config: ObjectLiteralExpression;
  run: DurableCallback;
  jsdoc: ReturnType<typeof extractLeadingJsDocMetadata>;
}

interface BatchScopeDefinition {
  type: "batch";
  topLevelIndex: number;
  call: CallExpression;
  config: ObjectLiteralExpression;
  source: BatchCallback;
  process: BatchCallback;
  sink?: Node;
  jsdoc: ReturnType<typeof extractLeadingJsDocMetadata>;
}

type WorkflowStepDefinition = DurableBoundaryDefinition | BatchScopeDefinition;

interface DurableWorkflowDefinition {
  builder: ArrowFunction | FunctionExpression;
  config: ObjectLiteralExpression;
  steps: WorkflowStepDefinition[];
}

function requireReturnedObjectLiteral(opts: {
  callback: ArrowFunction | FunctionExpression;
  workflowName: string;
}): ObjectLiteralExpression {
  const body = opts.callback.getBody();
  if (!Node.isBlock(body)) {
    const expression = unwrapExpression(body);
    if (Node.isObjectLiteralExpression(expression)) return expression;
  } else {
    const returnStatement = body
      .getStatements()
      .find((statement) => Node.isReturnStatement(statement));
    const expression =
      returnStatement && Node.isReturnStatement(returnStatement)
        ? returnStatement.getExpression()
        : undefined;
    const unwrapped = expression ? unwrapExpression(expression) : undefined;
    if (unwrapped && Node.isObjectLiteralExpression(unwrapped))
      return unwrapped;
  }
  throw new Error(
    `Workflow '${opts.workflowName}' builder must return an object literal`,
  );
}

function requireDurableRun(opts: {
  config: ObjectLiteralExpression;
  workflowName: string;
  boundaryIndex: number;
}): DurableCallback {
  const property = opts.config.getProperty("run");
  const run =
    property && Node.isPropertyAssignment(property)
      ? property.getInitializer()
      : property && Node.isMethodDeclaration(property)
        ? property
        : undefined;
  if (
    !run ||
    (!Node.isArrowFunction(run) &&
      !Node.isFunctionExpression(run) &&
      !Node.isMethodDeclaration(run))
  ) {
    throw new Error(
      `Workflow '${opts.workflowName}' boundary ${opts.boundaryIndex + 1} must define 'run' as an inline function`,
    );
  }
  return run;
}

function requireBatchCallback(opts: {
  config: ObjectLiteralExpression;
  propertyName: "source" | "process";
  workflowName: string;
  topLevelIndex: number;
}): BatchCallback {
  const property = opts.config.getProperty(opts.propertyName);
  const callback =
    property && Node.isPropertyAssignment(property)
      ? property.getInitializer()
      : property && Node.isMethodDeclaration(property)
        ? property
        : undefined;
  if (
    !callback ||
    (!Node.isArrowFunction(callback) &&
      !Node.isFunctionExpression(callback) &&
      !Node.isMethodDeclaration(callback))
  ) {
    throw new Error(
      `Workflow '${opts.workflowName}' batch ${opts.topLevelIndex + 1} must define '${opts.propertyName}' as an inline function`,
    );
  }
  return callback;
}

/**
 * Evaluates an expression that must be a JSON constant. Trigger configs are
 * introspected by hosts without running project code, so anything computed —
 * identifiers, calls, spreads, template substitutions — is rejected.
 */
function evaluateConstantExpression(
  node: Node,
  path: string,
): { ok: true; value: JsonConstant } | { ok: false; reason: string } {
  const expression = unwrapExpression(node);
  if (Node.isStringLiteral(expression)) {
    return { ok: true, value: expression.getLiteralValue() };
  }
  if (Node.isNoSubstitutionTemplateLiteral(expression)) {
    return { ok: true, value: expression.getLiteralValue() };
  }
  if (Node.isNumericLiteral(expression)) {
    return { ok: true, value: expression.getLiteralValue() };
  }
  if (Node.isPrefixUnaryExpression(expression)) {
    const operand = expression.getOperand();
    if (
      expression.getOperatorToken() === SyntaxKind.MinusToken &&
      Node.isNumericLiteral(operand)
    ) {
      return { ok: true, value: -operand.getLiteralValue() };
    }
    return { ok: false, reason: `${path} must be a constant expression` };
  }
  if (expression.getKind() === SyntaxKind.TrueKeyword) {
    return { ok: true, value: true };
  }
  if (expression.getKind() === SyntaxKind.FalseKeyword) {
    return { ok: true, value: false };
  }
  if (expression.getKind() === SyntaxKind.NullKeyword) {
    return { ok: true, value: null };
  }
  if (Node.isArrayLiteralExpression(expression)) {
    const values: JsonConstant[] = [];
    for (const [index, element] of expression.getElements().entries()) {
      const result = evaluateConstantExpression(element, `${path}[${index}]`);
      if (!result.ok) return result;
      values.push(result.value);
    }
    return { ok: true, value: values };
  }
  if (Node.isObjectLiteralExpression(expression)) {
    const value: { [key: string]: JsonConstant } = {};
    for (const property of expression.getProperties()) {
      if (!Node.isPropertyAssignment(property)) {
        return {
          ok: false,
          reason: `${path} must use plain 'key: value' properties`,
        };
      }
      const nameNode = property.getNameNode();
      const key = Node.isStringLiteral(nameNode)
        ? nameNode.getLiteralValue()
        : Node.isIdentifier(nameNode)
          ? nameNode.getText()
          : undefined;
      if (key === undefined) {
        return {
          ok: false,
          reason: `${path} must use identifier or string-literal keys`,
        };
      }
      const initializer = property.getInitializer();
      if (!initializer) {
        return { ok: false, reason: `${path}.${key} must have a value` };
      }
      const result = evaluateConstantExpression(initializer, `${path}.${key}`);
      if (!result.ok) return result;
      value[key] = result.value;
    }
    return { ok: true, value };
  }
  return { ok: false, reason: `${path} must be a constant expression` };
}

function parseTriggerBindings(opts: {
  config: ObjectLiteralExpression;
  workflowName: string;
}): WorkflowTriggerBinding[] {
  const triggersProperty = opts.config.getProperty("triggers");
  if (!triggersProperty) return [];
  if (!Node.isPropertyAssignment(triggersProperty)) {
    throw new Error(
      `Workflow '${opts.workflowName}' must define 'triggers' as a property assignment`,
    );
  }
  const initializer = unwrapExpression(
    triggersProperty.getInitializerOrThrow(),
  );
  if (!Node.isArrayLiteralExpression(initializer)) {
    throw new Error(
      `Workflow '${opts.workflowName}' must define 'triggers' as an inline array of trigger(...) calls`,
    );
  }
  const bindings: WorkflowTriggerBinding[] = [];
  for (const [index, element] of initializer.getElements().entries()) {
    const call = unwrapExpression(element);
    if (!Node.isCallExpression(call) || getCallName(call) !== "trigger") {
      throw new Error(
        `Workflow '${opts.workflowName}' trigger ${index + 1} must be a direct trigger(...) call`,
      );
    }
    const kindArgument = call.getArguments()[0]
      ? unwrapExpression(call.getArguments()[0]!)
      : undefined;
    if (
      !kindArgument ||
      (!Node.isStringLiteral(kindArgument) &&
        !Node.isNoSubstitutionTemplateLiteral(kindArgument))
    ) {
      throw new Error(
        `Workflow '${opts.workflowName}' trigger ${index + 1} must name its kind as a string literal`,
      );
    }
    const kind = kindArgument.getLiteralValue();
    const configArgument = call.getArguments()[1];
    let config: JsonConstant = {};
    if (configArgument) {
      const result = evaluateConstantExpression(
        configArgument,
        `trigger('${kind}') config`,
      );
      if (!result.ok) {
        throw new Error(
          `Workflow '${opts.workflowName}' trigger ${index + 1}: ${result.reason}. Trigger config is introspected by the host, so it must be written as a constant.`,
        );
      }
      config = result.value;
    }
    bindings.push({ kind, config, sourceRange: getSourceRange(call) });
  }
  return bindings;
}

function parseDurableDefinition(
  workflow: FoundDefinedWorkflow,
): DurableWorkflowDefinition {
  const initializer = workflow.declaration.getInitializer();
  if (!initializer || !Node.isCallExpression(initializer)) {
    throw new Error(
      `Workflow '${workflow.name}' must be initialized with defineWorkflow`,
    );
  }
  const builderExpression = initializer.getArguments()[0];
  if (
    !builderExpression ||
    (!Node.isArrowFunction(builderExpression) &&
      !Node.isFunctionExpression(builderExpression))
  ) {
    throw new Error(
      `Workflow '${workflow.name}' must use an inline builder function`,
    );
  }
  const config = requireReturnedObjectLiteral({
    callback: builderExpression,
    workflowName: workflow.name,
  });
  const stepsProperty = config.getProperty("steps");
  const steps =
    stepsProperty && Node.isPropertyAssignment(stepsProperty)
      ? stepsProperty.getInitializer()
      : undefined;
  if (!steps || !Node.isArrayLiteralExpression(steps)) {
    throw new Error(
      `Workflow '${workflow.name}' must define 'steps' as an inline array`,
    );
  }
  if (steps.getElements().length === 0) {
    throw new Error(
      `Workflow '${workflow.name}' must contain at least one boundary or batch`,
    );
  }

  const definitions = steps.getElements().map((element, topLevelIndex) => {
    const call = unwrapExpression(element);
    if (!Node.isCallExpression(call)) {
      throw new Error(
        `Workflow '${workflow.name}' step ${topLevelIndex + 1} must be a direct defineBoundary or defineBatch call`,
      );
    }
    const helperName = getCallName(call);
    if (helperName !== "defineBoundary" && helperName !== "defineBatch") {
      throw new Error(
        `Workflow '${workflow.name}' step ${topLevelIndex + 1} must be a direct defineBoundary or defineBatch call`,
      );
    }
    const configExpression = call.getArguments()[0];
    if (
      !configExpression ||
      !Node.isObjectLiteralExpression(configExpression)
    ) {
      throw new Error(
        `Workflow '${workflow.name}' ${helperName === "defineBoundary" ? "boundary" : "batch"} ${topLevelIndex + 1} must use an object literal`,
      );
    }
    if (helperName === "defineBatch") {
      const process = requireBatchCallback({
        config: configExpression,
        propertyName: "process",
        workflowName: workflow.name,
        topLevelIndex,
      });
      const sinkProperty = configExpression.getProperty("sink");
      if (sinkProperty && !Node.isPropertyAssignment(sinkProperty)) {
        throw new Error(
          `Workflow '${workflow.name}' batch ${topLevelIndex + 1} must define 'sink' as a property`,
        );
      }
      return {
        type: "batch",
        topLevelIndex,
        call,
        config: configExpression,
        jsdoc: extractLeadingJsDocMetadata(call),
        source: requireBatchCallback({
          config: configExpression,
          propertyName: "source",
          workflowName: workflow.name,
          topLevelIndex,
        }),
        process,
        sink: sinkProperty?.getInitializer(),
      } satisfies BatchScopeDefinition;
    }
    return {
      type: "boundary",
      topLevelIndex,
      call,
      config: configExpression,
      jsdoc: extractLeadingJsDocMetadata(call),
      run: requireDurableRun({
        config: configExpression,
        workflowName: workflow.name,
        boundaryIndex: topLevelIndex,
      }),
    } satisfies DurableBoundaryDefinition;
  });
  return { builder: builderExpression, config, steps: definitions };
}

function extractDurableInputParameters(
  callback: DurableCallback,
  paramMetadata: Map<string, { displayName?: string; description?: string }>,
): ParameterInfo[] {
  const parameter = callback.getParameters()[0];
  const typeNode = parameter?.getTypeNode();
  if (!parameter || !typeNode || !Node.isTypeReference(typeNode)) return [];
  if (typeNode.getTypeName().getText() !== "BoundaryContext") return [];
  const inputTypeNode = typeNode.getTypeArguments()[0];
  if (!inputTypeNode) return [];

  const properties = inputTypeNode.getType().getProperties();
  if (properties.length === 0) {
    return [
      {
        name: "input",
        type: inputTypeNode.getText(),
        optional: false,
        displayName: paramMetadata.get("input")?.displayName,
        description: paramMetadata.get("input")?.description,
      },
    ];
  }
  return properties.map((property) => {
    const declaration = property.getDeclarations()[0];
    const metadata = paramMetadata.get(property.getName());
    return {
      name: property.getName(),
      type: declaration
        ? property.getTypeAtLocation(declaration).getText(declaration)
        : "unknown",
      optional: property.isOptional(),
      displayName: metadata?.displayName,
      description: metadata?.description,
      ...(declaration
        ? {
            schema: jsonSchemaFromType(
              property.getTypeAtLocation(declaration),
              declaration,
            ),
          }
        : {}),
    };
  });
}

function durableRetryMetadata(
  config: ObjectLiteralExpression,
): Record<string, string> {
  const retryProperty = config.getProperty("retry");
  const retry =
    retryProperty && Node.isPropertyAssignment(retryProperty)
      ? retryProperty.getInitializer()
      : undefined;
  if (!retry || !Node.isObjectLiteralExpression(retry)) return {};
  const backoffProperty = retry.getProperty("backoff");
  const backoff =
    backoffProperty && Node.isPropertyAssignment(backoffProperty)
      ? backoffProperty.getInitializer()
      : undefined;
  const backoffObject =
    backoff && Node.isObjectLiteralExpression(backoff) ? backoff : undefined;
  const read = (
    object: ObjectLiteralExpression | undefined,
    propertyName: string,
  ) => readObjectPropertyText(object, propertyName);
  return {
    ...(read(retry, "maxAttempts")
      ? { "retry:maxAttempts": read(retry, "maxAttempts") ?? "" }
      : {}),
    ...(read(backoffObject, "initial")
      ? { "retry:backoff.initial": read(backoffObject, "initial") ?? "" }
      : {}),
    ...(read(backoffObject, "maximum")
      ? { "retry:backoff.maximum": read(backoffObject, "maximum") ?? "" }
      : {}),
    ...(read(backoffObject, "multiplier")
      ? { "retry:backoff.multiplier": read(backoffObject, "multiplier") ?? "" }
      : {}),
  };
}

function durableRetryDescriptor(
  config: ObjectLiteralExpression,
): BoundaryExecutionDescriptor["retry"] {
  const retryProperty = config.getProperty("retry");
  const retry =
    retryProperty && Node.isPropertyAssignment(retryProperty)
      ? retryProperty.getInitializer()
      : undefined;
  if (!retry || !Node.isObjectLiteralExpression(retry)) return {};
  const backoffProperty = retry.getProperty("backoff");
  const backoff =
    backoffProperty && Node.isPropertyAssignment(backoffProperty)
      ? backoffProperty.getInitializer()
      : undefined;
  const backoffObject =
    backoff && Node.isObjectLiteralExpression(backoff) ? backoff : undefined;
  const initialExpression = readObjectPropertyText(backoffObject, "initial");
  const maximumExpression = readObjectPropertyText(backoffObject, "maximum");
  const multiplierExpression = readObjectPropertyText(
    backoffObject,
    "multiplier",
  );
  return {
    ...(readObjectPropertyText(retry, "maxAttempts")
      ? {
          maxAttemptsExpression:
            readObjectPropertyText(retry, "maxAttempts") ?? "",
        }
      : {}),
    ...(initialExpression || maximumExpression || multiplierExpression
      ? {
          backoff: {
            ...(initialExpression ? { initialExpression } : {}),
            ...(maximumExpression ? { maximumExpression } : {}),
            ...(multiplierExpression ? { multiplierExpression } : {}),
          },
        }
      : {}),
  };
}

function durableRateLimitDescriptors(
  config: ObjectLiteralExpression,
): BoundaryRateLimitDescriptor[] {
  const property = config.getProperty("rateLimits");
  if (!property) return [];
  const initializer =
    Node.isPropertyAssignment(property) && property.getInitializer();
  if (!initializer || !Node.isArrayLiteralExpression(initializer)) {
    throw new Error("Boundary 'rateLimits' must be an array literal");
  }
  return initializer.getElements().map((element) => {
    if (!Node.isObjectLiteralExpression(element)) {
      throw new Error("Each boundary rate limit must be an object literal");
    }
    const globalKeyExpression = readObjectPropertyText(element, "globalKey");
    const capacityExpression = readObjectPropertyText(element, "capacity");
    const refillRatePerSecondExpression = readObjectPropertyText(
      element,
      "refillRatePerSecond",
    );
    if (
      !globalKeyExpression ||
      !capacityExpression ||
      !refillRatePerSecondExpression
    ) {
      throw new Error(
        "A boundary rate limit requires globalKey, capacity, and refillRatePerSecond",
      );
    }
    const partitionKeyExpression = readObjectPropertyText(
      element,
      "partitionKey",
    );
    const costExpression = readObjectPropertyText(element, "cost");
    return {
      globalKeyExpression,
      ...(partitionKeyExpression ? { partitionKeyExpression } : {}),
      capacityExpression,
      refillRatePerSecondExpression,
      ...(costExpression ? { costExpression } : {}),
    };
  });
}

function batchFailurePolicyDescriptor(
  config: ObjectLiteralExpression,
): BatchExecutionDescriptor["failurePolicy"] {
  const property = config.getProperty("failurePolicy");
  if (!property) return { mode: "continue" };
  const policy =
    Node.isPropertyAssignment(property) && property.getInitializer();
  if (!policy || !Node.isObjectLiteralExpression(policy)) {
    throw new Error("Batch 'failurePolicy' must be an object literal");
  }
  const modeProperty = policy.getProperty("mode");
  const mode =
    modeProperty && Node.isPropertyAssignment(modeProperty)
      ? modeProperty.getInitializer()
      : undefined;
  if (!mode || !Node.isStringLiteral(mode)) {
    throw new Error("Batch 'failurePolicy.mode' must be a string literal");
  }
  const modeValue = mode.getLiteralValue();
  if (modeValue !== "continue" && modeValue !== "fail_fast") {
    throw new Error(
      "Batch 'failurePolicy.mode' must be 'continue' or 'fail_fast'",
    );
  }
  const maxFailuresProperty = policy.getProperty("maxFailures");
  const maxFailures =
    maxFailuresProperty && Node.isPropertyAssignment(maxFailuresProperty)
      ? maxFailuresProperty.getInitializer()
      : undefined;
  if (maxFailures && !Node.isNumericLiteral(maxFailures)) {
    throw new Error(
      "Batch 'failurePolicy.maxFailures' must be a positive integer literal",
    );
  }
  const maxFailuresValue = maxFailures
    ? Number(maxFailures.getText().replaceAll("_", ""))
    : undefined;
  if (
    maxFailuresValue !== undefined &&
    (!Number.isInteger(maxFailuresValue) || maxFailuresValue < 1)
  ) {
    throw new Error(
      "Batch 'failurePolicy.maxFailures' must be a positive integer literal",
    );
  }
  return {
    mode: modeValue,
    ...(maxFailuresValue !== undefined
      ? { maxFailures: maxFailuresValue }
      : {}),
  };
}

function extractDurableBoundaryParameters(
  callback: DurableCallback,
  paramMetadata: Map<string, { displayName?: string; description?: string }>,
): ParameterInfo[] | undefined {
  const parameters = extractDurableInputParameters(callback, paramMetadata);
  return parameters.length > 0 ? parameters : undefined;
}

function registerDurableInputVariable(opts: {
  ctx: ParseContext;
  callback: DurableCallback;
  sourceNodeId: string;
}): void {
  const parameter = opts.callback.getParameters()[0];
  const nameNode = parameter?.getNameNode();
  if (!nameNode || !Node.isObjectBindingPattern(nameNode)) return;
  for (const element of nameNode.getElements()) {
    if (element.getName() === "input") {
      opts.ctx.variables.set("input", {
        sourceNodeId: opts.sourceNodeId,
        sourceStepLabel: "Previous boundary",
      });
    }
  }
}

function parseWorkflowSteps(opts: {
  ctx: ParseContext;
  definitions: WorkflowStepDefinition[];
  previousIds: string[];
  parentId?: string;
}): {
  previousIds: string[];
  descriptors: Array<BoundaryExecutionDescriptor | BatchExecutionDescriptor>;
} {
  let previousIds = opts.previousIds;
  const descriptors: Array<
    BoundaryExecutionDescriptor | BatchExecutionDescriptor
  > = [];
  for (const definition of opts.definitions) {
    if (definition.type === "batch") {
      const parsed = parseBatchScope({
        ctx: opts.ctx,
        definition,
        previousIds,
        parentId: opts.parentId,
      });
      previousIds = [parsed.nodeId];
      descriptors.push(parsed.descriptor);
      continue;
    }

    const boundary = definition;
    const boundaryId = nextId();
    opts.ctx.nodes.push({
      id: boundaryId,
      type: "durable-boundary",
      label: boundary.jsdoc.displayName ?? "",
      description: boundary.jsdoc.description,
      sourceRange: getSourceRange(boundary.call),
      metadata: {
        ...boundary.jsdoc.tags,
        ...durableRetryMetadata(boundary.config),
      },
      parameters: extractDurableBoundaryParameters(
        boundary.run,
        boundary.jsdoc.paramMetadata,
      ),
      parentId: opts.parentId,
    });
    addEdgesFromPrevious(opts.ctx, previousIds, boundaryId);
    registerDurableInputVariable({
      ctx: opts.ctx,
      callback: boundary.run,
      sourceNodeId: boundaryId,
    });

    const body = boundary.run.getBody();
    const previousMode = opts.ctx.statementMode;
    opts.ctx.statementMode = "boundary";
    if (Node.isBlock(body)) {
      parseStatements(opts.ctx, body.getStatements(), [], boundaryId);
    } else if (body) {
      const parsedTransition = parseDurableTransitionExpression(
        opts.ctx,
        body,
        [],
        boundaryId,
      );
      const expression = unwrapExpression(body);
      if (!parsedTransition && Node.isCallExpression(expression)) {
        const fnName = getCallName(expression);
        validateStepCall(opts.ctx, fnName);
        const stepMeta = lookupStepMetadata(opts.ctx, fnName);
        opts.ctx.nodes.push({
          id: nextId(),
          type: "step",
          label: stepMeta.displayName ?? fnName,
          sourceRange: getSourceRange(expression),
          metadata: stepMeta.metadata,
          functionName: fnName,
          parameters: lookupStepParams(opts.ctx, fnName),
          arguments: extractCallArguments(expression, opts.ctx, fnName),
          parentId: boundaryId,
        });
      }
    }
    opts.ctx.statementMode = previousMode;
    descriptors.push({
      type: "boundary",
      topLevelIndex: boundary.topLevelIndex,
      nodeId: boundaryId,
      sourceRange: getSourceRange(boundary.call),
      runRange: getSourceRange(boundary.run),
      retry: durableRetryDescriptor(boundary.config),
      ...(() => {
        const rateLimits = durableRateLimitDescriptors(boundary.config);
        return rateLimits.length > 0 ? { rateLimits } : {};
      })(),
    });
    previousIds = [boundaryId];
  }
  return { previousIds, descriptors };
}

function parseBatchScope(opts: {
  ctx: ParseContext;
  definition: BatchScopeDefinition;
  previousIds: string[];
  parentId?: string;
}): { nodeId: string; descriptor: BatchExecutionDescriptor } {
  const { ctx, definition } = opts;
  const batchId = nextId();
  ctx.nodes.push({
    id: batchId,
    type: "batch",
    label: definition.jsdoc.displayName ?? "Batch",
    description: definition.jsdoc.description,
    sourceRange: getSourceRange(definition.call),
    metadata: definition.jsdoc.tags,
    parentId: opts.parentId,
  });
  addEdgesFromPrevious(ctx, opts.previousIds, batchId);

  const sourceParameters = extractCallbackParameters(definition.source);
  const sourceId = nextId();
  ctx.nodes.push({
    id: sourceId,
    type: "source",
    label: "Source",
    sourceRange: getSourceRange(definition.source),
    metadata: {},
    parameters: sourceParameters,
    parentId: batchId,
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

  const nodeStart = ctx.nodes.length;
  const returnStart = ctx.returnNodeIds.length;
  const previousMode = ctx.statementMode;
  const previousReturnLabel = ctx.returnLabel;
  ctx.statementMode = "batch-process";
  ctx.returnLabel = "Item result";
  const processBody = definition.process.getBody();
  if (!processBody) {
    throw new Error(
      `Workflow batch ${definition.topLevelIndex + 1} 'process' must have a body`,
    );
  }
  const processExits = Node.isBlock(processBody)
    ? parseStatements(ctx, processBody.getStatements(), [sourceId], batchId)
    : parseBatchProcessExpression({
        ctx,
        expression: processBody,
        previousIds: [sourceId],
        parentId: batchId,
      });
  ctx.statementMode = previousMode;
  ctx.returnLabel = previousReturnLabel;

  const processNodes = ctx.nodes.slice(nodeStart);
  const stepNodes = processNodes.filter(
    (node) => node.type === "step" && node.functionName,
  );
  const physicalSteps = stepNodes.flatMap((node) => {
    if (!node.functionName) return [];
    const batchStep = ctx.stepFunctions.get(node.functionName)?.batch;
    if (!batchStep) return [];
    if (!batchStep.exported) {
      throw new Error(`Batch step '${node.functionName}' must be exported`);
    }
    if (
      !batchStep.policy.maxItemsExpression ||
      !batchStep.policy.maxWaitMsExpression
    ) {
      throw new Error(
        `Batch step '${node.functionName}' must define maxItems and maxWaitMs`,
      );
    }
    return [
      {
        nodeId: node.id,
        functionName: node.functionName,
        sourceRange: node.sourceRange,
        policy: {
          maxItemsExpression: batchStep.policy.maxItemsExpression,
          maxWaitMsExpression: batchStep.policy.maxWaitMsExpression,
          ...(batchStep.policy.maxBytesExpression
            ? { maxBytesExpression: batchStep.policy.maxBytesExpression }
            : {}),
          ...(batchStep.policy.rateLimitsExpression
            ? { rateLimitsExpression: batchStep.policy.rateLimitsExpression }
            : {}),
          ...(batchStep.policy.partitionByExpression
            ? { partitionByExpression: batchStep.policy.partitionByExpression }
            : {}),
        },
        exportTarget: {
          modulePath: batchStep.modulePath,
          exportName: batchStep.exportName,
        },
      },
    ];
  });

  let sinkDescriptor: BatchExecutionDescriptor["sink"];
  if (definition.sink) {
    const sinkId = nextId();
    ctx.nodes.push({
      id: sinkId,
      type: "sink",
      label: "Sink",
      sourceRange: getSourceRange(definition.sink),
      metadata: {},
      parentId: batchId,
    });
    const returnIds = ctx.returnNodeIds.slice(returnStart);
    const sinkPreviousIds =
      processExits.length > 0
        ? processExits
        : returnIds.length > 0
          ? returnIds
          : [sourceId];
    addEdgesFromPrevious(ctx, sinkPreviousIds, sinkId);
    sinkDescriptor = { sourceRange: getSourceRange(definition.sink) };
  }

  return {
    nodeId: batchId,
    descriptor: {
      type: "batch",
      topLevelIndex: definition.topLevelIndex,
      nodeId: batchId,
      sourceRange: getSourceRange(definition.call),
      source: { sourceRange: getSourceRange(definition.source) },
      process: {
        sourceRange: getSourceRange(definition.process),
        stepNodeIds: stepNodes.map((node) => node.id),
        physicalSteps,
      },
      failurePolicy: batchFailurePolicyDescriptor(definition.config),
      ...(sinkDescriptor ? { sink: sinkDescriptor } : {}),
    },
  };
}

function parseBatchProcessExpression(opts: {
  ctx: ParseContext;
  expression: Node;
  previousIds: string[];
  parentId: string;
}): string[] {
  const expression = unwrapExpression(opts.expression);
  let previousIds = opts.previousIds;
  if (Node.isCallExpression(expression)) {
    const fnName = getCallName(expression);
    validateStepCall(opts.ctx, fnName);
    const stepMeta = lookupStepMetadata(opts.ctx, fnName);
    const stepId = nextId();
    opts.ctx.nodes.push({
      id: stepId,
      type: "step",
      label: stepMeta.displayName ?? fnName,
      sourceRange: getSourceRange(expression),
      metadata: stepMeta.metadata,
      functionName: fnName,
      parameters: lookupStepParams(opts.ctx, fnName),
      arguments: extractCallArguments(expression, opts.ctx, fnName),
      parentId: opts.parentId,
    });
    addEdgesFromPrevious(opts.ctx, previousIds, stepId);
    previousIds = [stepId];
  }

  const returnId = nextId();
  opts.ctx.nodes.push({
    id: returnId,
    type: "return",
    label: "Item result",
    sourceRange: getSourceRange(opts.expression),
    metadata: {},
    returnExpression: opts.expression.getText(),
    parentId: opts.parentId,
  });
  opts.ctx.returnNodeIds.push(returnId);
  addEdgesFromPrevious(opts.ctx, previousIds, returnId);
  return [];
}

function buildDefinedWorkflowGraph(
  workflow: FoundDefinedWorkflow,
  stepFunctions: Map<string, StepDefinition>,
  opts?: { filePath?: string; projectFiles?: string[]; sourceCode?: string },
): WorkflowGraph {
  const definition = parseDurableDefinition(workflow);
  validateBatchStepCallLocations({
    root: definition.builder,
    stepFunctions,
    processCallbacks: definition.steps.flatMap((step) =>
      step.type === "batch" ? [step.process] : [],
    ),
  });
  const sourceFile = workflow.sourceFile;
  const metadataSource = workflow.declaration.getVariableStatement();
  const jsdoc = metadataSource
    ? extractJsDocMetadata(metadataSource)
    : { tags: {}, paramMetadata: new Map<string, never>() };
  const firstStep = definition.steps[0];
  const inputParameters =
    firstStep?.type === "boundary"
      ? extractDurableInputParameters(firstStep.run, jsdoc.paramMetadata)
      : firstStep?.type === "batch"
        ? extractCallbackParameters(firstStep.source)
        : [];
  const triggerBindings = parseTriggerBindings({
    config: definition.config,
    workflowName: workflow.name,
  });
  const { inputSchema, outputSchema } = extractIoSchemas(definition);
  const controlsProperty = definition.config.getProperty("controls");
  const controlsObject =
    controlsProperty && Node.isPropertyAssignment(controlsProperty)
      ? controlsProperty.getInitializer()
      : undefined;
  const cancelControl =
    controlsObject && Node.isObjectLiteralExpression(controlsObject)
      ? readObjectPropertyText(controlsObject, "cancel")
      : undefined;
  const ctx: ParseContext = {
    nodes: [],
    edges: [],
    returnNodeIds: [],
    sourceFile,
    stepFunctions,
    variables: new Map(),
    workflowFile: normalizePath(sourceFile.getFilePath()),
    statementMode: "boundary",
    workflowStack: new Set([
      `${normalizePath(sourceFile.getFilePath())}#${workflow.name}`,
    ]),
  };
  currentWorkflowFile = ctx.workflowFile;

  const inputId = nextId();
  const inputLabel = jsdoc.displayName ?? workflow.name;
  ctx.nodes.push({
    id: inputId,
    type: "input",
    label: inputLabel,
    description: jsdoc.description,
    sourceRange: getSourceRange(workflow.declaration),
    metadata: jsdoc.tags,
    parameters: inputParameters,
    ...(triggerBindings.length > 0 ? { triggerBindings } : {}),
  });
  for (const parameter of inputParameters) {
    ctx.variables.set(parameter.name, {
      sourceNodeId: inputId,
      sourceStepLabel: inputLabel,
    });
  }

  const parsedSteps = parseWorkflowSteps({
    ctx,
    definitions: definition.steps,
    previousIds: [inputId],
  });
  const hasBatch = definition.steps.some((step) => step.type === "batch");
  const cancellation = cancelControl === "true";
  // Conservative over-approximation of every durable-wait source. `false`
  // guarantees a sync trigger firing completes inline.
  const canSuspend =
    hasBatch ||
    definition.steps.some(
      (step) =>
        step.type === "boundary" &&
        (step.config.getProperty("retry") !== undefined ||
          step.config.getProperty("rateLimits") !== undefined),
    ) ||
    ctx.nodes.some(
      (node) =>
        node.type === "pause" ||
        node.type === "call-workflow" ||
        node.type === "delay",
    );

  return {
    name: workflow.name,
    capabilities: {
      batchProcessing: hasBatch,
      cancellation,
    },
    execution: {
      exportTarget: {
        modulePath: opts?.filePath
          ? normalizePath(opts.filePath)
          : normalizePath(sourceFile.getFilePath()),
        exportName: workflow.name,
      },
      steps: parsedSteps.descriptors,
    },
    displayName: jsdoc.displayName,
    description: jsdoc.description,
    controls: cancellation ? { cancel: true } : undefined,
    input: { parameters: inputParameters },
    inputSchema,
    outputSchema,
    triggers: triggerBindings,
    canSuspend,
    nodes: ctx.nodes,
    edges: ctx.edges,
    sourceCode: opts?.sourceCode ?? sourceFile.getFullText(),
    filePath: opts?.filePath ? normalizePath(opts.filePath) : undefined,
    projectFiles: opts?.projectFiles?.map(normalizePath),
  };
}

/**
 * JSON Schemas for a workflow's input (what a trigger/run delivers) and
 * output (what the last step resolves to). Batch inputs come from the
 * source callback's input parameter; batch outputs are summaries whose
 * shape the runtime owns, so they stay permissive.
 */
function extractIoSchemas(definition: DurableWorkflowDefinition): {
  inputSchema: unknown;
  outputSchema: unknown;
} {
  const permissive: { inputSchema: unknown; outputSchema: unknown } = {
    inputSchema: {},
    outputSchema: {},
  };
  const firstStep = definition.steps[0];
  const lastStep = definition.steps[definition.steps.length - 1];
  if (!firstStep || !lastStep) return permissive;

  let inputSchema: unknown = {};
  if (firstStep.type === "boundary") {
    const parameter = firstStep.run.getParameters()[0];
    const typeNode = parameter?.getTypeNode();
    if (
      parameter &&
      typeNode &&
      Node.isTypeReference(typeNode) &&
      typeNode.getTypeName().getText() === "BoundaryContext"
    ) {
      const inputTypeNode = typeNode.getTypeArguments()[0];
      if (inputTypeNode) {
        inputSchema = jsonSchemaFromType(
          inputTypeNode.getType(),
          inputTypeNode,
        );
      }
    }
  } else if (firstStep.type === "batch") {
    const parameter = firstStep.source.getParameters()[0];
    const typeNode = parameter?.getTypeNode();
    if (parameter && typeNode) {
      const inputProperty = typeNode
        .getType()
        .getProperties()
        .find((property) => property.getName() === "input");
      const declaration = inputProperty?.getDeclarations()[0];
      if (inputProperty && declaration) {
        inputSchema = jsonSchemaFromType(
          inputProperty.getTypeAtLocation(declaration),
          declaration,
        );
      }
    }
  }

  let outputSchema: unknown = {};
  if (lastStep.type === "boundary") {
    const run = lastStep.run;
    outputSchema = jsonSchemaFromBoundaryReturn(run.getReturnType(), run);
  }
  return { inputSchema, outputSchema };
}

/** In-memory home of the injected `@catamorphic/workflow` type surface. */
const WORKFLOW_STUB_PATH = "/node_modules/@catamorphic/workflow/index.d.ts";

function createMultiFileProject(files: Record<string, string>): Project {
  const project = new Project({
    useInMemoryFileSystem: true,
    compilerOptions: {
      strict: true,
      target: 99, // ts.ScriptTarget.ESNext
      module: 99, // ts.ModuleKind.ESNext
      moduleResolution: 100, // ts.ModuleResolutionKind.Bundler
      esModuleInterop: true,
      skipLibCheck: true,
      baseUrl: "/",
      // Resolve the two cross-package imports workflow files use, so
      // BoundaryContext type arguments and contracts types feed the type
      // checker instead of degrading to `any`.
      paths: {
        "@catamorphic/workflow": [WORKFLOW_STUB_PATH],
        "@project/contracts": [`/${CONTRACTS_SOURCE_ROOT}/src/index.ts`],
      },
    },
  });

  project.createSourceFile(WORKFLOW_STUB_PATH, WORKFLOW_STUB_DTS, {
    overwrite: true,
  });

  // Callers occasionally pass both "src/a.ts" and "/src/a.ts" (e.g. after
  // legacy drafts). ts-morph normalizes these to the same absolute path and
  // throws on the second createSourceFile call, so dedupe by normalized key
  // and use overwrite: true for safety.
  const seen = new Set<string>();
  for (const [filePath, content] of Object.entries(files)) {
    if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue;
    if (isAppSourcePath(filePath)) continue;
    const key = normalizePath(filePath);
    if (seen.has(key)) continue;
    seen.add(key);
    project.createSourceFile(key, content, { overwrite: true });
  }

  project.resolveSourceFileDependencies();
  return project;
}

function getWorkflowName(workflow: FoundWorkflow): string {
  return workflow.name;
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
  switch (opts.workflow.type) {
    case "defined":
      return buildDefinedWorkflowGraph(
        opts.workflow,
        opts.stepFunctions,
        graphOptions,
      );
    case "obsolete-batch":
      throw new Error(
        `Workflow '${opts.workflow.name}' uses removed defineBatchWorkflow; wrap defineBatch(...) in an exported defineWorkflow(({ defineBatch }) => ({ steps: [...] })) definition`,
      );
  }
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
        capabilities: graph.capabilities,
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

  const secrets = findDeclaredSecrets(sourceFiles, errors);
  const appApi = resolveAppApi({
    sourceFiles,
    workflows: discovered,
    errors,
  });
  if (appApi) {
    // Join each contract entry with its workflow's IO schemas so consumers
    // (typed app clients, MCP tools) never re-derive them.
    const byName = new Map(
      discovered.map((workflow) => [workflow.functionName, workflow.graph]),
    );
    for (const entry of appApi.entries) {
      const graph = byName.get(entry.workflowName);
      if (graph) {
        entry.inputSchema = graph.inputSchema;
        entry.outputSchema = graph.outputSchema;
      }
    }
  }

  return { workflows: discovered, secrets, appApi, errors };
}

/**
 * Resolves the app-facing contract surface: `workflows/src/app-api.ts` exports
 * an object literal (conventionally `appApi`) whose property values reference
 * workflow functions. The property names become the callable set apps are
 * authorized against, so resolution is strict — every value must resolve, via
 * ts-morph bindings rather than text matching, to a workflow discovered in
 * this parse. Anything else is an error, not a skip: an entry that silently
 * failed to resolve would silently widen or narrow an authorization surface.
 */
function resolveAppApi(opts: {
  sourceFiles: readonly SourceFile[];
  workflows: readonly DiscoveredWorkflow[];
  errors: ParseError[];
}): AppApiSurface | null {
  const appApiFile = opts.sourceFiles.find((sf) =>
    projectPathsEqual(sf.getFilePath(), APP_API_SOURCE_PATH),
  );
  if (!appApiFile) return null;
  const filePath = normalizePath(appApiFile.getFilePath());

  const surfaces: AppApiEntry[][] = [];
  for (const statement of appApiFile.getVariableStatements()) {
    if (!statement.isExported()) continue;
    for (const declaration of statement.getDeclarations()) {
      const initializer = declaration.getInitializer();
      if (!initializer) continue;
      const literal = Node.isObjectLiteralExpression(initializer)
        ? initializer
        : Node.isSatisfiesExpression(initializer) &&
            Node.isObjectLiteralExpression(initializer.getExpression())
          ? initializer.getExpression()
          : undefined;
      if (!literal || !Node.isObjectLiteralExpression(literal)) continue;
      const entries = collectAppApiEntries({
        literal,
        workflows: opts.workflows,
        filePath,
        errors: opts.errors,
      });
      if (entries) surfaces.push(entries);
    }
  }

  if (surfaces.length === 0) {
    opts.errors.push({
      file: filePath,
      message:
        "app-api.ts must export an object literal mapping names to workflow functions.",
    });
    return null;
  }
  if (surfaces.length > 1) {
    opts.errors.push({
      file: filePath,
      message:
        "app-api.ts must export exactly one contract object; found several.",
    });
    return null;
  }
  const entries = surfaces[0] ?? [];
  return { filePath, entries };
}

function collectAppApiEntries(opts: {
  literal: ObjectLiteralExpression;
  workflows: readonly DiscoveredWorkflow[];
  filePath: string;
  errors: ParseError[];
}): AppApiEntry[] | null {
  const byName = new Map(
    opts.workflows.map((workflow) => [workflow.functionName, workflow]),
  );
  const entries: AppApiEntry[] = [];
  let failed = false;

  for (const property of opts.literal.getProperties()) {
    let exposedName: string | undefined;
    let valueNode: Node | undefined;
    let shorthand = false;
    if (Node.isShorthandPropertyAssignment(property)) {
      exposedName = property.getName();
      valueNode = property.getNameNode();
      shorthand = true;
    } else if (Node.isPropertyAssignment(property)) {
      exposedName = readPropertyName(property.getNameNode());
      valueNode = property.getInitializer();
    }
    if (!exposedName || !valueNode || !Node.isIdentifier(valueNode)) {
      opts.errors.push({
        file: opts.filePath,
        message:
          "app-api.ts entries must be plain identifier references to workflow functions.",
      });
      failed = true;
      continue;
    }

    // Follow the binding to its declaration; import specifiers resolve
    // across files, so a renamed import still lands on the real function.
    const workflowName = resolveWorkflowBinding(valueNode, byName, shorthand);
    if (!workflowName) {
      opts.errors.push({
        file: opts.filePath,
        message: `app-api.ts entry '${exposedName}' does not resolve to a workflow in this project.`,
      });
      failed = true;
      continue;
    }
    const workflow = byName.get(workflowName);
    if (!workflow) {
      failed = true;
      continue;
    }
    entries.push({
      exposedName,
      workflowName,
      capabilities: workflow.capabilities,
    });
  }

  return failed ? null : entries;
}

function resolveWorkflowBinding(
  identifier: Node,
  workflowsByName: ReadonlyMap<string, DiscoveredWorkflow>,
  shorthand: boolean,
): string | undefined {
  if (!Node.isIdentifier(identifier)) return undefined;
  // In `{ listOrders }` the identifier's own symbol is the *property*; the
  // value binding lives behind the checker's shorthand-assignment lookup.
  const symbol = shorthand
    ? identifier
        .getProject()
        .getTypeChecker()
        .getShorthandAssignmentValueSymbol(identifier.getParent())
    : identifier.getSymbol();
  for (const declaration of symbol?.getDeclarations() ?? []) {
    if (Node.isImportSpecifier(declaration)) {
      // getNameNode() is the original exported name even when the import is
      // aliased, and the workflow is discovered under its exported name.
      const original = declaration.getNameNode().getText();
      if (workflowsByName.has(original)) return original;
      continue;
    }
    if (Node.isFunctionDeclaration(declaration)) {
      const name = declaration.getName();
      if (name && workflowsByName.has(name)) return name;
      continue;
    }
    if (Node.isVariableDeclaration(declaration)) {
      const name = declaration.getNameNode().getText();
      if (workflowsByName.has(name)) return name;
    }
  }
  return undefined;
}

/**
 * Collects `defineSecrets({ ... })` declarations. Only statically analyzable
 * object literals are recognized: the declared set gates which secret values a
 * project may store, so a name that cannot be read from source must not be
 * silently granted.
 */
function findDeclaredSecrets(
  sourceFiles: readonly SourceFile[],
  errors: ParseError[],
): DeclaredSecret[] {
  const byName = new Map<string, DeclaredSecret>();

  for (const sf of sourceFiles) {
    const filePath = normalizePath(sf.getFilePath());
    for (const call of sf.getDescendantsOfKind(SyntaxKind.CallExpression)) {
      const callee = call.getExpression();
      if (!Node.isIdentifier(callee) || callee.getText() !== "defineSecrets") {
        continue;
      }
      const [argument] = call.getArguments();
      if (!argument || !Node.isObjectLiteralExpression(argument)) {
        errors.push({
          file: filePath,
          message:
            "defineSecrets requires an inline object literal so declared secrets can be read from source.",
        });
        continue;
      }

      for (const property of argument.getProperties()) {
        if (!Node.isPropertyAssignment(property)) continue;
        const name = readPropertyName(property.getNameNode());
        if (!name) continue;
        const initializer = property.getInitializer();
        const options =
          initializer && Node.isObjectLiteralExpression(initializer)
            ? initializer
            : undefined;
        byName.set(name, {
          name,
          label: readStringProperty(options, "label"),
          description: readStringProperty(options, "description"),
          required: readBooleanProperty(options, "required") ?? true,
          default: readStringProperty(options, "default"),
          filePath,
        });
      }
    }
  }

  return [...byName.values()].sort((left, right) =>
    left.name.localeCompare(right.name),
  );
}

function readPropertyName(nameNode: Node): string | undefined {
  if (Node.isIdentifier(nameNode)) return nameNode.getText();
  if (Node.isStringLiteral(nameNode)) return nameNode.getLiteralValue();
  return undefined;
}

function readStringProperty(
  object: ObjectLiteralExpression | undefined,
  name: string,
): string | undefined {
  const property = object?.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  return initializer && Node.isStringLiteral(initializer)
    ? initializer.getLiteralValue()
    : undefined;
}

function readBooleanProperty(
  object: ObjectLiteralExpression | undefined,
  name: string,
): boolean | undefined {
  const property = object?.getProperty(name);
  if (!property || !Node.isPropertyAssignment(property)) return undefined;
  const initializer = property.getInitializer();
  if (!initializer) return undefined;
  if (initializer.getKind() === SyntaxKind.TrueKeyword) return true;
  if (initializer.getKind() === SyntaxKind.FalseKeyword) return false;
  return undefined;
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

  const definitionWorkflow = findAllWorkflows([sourceFile])[0];
  if (!definitionWorkflow) {
    throw new Error("No workflow definition found");
  }

  const stepFunctions = collectStepFunctions([sourceFile]);
  return buildFoundWorkflowGraph({
    workflow: definitionWorkflow,
    stepFunctions,
    fileNames: ["workflow.ts"],
  });
}
