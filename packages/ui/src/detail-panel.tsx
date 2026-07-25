import type {
  ParameterInfo,
  StepArgument,
  WorkflowNode,
} from "@catamorphic/parser";
import {
  activePanelTabAtom,
  codeEditorReadOnlyAtom,
  graphAtom,
  type PanelTab,
  rightPanelOpenAtom,
  selectedNodeAtom,
  selectedNodeIdAtom,
} from "@catamorphic/react";
import { useAtom, useAtomValue, useSetAtom } from "jotai";
import type { ReactNode } from "react";
import {
  formatDefaultValue,
  friendlyParamName,
  friendlyType,
  prettyCondition,
} from "./display-utils.js";

function ParamRow({
  param,
  argument,
}: {
  param: ParameterInfo;
  argument?: StepArgument;
}) {
  const displayName = param.displayName ?? friendlyParamName(param.name);
  const sourceLabel =
    argument?.source?.variableDisplayName ?? argument?.source?.stepLabel;

  return (
    <div className="catamorphic-detail-param">
      <div className="catamorphic-detail-param-header">
        <span className="catamorphic-detail-param-name">{displayName}</span>
        <span className="catamorphic-detail-param-type">
          {friendlyType(param.type)}
        </span>
        {param.optional && (
          <span className="catamorphic-detail-param-optional">optional</span>
        )}
      </div>
      {argument && (
        <div className="catamorphic-detail-arg-value">
          <code>{argument.value}</code>
          {sourceLabel && (
            <span className="catamorphic-detail-arg-source">
              from {sourceLabel}
            </span>
          )}
        </div>
      )}
      {param.description && (
        <p className="catamorphic-detail-param-desc">{param.description}</p>
      )}
      {param.defaultValue != null && (
        <p className="catamorphic-detail-param-default">
          Default: {formatDefaultValue(param.defaultValue)}
        </p>
      )}
    </div>
  );
}

function ArgumentOnlyRow({ arg }: { arg: StepArgument }) {
  const displayName = arg.displayName ?? friendlyParamName(arg.name);
  const sourceLabel = arg.source?.variableDisplayName ?? arg.source?.stepLabel;

  return (
    <div className="catamorphic-detail-param">
      <div className="catamorphic-detail-param-header">
        <span className="catamorphic-detail-param-name">{displayName}</span>
      </div>
      <div className="catamorphic-detail-arg-value">
        <code>{arg.value}</code>
        {sourceLabel && (
          <span className="catamorphic-detail-arg-source">
            from {sourceLabel}
          </span>
        )}
      </div>
    </div>
  );
}

const NODE_TYPE_LABELS: Record<string, string> = {
  trigger: "Trigger",
  step: "Step",
  branch: "Branch",
  "if-block": "Condition",
  "loop-block": "Loop",
  parallel: "Parallel",
  "parallel-block": "Parallel",
  "scope-block": "Block",
  "durable-boundary": "Retry scope",
  batch: "Batch processing",
  pause: "Waiting for input",
  "call-workflow": "Child Workflow",
  delay: "Delay",
  return: "Return",
};

const NODE_TYPE_COLORS: Record<string, string> = {
  trigger: "#ca8a04",
  step: "#2563eb",
  branch: "#a855f7",
  "if-block": "#a855f7",
  "loop-block": "#f97316",
  parallel: "#06b6d4",
  "parallel-block": "#06b6d4",
  "scope-block": "#94a3b8",
  "durable-boundary": "#94a3b8",
  batch: "#0d9488",
  pause: "#d97706",
  "call-workflow": "#6366f1",
  delay: "#737373",
  return: "#22c55e",
};

function NodeTypeTag({ type }: { type: string }) {
  const color = NODE_TYPE_COLORS[type] ?? "#737373";
  return (
    <span
      className="catamorphic-detail-type-tag"
      style={{ borderColor: color, color }}
    >
      {NODE_TYPE_LABELS[type] ?? type}
    </span>
  );
}

