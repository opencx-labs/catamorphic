import { ChevronRight, Loader2, Workflow } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import {
  type AgentConnectionsSetting,
  type AgentHarness,
  type ConnectionInfo,
  desktopApi,
  type McpToolPolicy,
  type ToolAnnotations,
  type ToolPermission,
} from "../lib/desktop-api.js";
import {
  agentLayer,
  PERMISSION_LABELS as LABEL,
  resolveAcross,
  resolveToolPermission,
  stricterPermission as stricter,
} from "../lib/tool-policy.js";
import { ConnectorIcon } from "./connectors-modal.js";
import { Segmented } from "./segmented.js";

/**
 * Per-agent tool access — the agent's own layer over the profile's
 * connection permissions (ADR 0054). Two facts drive the whole control:
 *
 * - Layers INTERSECT: an agent can narrow what a connection allows (Ask,
 *   Off), never widen it. So the agent's choices are Inherit / Ask / Off,
 *   and every row shows what the answer will actually be after the
 *   connection's own rule ("ceiling") is applied.
 * - The project's workflow tools are a server of their own (`catamorphic`,
 *   mounted per session), unrestricted by default; here an agent can be
 *   confined to specific workflows, or made to ask.
 *
 * Shared by the agent wizard (create) and Settings (edit). Edits are
 * plain values (`Record<connectionId | "catamorphic", McpToolPolicy>`) —
 * the caller saves them with the agent.
 */

/** Server key of the per-project workflow-tools server (mirrors main). */
export const WORKFLOWS_POLICY_KEY = "catamorphic";

interface ToolLike {
  name: string;
  description: string;
  annotations?: ToolAnnotations;
}

/** The connection side's answer for a tool: provisioner ceiling ∩ own policy. */
function ceilingFor(
  ceiling: Array<McpToolPolicy | undefined>,
  tool: ToolLike,
): ToolPermission {
  return resolveAcross(ceiling, tool.name, tool.annotations);
}

/** The agent's answer for a tool: its rule, its default, else no opinion. */
function agentAnswer(
  policy: McpToolPolicy | undefined,
  toolName: string,
): ToolPermission {
  return resolveToolPermission(agentLayer(policy), toolName);
}

function isNarrowed(policy: McpToolPolicy | undefined): boolean {
  if (!policy) return false;
  if (policy.default && policy.default !== "allow" && policy.default !== "auto")
    return true;
  return Object.keys(policy.tools ?? {}).length > 0;
}

