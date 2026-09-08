import { useEnvironments, useUpdateAgentSession } from "@catamorphic/react";
import { useState } from "react";
import { PendingButton } from "./pending-button.js";

/** Moving creates a new Allocation; selecting an option alone never moves work. */
export function AgentEnvironmentControl({
  projectId,
  sessionId,
  agentId,
  currentEnvironment,
  busy,
}: {
  projectId: string;
  sessionId: string;
  agentId?: string;
  currentEnvironment?: string;
  busy: boolean;
}) {
  const environments = useEnvironments(projectId, {
    workload: "agent",
    agentId,
  });
  const update = useUpdateAgentSession(projectId);
  const [selected, setSelected] = useState<string>();
  const environment =
    selected ?? currentEnvironment ?? environments.data?.defaultEnvironment;
  const target = environments.data?.items.find(
    (item) => item.name === environment,
  );
  return (
    <div className="space-y-2 text-xs">
      <div className="flex flex-wrap items-center gap-2">
        <span>
          Running on{" "}
          {environments.data?.items.find(
            (item) => item.name === currentEnvironment,
          )?.label ??
            currentEnvironment ??
            "assigned environment"}
        </span>
        <label>
          Move to{" "}
          <select
            aria-label="Move agent to environment"
            value={environment ?? ""}
            disabled={busy || update.isPending}
            onChange={(event) => setSelected(event.target.value)}
            className="rounded border border-border bg-bg-inset p-1"
          >
            {environments.data?.items
              .filter((item) => item.allowed)
              .map((item) => (
                <option
                  key={item.name}
                  value={item.name}
                  disabled={!item.available || !item.compatible}
                >
                  {item.label}
                  {item.reasons.length ? ` (${item.reasons.join("; ")})` : ""}
                </option>
              ))}
          </select>
        </label>
        <PendingButton
          type="button"
          pending={update.isPending}
          disabled={busy || !target?.available || !target.compatible}
          className="rounded border border-border px-2 py-1 disabled:opacity-50"
          onClick={() => {
            if (environment)
              void update
                .mutateAsync({ sessionId, environment })
                .catch(() => {});
          }}
        >
          Move session
        </PendingButton>
      </div>
      {busy && (
        <p className="text-fg-muted">
          Finish or interrupt the current turn before moving.
        </p>
      )}
      {(update.error || environments.error) && (
        <p role="alert" className="text-danger">
          {update.error?.message ?? environments.error?.message}
        </p>
      )}
      {update.isSuccess && (
        <p role="status" className="text-fg-muted">
          Moved. The next turn continues from the saved history and checkpoint.
        </p>
      )}
    </div>
  );
}