function BranchDetailsView({ node }: { node: WorkflowNode }) {
  const branchType =
    node.metadata?.branchType ?? (node.condition ? "if" : "else");
  const typeLabel =
    branchType === "if"
      ? "If Branch"
      : branchType === "else if"
        ? "Else If Branch"
        : "Else Branch";

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type="branch" />
      </div>

      <h3 className="catamorphic-detail-title">{typeLabel}</h3>

      {node.condition && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Condition</span>
          <p className="catamorphic-detail-pretty-condition">
            {prettyCondition(node.condition)}
          </p>
          <code className="catamorphic-detail-code-inline">
            {node.condition}
          </code>
        </div>
      )}

      {!node.condition && (
        <div className="catamorphic-detail-section">
          <p className="catamorphic-detail-description">
            Executes when no other branch condition is met.
          </p>
        </div>
      )}
    </div>
  );
}

function IfBlockDetailsView({
  node,
  allNodes,
}: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
}) {
  const branches = allNodes.filter(
    (n) => n.type === "branch" && n.parentId === node.id,
  );

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type="if-block" />
      </div>

      <h3 className="catamorphic-detail-title">Conditional Block</h3>
      <p className="catamorphic-detail-description">
        {branches.length} branch{branches.length !== 1 ? "es" : ""}
      </p>

      {branches.length > 0 && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Branches</span>
          <div className="catamorphic-detail-branch-list">
            {branches.map((b) => (
              <div key={b.id} className="catamorphic-detail-branch-item">
                <span className="catamorphic-detail-branch-type">
                  {b.metadata?.branchType ?? "if"}
                </span>
                <span className="catamorphic-detail-branch-cond">
                  {b.condition ? prettyCondition(b.condition) : "otherwise"}
                </span>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function BoundaryDetailsView({
  node,
  allNodes,
}: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
}) {
  const operations = allNodes.filter(
    (candidate) => candidate.parentId === node.id,
  );
  const maxAttempts = node.metadata["retry:maxAttempts"];
  const initialBackoff = node.metadata["retry:backoff.initial"];
  const maximumBackoff = node.metadata["retry:backoff.maximum"];
  const multiplier = node.metadata["retry:backoff.multiplier"];

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type="durable-boundary" />
        {node.metadata.icon && (
          <span className="catamorphic-detail-icon">{node.metadata.icon}</span>
        )}
      </div>
      <h3 className="catamorphic-detail-title">
        {node.label || "Retry scope"}
      </h3>
      <p className="catamorphic-detail-description">
        {node.description ??
          "One atomic checkpoint. A failed attempt reruns all work inside this boundary."}
      </p>
      {node.parameters && node.parameters.length > 0 && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Input</span>
          <div className="catamorphic-detail-params">
            {node.parameters.map((parameter) => (
              <ParamRow key={parameter.name} param={parameter} />
            ))}
          </div>
        </div>
      )}
      <div className="catamorphic-detail-section">
        <span className="catamorphic-detail-section-label">Operations</span>
        <p className="catamorphic-detail-description">
          {operations.length} visual operation
          {operations.length === 1 ? "" : "s"}
        </p>
      </div>
      {maxAttempts && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Retry policy</span>
          <p className="catamorphic-detail-description">
            Up to {maxAttempts} attempts
          </p>
          {(initialBackoff || maximumBackoff || multiplier) && (
            <code className="catamorphic-detail-code-inline">
              {[
                initialBackoff && `starts ${initialBackoff}`,
                maximumBackoff && `max ${maximumBackoff}`,
                multiplier && `x${multiplier}`,
              ]
                .filter(Boolean)
                .join(" · ")}
            </code>
          )}
        </div>
      )}
    </div>
  );
}

function BatchDetailsView({
  node,
  allNodes,
}: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
}) {
  const items = allNodes.filter((candidate) => candidate.parentId === node.id);
  const label =
    node.label && node.label !== "Batch" ? node.label : "Batch processing";

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type="batch" />
      </div>
      <h3 className="catamorphic-detail-title">{label}</h3>
      <p className="catamorphic-detail-description">
        {node.description ??
          "Processes a finite collection with per-item history and retries."}
      </p>
      <div className="catamorphic-detail-section">
        <span className="catamorphic-detail-section-label">Items flow</span>
        <p className="catamorphic-detail-description">
          {items.length} visual operation{items.length === 1 ? "" : "s"}
        </p>
      </div>
    </div>
  );
}

