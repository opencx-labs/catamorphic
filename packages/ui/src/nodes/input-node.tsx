import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import type { CSSProperties } from "react";
import { NodeIcon } from "./node-icon.js";

export function InputNode({ data }: NodeProps) {
  const node = data as unknown as WorkflowNode & { executionStatus?: string };
  const bindings = node.triggerBindings ?? [];
  return (
    <div
      className="catamorphic-node catamorphic-input-node"
      data-execution-status={node.executionStatus}
    >
      <Handle type="source" position={Position.Bottom} />
      {node.executionStatus && (
        <span
          className="catamorphic-node-exec-indicator"
          data-status={node.executionStatus}
        />
      )}
      <div className="catamorphic-node-icon">⚡</div>
      <div className="catamorphic-node-content">
        <div className="catamorphic-node-label">{node.label}</div>
        {bindings.length > 0 && (
          <div className="catamorphic-node-triggers">
            {bindings.map((binding) => (
              <span
                key={`${binding.kind}:${JSON.stringify(binding.config)}`}
                className="catamorphic-trigger-badge"
                style={
                  binding.display?.color
                    ? ({
                        "--catamorphic-trigger-accent": binding.display.color,
                      } as CSSProperties)
                    : undefined
                }
              >
                <span className="catamorphic-trigger-badge-icon">
                  <NodeIcon name={binding.display?.icon ?? "zap"} />
                </span>
                {binding.display?.label ?? binding.kind}
              </span>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}
