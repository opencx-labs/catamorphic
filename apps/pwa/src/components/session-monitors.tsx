import { useWatchers } from "@catamorphic/react";

/** Session-owned execution stays inspectable even when it produces no message. */
export function SessionMonitors({
  projectId,
  sessionId,
  onOpen,
}: {
  projectId: string;
  sessionId?: string;
  onOpen: (kind: "run" | "artifact", id: string) => void;
}) {
  const query = useWatchers(projectId, sessionId);
  const items = query.data?.items ?? [];
  if (query.error)
    return (
      <p role="alert" className="px-4 py-2 text-sm text-danger">
        Could not load session monitors: {query.error.message}
      </p>
    );
  if (!items.length) return null;
  const failures = items.filter(
    (item) => item.lastRun?.status === "failed" || item.lastError,
  ).length;
  return (
    <details
      className="shrink-0 border-b border-border text-sm"
      data-testid="session-monitors"
    >
      <summary className="cursor-pointer px-4 py-3">
        Monitors ({items.length}){failures ? `, ${failures} failed` : ""}
      </summary>
      <ul className="max-h-48 overflow-auto px-4 pb-2">
        {items.map((item) => (
          <li
            key={item.id}
            className="flex flex-wrap items-center gap-x-3 border-t border-border py-1"
          >
            <button
              type="button"
              className="min-h-11 max-w-full break-all text-left underline underline-offset-2"
              onClick={() => onOpen("artifact", item.id)}
            >
              {item.workflowName}
            </button>
            <span className="text-fg-muted">{item.status}</span>
            {item.nextRunAt && (
              <span>Next: {new Date(item.nextRunAt).toLocaleString()}</span>
            )}
            {item.lastRun && (
              <button
                type="button"
                className={`min-h-11 underline underline-offset-2 ${item.lastRun.status === "failed" ? "text-danger" : "text-fg-muted"}`}
                onClick={() => onOpen("run", item.lastRun!.id)}
              >
                Last run: {item.lastRun.status}
              </button>
            )}
            {(item.status === "active" || item.status === "paused") && (
              <button
                type="button"
                className="min-h-11 px-2 text-fg-muted"
                aria-label={`Stop monitor ${item.workflowName}`}
                disabled={query.stop.isPending}
                onClick={() => query.stop.mutate(item.id)}
              >
                Stop
              </button>
            )}
            {item.lastError && (
              <p className="w-full text-danger">{item.lastError}</p>
            )}
          </li>
        ))}
      </ul>
      {query.stop.error && (
        <p role="alert" className="px-4 pb-3 text-danger">
          {query.stop.error.message}
        </p>
      )}
    </details>
  );
}