/** Drop the agent's policy when it says nothing (no rules, default open). */
function normalizeAgentPolicy(policy: McpToolPolicy): McpToolPolicy | null {
  const tools = Object.fromEntries(
    Object.entries(policy.tools ?? {}).filter(([, value]) => value),
  );
  const next: McpToolPolicy = {
    ...(policy.default &&
    policy.default !== "allow" &&
    policy.default !== "auto"
      ? { default: policy.default }
      : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}

export function AgentToolPolicyField({
  value,
  onChange,
  connections,
  assignment,
  harness,
  projectId,
}: {
  value: Record<string, McpToolPolicy>;
  onChange: (next: Record<string, McpToolPolicy>) => void;
  /** The profile's connections (the editor filters to the assigned ones). */
  connections: ConnectionInfo[];
  assignment: AgentConnectionsSetting;
  harness: AgentHarness;
  /** The current project — its workflow tools are listed when known. */
  projectId?: string;
}) {
  const assigned = useMemo(
    () =>
      assignment.mode === "all"
        ? connections
        : connections.filter((connection) =>
            assignment.connectionIds.includes(connection.id),
          ),
    [connections, assignment],
  );
  const [expanded, setExpanded] = useState<string | null>(null);
  const setPolicy = (key: string, policy: McpToolPolicy | null) => {
    const { [key]: _drop, ...rest } = value;
    onChange(policy ? { ...rest, [key]: policy } : rest);
  };

  // The project's workflow tools, fetched once per project for the
  // "Project workflows" section.
  const [workflowTools, setWorkflowTools] = useState<ToolLike[] | null>(null);
  useEffect(() => {
    if (!projectId) return;
    let cancelled = false;
    void desktopApi
      .projectWorkflowTools(projectId)
      .then((tools) => {
        if (!cancelled) setWorkflowTools(tools);
      })
      .catch(() => {
        if (!cancelled) setWorkflowTools([]);
      });
    return () => {
      cancelled = true;
    };
  }, [projectId]);

  const narrowedCount =
    assigned.filter((connection) => isNarrowed(value[connection.id])).length +
    (isNarrowed(value[WORKFLOWS_POLICY_KEY]) ? 1 : 0);

  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      <div className="flex items-baseline justify-between">
        <span>Tool access</span>
        <span
          className="text-[11px] text-fg-faint"
          data-testid="agent-tool-policy-summary"
        >
          {narrowedCount === 0
            ? "Follows each connection's permissions"
            : `Narrowed on ${narrowedCount}`}
        </span>
      </div>
      <div
        className="flex flex-col divide-y divide-border rounded-md border border-border bg-bg-inset"
        data-testid="agent-tool-policy"
      >
        {assigned.map((connection) => (
          <PolicyRow
            key={connection.id}
            id={connection.id}
            icon={
              <ConnectorIcon
                iconUrl={connection.iconUrl}
                name={connection.name}
              />
            }
            title={connection.name}
            subtitle={`MCP · ${connection.transport}`}
            tools={connection.tools ?? []}
            emptyHint="No tool list yet — Test the connection in Connectors to fetch it."
            ceiling={[connection.ceiling?.policy, connection.toolPolicy]}
            ceilingSource={connection.ceiling?.source}
            policy={value[connection.id]}
            expanded={expanded === connection.id}
            onToggle={() =>
              setExpanded(expanded === connection.id ? null : connection.id)
            }
            onChange={(policy) => setPolicy(connection.id, policy)}
          />
        ))}
        <PolicyRow
          id={WORKFLOWS_POLICY_KEY}
          icon={
            <span className="grid size-6 shrink-0 place-items-center rounded border border-border bg-bg-inset">
              <Workflow className="size-3 text-fg-faint" />
            </span>
          }
          title="Workflows"
          subtitle={
            workflowTools === null
              ? projectId
                ? "Listing this project's…"
                : "This project's AI-callable workflows"
              : `${workflowTools.length} in this project`
          }
          tools={workflowTools ?? []}
          emptyHint={
            projectId
              ? "This project has no AI-callable workflows yet (ai.tool-call triggers)."
              : "Open an agent from inside a project to list its workflows."
          }
          // No connection ceiling: the agent's word is the whole answer.
          ceiling={[{ default: "allow" }]}
          policy={value[WORKFLOWS_POLICY_KEY]}
          expanded={expanded === WORKFLOWS_POLICY_KEY}
          onToggle={() =>
            setExpanded(
              expanded === WORKFLOWS_POLICY_KEY ? null : WORKFLOWS_POLICY_KEY,
            )
          }
          onChange={(policy) => setPolicy(WORKFLOWS_POLICY_KEY, policy)}
          loading={projectId !== undefined && workflowTools === null}
          openLabel="Allow"
        />
      </div>
      <p className="text-[11px] text-fg-faint">
        An agent can narrow a connection's permissions (Ask, Off), never widen
        them; each row shows the answer after both apply.
        {harness === "codex" && " Codex agents can't ask — Ask means Off."}
      </p>
    </div>
  );
}

function PolicyRow({
  id,
  icon,
  title,
  subtitle,
  tools,
  emptyHint,
  ceiling,
  ceilingSource,
  policy,
  expanded,
  onToggle,
  onChange,
  loading = false,
  openLabel = "Inherit",
}: {
  id: string;
  icon: React.ReactNode;
  title: string;
  subtitle: string;
  tools: ToolLike[];
  emptyHint: string;
  ceiling: Array<McpToolPolicy | undefined>;
  /** Who set a provisioner ceiling, when one exists (shown read-only). */
  ceilingSource?: string;
  policy: McpToolPolicy | undefined;
  expanded: boolean;
  onToggle: () => void;
  onChange: (policy: McpToolPolicy | null) => void;
  loading?: boolean;
  /** Label of the "no narrowing" choice: Inherit under a connection,
   * Allow where the agent's word is the whole answer (workflows). */
  openLabel?: string;
}) {
  const agentDefault: ToolPermission | "inherit" =
    policy?.default && policy.default !== "allow" && policy.default !== "auto"
      ? policy.default
      : "inherit";
  const setDefault = (next: string) =>
    onChange(
      normalizeAgentPolicy({
        ...policy,
        default: next === "inherit" ? undefined : (next as ToolPermission),
      }),
    );
  const setTool = (name: string, next: string) => {
    const tools = { ...policy?.tools };
    if (next === "inherit") delete tools[name];
    else tools[name] = next as ToolPermission;
    onChange(normalizeAgentPolicy({ ...policy, tools }));
  };
  const narrowed = isNarrowed(policy);
  const ruleCount = Object.keys(policy?.tools ?? {}).length;
  return (
    <div className="flex flex-col" data-testid="agent-policy-row" data-key={id}>
      <div className="flex items-center gap-2 px-2 py-1.5">
        <button
          type="button"
          onClick={onToggle}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
          aria-expanded={expanded}
        >
          <ChevronRight
            className={`size-3 shrink-0 text-fg-faint transition-transform duration-150 ${expanded ? "rotate-90" : ""}`}
          />
          {icon}
          <span className="min-w-0">
            <span className="block truncate text-[12px] text-fg">{title}</span>
            <span className="block truncate text-[10px] text-fg-faint">
              {subtitle}
              {ceilingSource && ` · ceiling set by ${ceilingSource}`}
              {ruleCount > 0 &&
                ` · ${ruleCount} rule${ruleCount === 1 ? "" : "s"}`}
            </span>
          </span>
        </button>
        <span
          className={`shrink-0 text-[10px] ${narrowed ? "text-warning" : "text-fg-faint"}`}
        >
          {narrowed
            ? "Narrowed"
            : openLabel === "Inherit"
              ? "Inherits"
              : "Open"}
        </span>
        <Segmented
          value={agentDefault}
          options={[
            {
              value: "inherit",
              label: openLabel,
              title:
                openLabel === "Inherit"
                  ? "Follow the connection's permissions"
                  : "No restriction",
            },
            { value: "ask", label: "Ask" },
            { value: "deny", label: "Off" },
          ]}
          onChange={setDefault}
          testId={`agent-policy-default-${id}`}
        />
      </div>
      {expanded && (
        <div className="border-t border-border/60 px-2 py-1.5">
          {loading ? (
            <p className="flex items-center gap-1.5 text-[11px] text-fg-faint">
              <Loader2 className="size-3 animate-spin" />
              Listing tools…
            </p>
          ) : tools.length === 0 ? (
            <p className="text-[11px] text-fg-faint">{emptyHint}</p>
          ) : (
            <ul className="flex flex-col gap-1">
              {tools.map((tool) => {
                const ceilingAnswer = ceilingFor(ceiling, tool);
                const explicit = policy?.tools?.[tool.name];
                const effective = stricter(
                  ceilingAnswer,
                  agentAnswer(policy, tool.name),
                );
                return (
                  <li
                    key={tool.name}
                    className="flex items-center gap-2"
                    data-tool={tool.name}
                    data-effective={effective}
                  >
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate font-mono text-[11px] text-fg">
                          {tool.name}
                        </span>
                        {tool.annotations?.readOnlyHint ? (
                          <span className="shrink-0 text-[10px] text-fg-faint">
                            read-only
                          </span>
                        ) : tool.annotations?.destructiveHint ? (
                          <span className="shrink-0 text-[10px] text-danger/80">
                            destructive
                          </span>
                        ) : null}
                      </div>
                      {tool.description && (
                        <p className="truncate text-[11px] text-fg-faint">
                          {tool.description}
                        </p>
                      )}
                    </div>
                    {/* The connection's own answer, so the user sees what
                        Inherit resolves to and why Ask/Off might already
                        be the ceiling. */}
                    <span
                      className={`w-14 shrink-0 text-right text-[10px] ${
                        effective === "deny"
                          ? "text-danger/80"
                          : effective === "ask"
                            ? "text-warning"
                            : "text-fg-faint"
                      }`}
                      title={`Connection: ${LABEL[ceilingAnswer]}`}
                    >
                      → {LABEL[effective]}
                    </span>
                    <Segmented
                      value={explicit ?? "inherit"}
                      options={[
                        { value: "inherit", label: openLabel },
                        { value: "ask", label: "Ask" },
                        { value: "deny", label: "Off" },
                      ]}
                      onChange={(next) => setTool(tool.name, next)}
                    />
                  </li>
                );
              })}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
