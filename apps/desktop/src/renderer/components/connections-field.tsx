import type {
  AgentConnectionsSetting,
  ConnectionInfo,
} from "../lib/desktop-api.js";

/**
 * Per-agent MCP connection assignment: every current and future connection
 * (the default), or a pinned subset of the profile's connections. Shared
 * by the agent wizard (create) and Settings (edit).
 */
export function ConnectionsAssignmentField({
  value,
  onChange,
  available,
}: {
  value: AgentConnectionsSetting;
  onChange: (next: AgentConnectionsSetting) => void;
  available: ConnectionInfo[];
}) {
  const pickedIds = value.mode === "picked" ? value.connectionIds : [];
  return (
    <div className="flex flex-col gap-1 text-xs text-fg-muted">
      Connections
      <select
        value={value.mode}
        onChange={(event) =>
          onChange(
            event.target.value === "all"
              ? { mode: "all" }
              : {
                  mode: "picked",
                  connectionIds:
                    value.mode === "picked"
                      ? value.connectionIds
                      : available.map((connection) => connection.id),
                },
          )
        }
        className="field h-8 px-2 text-[13px] text-fg"
        data-testid="agent-connections-mode"
      >
        <option value="all">All connections (including future ones)</option>
        <option value="picked">Choose specific connections</option>
      </select>
      {value.mode === "picked" && (
        <div className="mt-1 flex flex-col gap-1 rounded-md border border-border bg-bg-inset p-2">
          {available.map((connection) => (
            <label
              key={connection.id}
              className="flex cursor-pointer items-center gap-2 text-[12px] text-fg"
            >
              <input
                type="checkbox"
                checked={pickedIds.includes(connection.id)}
                onChange={(event) =>
                  onChange({
                    mode: "picked",
                    connectionIds: event.target.checked
                      ? [...pickedIds, connection.id]
                      : pickedIds.filter((id) => id !== connection.id),
                  })
                }
              />
              <span className="truncate">{connection.name}</span>
              <span className="ml-auto shrink-0 text-[11px] text-fg-faint">
                {connection.transport}
              </span>
            </label>
          ))}
        </div>
      )}
    </div>
  );
}
