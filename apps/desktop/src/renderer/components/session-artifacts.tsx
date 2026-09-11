import { useAppPresentations, useSessionArtifacts } from "@catamorphic/react";
import { Workflow } from "lucide-react";
import { AppGlyph } from "./app-icon.js";

export function SessionArtifacts({
  projectId,
  sessionId,
  onOpen,
}: {
  projectId: string;
  sessionId: string;
  onOpen: (target: string) => void;
}) {
  const artifacts = useSessionArtifacts(projectId, sessionId, {
    refetchInterval: 5000,
  });
  const items =
    artifacts.data?.filter((artifact) => artifact.status === "active") ?? [];
  const presentations = useAppPresentations(
    projectId,
    items.flatMap((item) => (item.appName ? [item.appName] : [])),
  );
  const icons = new Map(
    presentations.flatMap((query) =>
      query.data ? [[query.data.name, query.data.icon] as const] : [],
    ),
  );
  return (
    <section
      className="border-t border-border px-3 py-3"
      aria-label="Session artifacts"
    >
      <h3 className="mb-2 text-xs font-medium">Artifacts</h3>
      {artifacts.error ? (
        <button
          type="button"
          className="text-xs text-danger"
          onClick={() => void artifacts.refetch()}
        >
          Could not load artifacts. Retry
        </button>
      ) : !items.length ? (
        <p className="text-xs text-fg-muted">
          {artifacts.isLoading
            ? "Loading…"
            : "No generated apps or temporary workflows yet."}
        </p>
      ) : (
        <ul className="space-y-1">
          {items.map((artifact) => (
            <li key={artifact.id}>
              <button
                type="button"
                className="flex w-full items-center gap-2 rounded px-2 py-1.5 text-left text-xs hover:bg-bg-overlay"
                onClick={() => onOpen(`artifact:${artifact.id}`)}
              >
                {artifact.appName ? (
                  <AppGlyph
                    icon={icons.get(artifact.appName)}
                    className="size-3.5 shrink-0"
                  />
                ) : (
                  <Workflow className="size-3.5 shrink-0" />
                )}
                <span className="min-w-0 flex-1 truncate">
                  {artifact.title}
                </span>
                <span className="text-fg-muted">{artifact.kind}</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
