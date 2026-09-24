import type { WorkflowNode } from "@catamorphic/parser";
import { Handle, type NodeProps, Position } from "@xyflow/react";
import { Zap } from "lucide-react";
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
      <div className="catamorphic-node-icon">
        <Zap aria-hidden="true" size={18} strokeWidth={1.8} />
      </div>
      <div className="catamorphic-node-content">
        {/* The workflow's name belongs to its tab or title; the graph's
          first node is where it starts. */}
        <div className="catamorphic-node-label">Start</div>
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
