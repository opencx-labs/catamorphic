import { graphAtom, selectedNodeIdAtom } from "@catamorphic/react";
import type {
  ParameterInfo,
  StepArgument,
  WorkflowNode,
} from "@catamorphic/react/types";
import {
  formatDefaultValue,
  friendlyParamName,
  friendlyType,
} from "@catamorphic/ui";
import { useAtomValue, useSetAtom } from "jotai";
import { ChevronRight, Code2, MessageSquare } from "lucide-react";
import { type ReactNode, useId, useState } from "react";
import { Collapsible } from "./collapsible.js";

const labels: Record<string, string> = {
  input: "Start",
  step: "Step",
  branch: "Path",
  "if-block": "Decision",
  "loop-block": "Repeat",
  parallel: "Concurrent work",
  "parallel-block": "Concurrent work",
  "scope-block": "Group",
  "durable-boundary": "Retry together",
  batch: "Process a collection",
  source: "Get items",
  sink: "Collect results",
  pause: "Wait for input",
  "call-workflow": "Run another workflow",
  delay: "Wait",
  return: "Result",
};
const explanations: Record<string, string> = {
  input: "The information supplied when this workflow starts.",
  "durable-boundary":
    "If a step in this group fails, all the work in the group retries together. Completed groups are kept.",
  batch:
    "Works through a collection in pages. Each item has its own progress and retry history.",
  pause:
    "Waits for a response before continuing. Progress is saved while it waits.",
  "call-workflow": "Starts another workflow and continues with its result.",
  "if-block":
    "Chooses a path based on the information available at this point.",
  "loop-block": "Repeats the steps inside for each item.",
  "parallel-block":
    "Runs these branches concurrently, then continues when they finish.",
  return: "The information this part of the workflow produces.",
};

/** A trigger in words: its kind's label, and when a schedule fires. */
export function triggerSummary(trigger: {
  kind: string;
  config: unknown;
  display?: { label?: string } | null;
}): string {
  const label = trigger.display?.label ?? friendlyParamName(trigger.kind);
  const config =
    trigger.config && typeof trigger.config === "object" ? trigger.config : {};
  if (
    trigger.kind === "schedule" &&
    "at" in config &&
    typeof config.at === "string"
  ) {
    const at = new Date(config.at);
    return Number.isNaN(at.getTime())
      ? label
      : `Once, ${at.toLocaleString([], { dateStyle: "medium", timeStyle: "short" })}`;
  }
  if (
    trigger.kind === "schedule" &&
    "cron" in config &&
    typeof config.cron === "string"
  )
    return `${label}: ${config.cron}${"timezone" in config && typeof config.timezone === "string" ? ` (${config.timezone})` : ""}`;
  return label;
}

export function WorkflowSection({
  title,
  children,
}: {
  title: string;
  children: ReactNode;
}) {
  return (
    <section className="workflow-detail-section">
      <h3>{title}</h3>
      {children}
    </section>
  );
}

export function WorkflowParameters({
  parameters,
  arguments: args = [],
}: {
  parameters: ParameterInfo[];
  arguments?: StepArgument[];
}) {
  const names = new Set(parameters.map((param) => param.name));
  const rows: Array<{ param: ParameterInfo; argument?: StepArgument }> = [
    ...parameters.map((param) => ({
      param,
      argument: args.find((arg) => arg.name === param.name),
    })),
    ...args
      .filter((arg) => !names.has(arg.name))
      .map((argument) => ({
        param: {
          name: argument.name,
          displayName: argument.displayName,
          type: "",
          optional: false,
        },
        argument,
      })),
  ];
  return (
    <dl className="workflow-parameters">
      {rows.map(({ param, argument }) => {
        const source = argument?.source;
        return (
          <div key={param.name}>
            <dt>
              <span>{param.displayName ?? friendlyParamName(param.name)}</span>
              <span className="text-fg-faint font-normal">
                {param.optional
                  ? "Optional"
                  : param.type
                    ? friendlyType(param.type)
                    : ""}
              </span>
            </dt>
            {param.description && (
              <dd className="text-fg-muted">{param.description}</dd>
            )}
            {source ? (
              <dd className="text-fg-muted">
                From{" "}
                {source.variableDisplayName ??
                  source.stepLabel ??
                  friendlyParamName(source.variable)}
              </dd>
            ) : (
              argument && (
                <dd className="workflow-expression">
                  {formatDefaultValue(argument.value)}
                </dd>
              )
            )}
            {"defaultValue" in param && param.defaultValue != null && (
              <dd className="text-fg-muted">
                Default: {formatDefaultValue(param.defaultValue)}
              </dd>
            )}
          </div>
        );
      })}
    </dl>
  );
}

