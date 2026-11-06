import { Loader2, ShieldCheck } from "lucide-react";
import type {
  ConnectionInfo,
  McpToolPolicy,
  ToolPermission,
} from "../lib/desktop-api";
import {
  describePolicy,
  PERMISSION_LABELS,
  resolveAcross,
} from "../lib/tool-policy";
import { Segmented } from "./segmented";

/**
 * Per-connection tool permissions: the profile's ceiling for this
 * connection (agents can only narrow it). A default for the roster
 * ("Agent" follows each agent's operating mode) and a per-tool override;
 * the roster is what the last probe listed, so an unprobed connection
 * offers to fetch it. Every change saves immediately.
 */
export function ConnectionPermissions({
  connection,
  onChange,
  onProbe,
  probing,
}: {
  connection: ConnectionInfo;
  onChange: (policy: McpToolPolicy | null) => void;
  onProbe: () => void;
  probing: boolean;
}) {
  const policy = connection.toolPolicy ?? {};
  const tools = connection.tools ?? [];
  const setDefault = (value: ToolPermission | "auto" | "agent") =>
    onChange(
      normalizePolicy({
        ...policy,
        default: value === "agent" ? undefined : value,
      }),
    );
  const setTool = (name: string, value: ToolPermission | "default") => {
    const next = { ...policy.tools };
    if (value === "default") delete next[name];
    else next[name] = value;
    onChange(normalizePolicy({ ...policy, tools: next }));
  };
  // Effective = provisioner ceiling (when one exists) ∩ this policy, the
  // same math the harness does, so the label never lies.
  const ceiling = connection.ceiling?.policy;
  const resolved = (tool: (typeof tools)[number]): ToolPermission =>
    resolveAcross(
      [ceiling, { default: "allow", ...policy }],
      tool.name,
      tool.annotations,
    );
  return (
    <div className="flex flex-col" data-testid="tool-policy-editor">
      {connection.ceiling && (
        <p
          className="mb-3 flex items-start gap-2 rounded-lg bg-bg-inset px-3 py-2 text-xs/5 text-fg-muted"
          data-testid="tool-policy-ceiling"
        >
          <ShieldCheck className="h-lh size-3.5 shrink-0 text-fg-faint" />
          <span className="min-w-0">
            Ceiling set by{" "}
            <span className="text-fg">{connection.ceiling.source}</span>:{" "}
            {describePolicy(connection.ceiling.policy)}. Your rules can only
            narrow it.
          </span>
        </p>
      )}
      <div className="flex items-start gap-4 pb-3">
        <div className="min-w-0 flex-1">
          <p className="text-[13px] text-fg">Tools without a rule</p>
          <p className="mt-0.5 text-xs/5 text-pretty text-fg-muted">
            Agent follows each agent's operating mode: full access allows tools,
            restricted modes ask about writes. Auto runs read-only tools and
            asks about the rest.
          </p>
        </div>
        <Segmented
          value={policy.default ?? "agent"}
          options={[
            { value: "agent", label: "Agent" },
            { value: "auto", label: "Auto" },
            { value: "allow", label: "Allow" },
            { value: "ask", label: "Ask" },
            { value: "deny", label: "Off" },
          ]}
          onChange={(value) =>
            setDefault(value as ToolPermission | "auto" | "agent")
          }
          testId="tool-policy-default"
        />
      </div>
      {tools.length === 0 ? (
        <div className="flex h-11 items-center gap-2 border-t border-border text-xs text-fg-faint">
          {probing ? (
            <>
              <Loader2 className="size-3.5 animate-spin" />
              Listing tools…
            </>
          ) : (
            <>
              No tool list yet.
              <button
                type="button"
                onClick={onProbe}
                className="cursor-pointer text-fg-muted underline-offset-2 hover:text-fg hover:underline"
              >
                Fetch the server's tools
              </button>
            </>
          )}
        </div>
      ) : (
        <ul
          className="divide-y divide-border border-t border-border"
          data-testid="tool-policy-tools"
        >
          {tools.map((tool) => {
            const explicit = policy.tools?.[tool.name];
            const effective = resolved(tool);
            return (
              <li
                key={tool.name}
                className="flex items-center gap-4 py-2.5"
                data-tool={tool.name}
                data-effective={
                  !explicit && !policy.default && !ceiling ? "agent" : effective
                }
              >
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline gap-2">
                    <p className="truncate font-mono text-xs text-fg">
                      {tool.name}
                    </p>
                    {tool.annotations?.readOnlyHint ? (
                      <p className="shrink-0 text-[11px] text-fg-faint">
                        read-only
                      </p>
                    ) : tool.annotations?.destructiveHint ? (
                      <p className="shrink-0 text-[11px] text-danger">
                        destructive
                      </p>
                    ) : null}
                  </div>
                  {tool.description && (
                    <p className="mt-0.5 truncate text-xs text-fg-muted">
                      {tool.description}
                    </p>
                  )}
                </div>
                <Segmented
                  value={explicit ?? "default"}
                  options={[
                    {
                      value: "default",
                      label: explicit
                        ? "Default"
                        : !policy.default && !ceiling
                          ? "Agent ·"
                          : `${PERMISSION_LABELS[effective]} ·`,
                    },
                    { value: "allow", label: "Allow" },
                    { value: "ask", label: "Ask" },
                    { value: "deny", label: "Off" },
                  ]}
                  onChange={(value) =>
                    setTool(tool.name, value as ToolPermission | "default")
                  }
                />
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

/** Preserve explicit Auto; an absent default follows the agent mode. */
function normalizePolicy(policy: McpToolPolicy): McpToolPolicy | null {
  const tools = Object.fromEntries(
    Object.entries(policy.tools ?? {}).filter(([, value]) => value),
  );
  const next: McpToolPolicy = {
    ...(policy.default ? { default: policy.default } : {}),
    ...(Object.keys(tools).length > 0 ? { tools } : {}),
  };
  return Object.keys(next).length > 0 ? next : null;
}