function NodeDetailsView({
  node,
  allNodes,
}: {
  node: WorkflowNode;
  allNodes: WorkflowNode[];
}) {
  if (node.type === "branch") return <BranchDetailsView node={node} />;
  if (node.type === "if-block")
    return <IfBlockDetailsView node={node} allNodes={allNodes} />;
  if (node.type === "durable-boundary") {
    return <BoundaryDetailsView node={node} allNodes={allNodes} />;
  }
  if (node.type === "batch") {
    return <BatchDetailsView node={node} allNodes={allNodes} />;
  }

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type={node.type} />
        {node.metadata?.icon && (
          <span className="catamorphic-detail-icon">{node.metadata.icon}</span>
        )}
      </div>

      <h3 className="catamorphic-detail-title">{node.label}</h3>

      {node.description && (
        <p className="catamorphic-detail-description">{node.description}</p>
      )}

      {(() => {
        const params = node.parameters ?? [];
        const args = node.arguments ?? [];
        const argMap = new Map(args.map((a) => [a.name, a]));
        const matchedArgNames = new Set(
          params.map((p) => p.name).filter((n) => argMap.has(n)),
        );
        const unmatchedArgs = args.filter((a) => !matchedArgNames.has(a.name));
        const hasItems = params.length > 0 || unmatchedArgs.length > 0;

        return (
          hasItems && (
            <div className="catamorphic-detail-section">
              <span className="catamorphic-detail-section-label">
                Parameters
              </span>
              <div className="catamorphic-detail-params">
                {params.map((p) => (
                  <ParamRow
                    key={p.name}
                    param={p}
                    argument={argMap.get(p.name)}
                  />
                ))}
                {unmatchedArgs.map((a) => (
                  <ArgumentOnlyRow key={a.name} arg={a} />
                ))}
              </div>
            </div>
          )
        );
      })()}

      {node.condition && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Condition</span>
          <code className="catamorphic-detail-code-inline">
            {node.condition}
          </code>
        </div>
      )}

      {node.loopIterable && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">
            Iterates over
          </span>
          <code className="catamorphic-detail-code-inline">
            {node.loopIterable}
          </code>
          {node.loopVariable && (
            <>
              <span
                className="catamorphic-detail-section-label"
                style={{ marginTop: 8 }}
              >
                Variable
              </span>
              <code className="catamorphic-detail-code-inline">
                {node.loopVariable}
              </code>
            </>
          )}
        </div>
      )}

      {node.duration && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Duration</span>
          <code className="catamorphic-detail-code-inline">
            {node.duration}
          </code>
        </div>
      )}

      {node.type === "pause" && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">
            Waiting for input
          </span>
          <p className="catamorphic-detail-description">
            {node.duration
              ? "Continues when input is submitted or when the timeout expires."
              : "Waits until the host submits input for this Run."}
          </p>
          {node.stateExpression && (
            <>
              <span className="catamorphic-detail-section-label">
                Persisted state
              </span>
              <code className="catamorphic-detail-code-inline">
                {node.stateExpression}
              </code>
            </>
          )}
        </div>
      )}

      {node.type === "call-workflow" && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">
            Child workflow
          </span>
          <code className="catamorphic-detail-code-inline">
            {node.workflowName}
          </code>
          {node.workflowInputExpression && (
            <>
              <span className="catamorphic-detail-section-label">Input</span>
              <code className="catamorphic-detail-code-inline">
                {node.workflowInputExpression}
              </code>
            </>
          )}
        </div>
      )}

      {node.returnExpression && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">Returns</span>
          <code className="catamorphic-detail-code-inline">
            {node.returnExpression}
          </code>
        </div>
      )}
    </div>
  );
}