function TechnicalDetails({ node }: { node: WorkflowNode }) {
  const [open, setOpen] = useState(false);
  const contentId = useId();
  const values = [
    ["Condition", node.condition],
    ["Collection", node.loopIterable],
    ["Item variable", node.loopVariable],
    ["Wait", node.duration],
    ["Saved state", node.stateExpression],
    ["Workflow", node.workflowName],
    ["Workflow input", node.workflowInputExpression],
    ["Result", node.returnExpression],
    ...Object.entries(node.metadata)
      .filter(([key]) => key.startsWith("retry:"))
      .map(([key, value]) => [
        friendlyParamName(key.replace("retry:", "")),
        value,
      ]),
  ].filter((entry) => entry[1]);
  if (
    values.length === 0 &&
    !node.arguments?.length &&
    !node.triggerBindings?.length
  )
    return null;
  return (
    <div className="workflow-technical">
      <button
        type="button"
        className="workflow-text-action"
        aria-expanded={open}
        aria-controls={contentId}
        onClick={() => setOpen(!open)}
      >
        <ChevronRight
          className={`size-3 transition-transform duration-200 ease-[cubic-bezier(0.2,0,0,1)] ${open ? "rotate-90" : ""}`}
        />
        Technical details
      </button>
      <Collapsible open={open}>
        <div id={contentId} className="space-y-3 pt-3">
          {values.map(([label, value]) => (
            <div key={label}>
              <p>{label}</p>
              <pre>{value}</pre>
            </div>
          ))}
          {node.arguments?.map((arg) => (
            <div key={arg.name}>
              <p>{arg.displayName ?? friendlyParamName(arg.name)}</p>
              <pre>{arg.value}</pre>
            </div>
          ))}
          {node.triggerBindings?.map((binding) => (
            <div key={`${binding.kind}:${JSON.stringify(binding.config)}`}>
              <p>{binding.display?.label ?? binding.kind}</p>
              <pre>{JSON.stringify(binding.config, null, 2)}</pre>
            </div>
          ))}
        </div>
      </Collapsible>
    </div>
  );
}

/** The selected step: what it does, what it uses, and how to change it. */
export function WorkflowStepDetails({
  node,
  onCode,
  canEdit,
  onAskAgent,
}: {
  node: WorkflowNode;
  onCode: () => void;
  canEdit: boolean;
  onAskAgent: (node: WorkflowNode) => void;
}) {
  const graph = useAtomValue(graphAtom);
  const select = useSetAtom(selectedNodeIdAtom);
  const children =
    graph?.nodes.filter((child) => child.parentId === node.id) ?? [];
  return (
    <div className="workflow-detail-body" data-testid="workflow-details">
      <h2 className="text-base font-semibold leading-snug text-fg">
        {stepTitle(node)}
      </h2>
      <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
        {node.description ??
          node.metadata.description ??
          (node.type === "input" ? graph?.description : undefined) ??
          explanations[node.type] ??
          "Open the code to see how this step works, or describe a change to your agent."}
      </p>
      <div className="mt-4 flex flex-wrap gap-2">
        <button
          type="button"
          className="workflow-secondary"
          aria-disabled={!canEdit}
          data-disabled-reason={
            canEdit ? undefined : "Only project builders can change workflows"
          }
          onClick={() => {
            if (canEdit) onAskAgent(node);
          }}
        >
          <MessageSquare className="size-3.5" /> Describe a change
        </button>
        <button type="button" className="workflow-secondary" onClick={onCode}>
          <Code2 className="size-3.5" /> View code
        </button>
      </div>
      {node.type !== "input" &&
      (node.parameters?.length || node.arguments?.length) ? (
        <WorkflowSection title="Information used">
          <WorkflowParameters
            parameters={node.parameters ?? []}
            arguments={node.arguments}
          />
        </WorkflowSection>
      ) : null}
      {node.type === "input" && (
        <WorkflowSection title="Starting information">
          {graph?.input.parameters.length ? (
            <WorkflowParameters parameters={graph.input.parameters} />
          ) : (
            <p className="text-fg-muted">
              No information is required to start.
            </p>
          )}
        </WorkflowSection>
      )}
      {node.type === "input" && (
        <WorkflowSection title="When it runs">
          <p className="text-fg-muted">
            {node.triggerBindings?.length
              ? "When you or an app runs it, and automatically when these triggers fire once automatic runs are on."
              : "When you or an app runs it."}
          </p>
          {node.triggerBindings?.map((binding) => (
            <p
              className="mt-2"
              key={`${binding.kind}:${JSON.stringify(binding.config)}`}
            >
              {triggerSummary(binding)}
            </p>
          ))}
        </WorkflowSection>
      )}
      {node.type === "durable-boundary" &&
        node.metadata["retry:maxAttempts"] && (
          <WorkflowSection title="On failure">
            <p>Tries up to {node.metadata["retry:maxAttempts"]} times.</p>
          </WorkflowSection>
        )}
      {node.type === "pause" && (
        <WorkflowSection title="When it continues">
          <p className="text-fg-muted">
            {node.duration
              ? `After a response, or after ${formatDefaultValue(node.duration)}.`
              : "When a response is submitted from the run details."}
          </p>
        </WorkflowSection>
      )}
      {children.length > 0 && (
        <WorkflowSection title="Inside this group">
          <div className="workflow-outline">
            {children.map((child) => (
              <button
                type="button"
                key={child.id}
                onClick={() => select(child.id)}
              >
                <span>{child.label || labels[child.type]}</span>
                <ChevronRight className="size-3 shrink-0 text-fg-faint" />
              </button>
            ))}
          </div>
        </WorkflowSection>
      )}
      <TechnicalDetails node={node} />
    </div>
  );
}

/** The kind of thing a node is, in words ("Step", "Decision", …). */
export function stepKind(node: WorkflowNode): string {
  return labels[node.type] ?? "Step";
}

export function stepTitle(node: WorkflowNode): string {
  if (node.type === "input") return "How it starts";
  return node.type === "durable-boundary" && !node.label
    ? "Retry together"
    : node.label || stepKind(node);
}