function WorkflowOverview() {
  const graph = useAtomValue(graphAtom);
  if (!graph) return null;

  return (
    <div className="catamorphic-detail-content">
      <div className="catamorphic-detail-header-row">
        <NodeTypeTag type="trigger" />
      </div>
      <h3 className="catamorphic-detail-title">
        {graph.displayName ?? graph.name}
      </h3>
      {graph.description && (
        <p className="catamorphic-detail-description">{graph.description}</p>
      )}
      {graph.trigger.parameters.length > 0 && (
        <div className="catamorphic-detail-section">
          <span className="catamorphic-detail-section-label">
            Trigger Parameters
          </span>
          <div className="catamorphic-detail-params">
            {graph.trigger.parameters.map((p) => (
              <ParamRow key={p.name} param={p} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

export interface CodeEditorRenderProps {
  code: string;
  onChange: (code: string) => void;
  selectedNode: WorkflowNode | null;
  allNodes: WorkflowNode[];
  onSelectNode: (nodeId: string | null) => void;
  readOnly?: boolean;
}

export interface DetailPanelProps {
  renderCodeEditor?: (props: CodeEditorRenderProps) => ReactNode;
  code: string;
  onCodeChange: (code: string) => void;
  onExpandEditor?: () => void;
}

export function DetailPanel({
  renderCodeEditor,
  code,
  onCodeChange,
  onExpandEditor,
}: DetailPanelProps) {
  const [isOpen, setIsOpen] = useAtom(rightPanelOpenAtom);
  const [activeTab, setActiveTab] = useAtom(activePanelTabAtom);
  const selectedNode = useAtomValue(selectedNodeAtom);
  const graph = useAtomValue(graphAtom);
  const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
  const readOnly = useAtomValue(codeEditorReadOnlyAtom);

  if (!isOpen) return null;

  const tabs: { id: PanelTab; label: string }[] = [
    { id: "details", label: "Details" },
    { id: "code", label: "Code" },
  ];

  return (
    <div className="catamorphic-detail-panel">
      <div className="catamorphic-detail-panel-header">
        <div className="catamorphic-detail-tabs">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              className={`catamorphic-detail-tab ${activeTab === tab.id ? "catamorphic-detail-tab-active" : ""}`}
              onClick={() => setActiveTab(tab.id)}
            >
              {tab.label}
            </button>
          ))}
        </div>
        <div style={{ display: "flex", alignItems: "center", gap: 4 }}>
          {onExpandEditor && activeTab === "code" && (
            <button
              type="button"
              className="catamorphic-detail-close"
              onClick={onExpandEditor}
              aria-label="Expand editor"
              title="Open full project editor"
            >
              <svg
                width="14"
                height="14"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.5"
                strokeLinecap="round"
                strokeLinejoin="round"
                role="img"
                aria-label="Expand"
              >
                <polyline points="4 1 1 1 1 4" />
                <polyline points="12 15 15 15 15 12" />
                <line x1="1" y1="1" x2="6" y2="6" />
                <line x1="15" y1="15" x2="10" y2="10" />
              </svg>
            </button>
          )}
          <button
            type="button"
            className="catamorphic-detail-close"
            onClick={() => setIsOpen(false)}
            aria-label="Close panel"
          >
            ✕
          </button>
        </div>
      </div>

      <div className="catamorphic-detail-panel-body">
        {activeTab === "details" &&
          (selectedNode ? (
            <NodeDetailsView
              node={selectedNode}
              allNodes={graph?.nodes ?? []}
            />
          ) : (
            <WorkflowOverview />
          ))}
        {activeTab === "code" && (
          <div className="catamorphic-detail-code-panel">
            {renderCodeEditor ? (
              renderCodeEditor({
                code,
                onChange: onCodeChange,
                selectedNode,
                allNodes: graph?.nodes ?? [],
                onSelectNode: setSelectedNodeId,
                readOnly,
              })
            ) : (
              <textarea
                className="catamorphic-code-textarea"
                value={code}
                readOnly={readOnly}
                onChange={(e) => onCodeChange(e.target.value)}
                spellCheck={false}
              />
            )}
          </div>
        )}
      </div>
    </div>
  );
}
