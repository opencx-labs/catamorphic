import { useCatamorphic } from "@catamorphic/react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { AppScreen } from "./app-screen.js";

/** Source and execution use the same retained identity as a generated app. */
export function ArtifactScreen({
  projectId,
  artifactId,
  onAskAgent,
}: {
  projectId: string;
  artifactId: string;
  onAskAgent: (message: string) => void;
}) {
  const { apiClient } = useCatamorphic();
  const path = { projectId, artifactId };
  const [selected, setSelected] = useState("");
  const [input, setInput] = useState("{}");
  const artifact = useQuery({
    queryKey: ["cat", projectId, "artifact", artifactId],
    queryFn: async () => {
      const result = await apiClient.GET(
        "/api/projects/{projectId}/session-artifacts/{artifactId}",
        { params: { path } },
      );
      if (!result.data)
        throw new Error("This artifact is unavailable or was discarded.");
      return result.data;
    },
  });
  const files = useQuery({
    queryKey: [
      "cat",
      projectId,
      "artifact",
      artifactId,
      "files",
      artifact.data?.revision,
    ],
    enabled: Boolean(artifact.data),
    queryFn: async () => {
      const result = await apiClient.GET(
        "/api/projects/{projectId}/session-artifacts/{artifactId}/files",
        { params: { path } },
      );
      if (!result.data) throw new Error("Could not load source files.");
      return result.data;
    },
  });
  const run = useMutation({
    mutationFn: async () => {
      const result = await apiClient.POST(
        "/api/projects/{projectId}/session-artifacts/{artifactId}/runs",
        { params: { path }, body: { input: JSON.parse(input) } },
      );
      if (!result.data)
        throw new Error(result.error?.error ?? "Could not run this workflow.");
      return result.data;
    },
  });
  const status = useQuery({
    queryKey: ["cat", "artifact-run", run.data?.id],
    enabled: Boolean(run.data),
    refetchInterval: (query) =>
      ["completed", "failed", "canceled"].includes(
        query.state.data?.status ?? "",
      )
        ? false
        : 1500,
    queryFn: async () => {
      if (!run.data) throw new Error("No run selected");
      const result = await apiClient.GET("/api/runs/{runId}", {
        params: { path: { runId: run.data.id } },
      });
      if (!result.data) throw new Error("Could not load run status.");
      return result.data;
    },
  });
  const discard = useMutation({
    mutationFn: async () => {
      const result = await apiClient.DELETE(
        "/api/projects/{projectId}/session-artifacts/{artifactId}",
        { params: { path } },
      );
      if (result.error) throw new Error(result.error.error);
    },
  });
  if (discard.isSuccess)
    return (
      <p className="p-5 text-sm text-fg-muted">
        Artifact discarded. Existing runs can finish.
      </p>
    );
  if (!artifact.data)
    return (
      <p
        role={artifact.error ? "alert" : "status"}
        className="p-5 text-sm text-fg-muted"
      >
        {artifact.error?.message ?? "Loading artifact…"}
      </p>
    );
  const current = artifact.data;
  const file = selected || current.sourcePath;
  return (
    <section
      className="flex min-h-0 flex-1 flex-col"
      aria-label={current.title}
    >
      <header className="flex flex-wrap items-center gap-3 border-b border-border px-4 py-3">
        <div className="mr-auto">
          <h1 className="text-sm font-semibold">{current.title}</h1>
          <p className="text-xs text-fg-muted">
            Session {current.kind} · Revision {current.revision}
          </p>
        </div>
        <button
          type="button"
          className="text-xs"
          onClick={() =>
            onAskAgent(
              `Read session artifact ${artifactId} in session ${current.sessionId}. Help me edit it using session_artifact update, preserving its identity.`,
            )
          }
        >
          Edit with agent
        </button>
        <button
          type="button"
          className="text-xs"
          onClick={() =>
            onAskAgent(
              `Read session artifact ${artifactId} in session ${current.sessionId}. Keep this in the project as ordinary reusable source. Inspect the project first, copy only the necessary files, reconcile dependencies and existing files, and use the normal project app/workflow lifecycle.`,
            )
          }
        >
          Keep in project
        </button>
        <button
          type="button"
          className="text-xs text-danger"
          disabled={discard.isPending}
          data-disabled-reason={
            discard.isPending ? "Discarding artifact" : undefined
          }
          onClick={() => discard.mutate()}
        >
          Discard
        </button>
      </header>
      {discard.error && (
        <p role="alert" className="p-3 text-sm text-danger">
          {discard.error.message}
        </p>
      )}
      {current.appName ? (
        <AppScreen projectId={projectId} appName={current.appName} />
      ) : (
        <div className="min-h-0 flex-1 overflow-auto p-4">
          <div className="mb-3 flex gap-3">
            <select
              aria-label="Artifact source file"
              className="field min-w-0 flex-1 rounded p-2 text-xs"
              value={file}
              onChange={(event) => setSelected(event.target.value)}
            >
              {Object.keys(files.data ?? {}).map((name) => (
                <option key={name}>{name}</option>
              ))}
            </select>
            <button
              type="button"
              className="text-xs"
              onClick={() => {
                void artifact.refetch();
                void files.refetch();
              }}
            >
              Refresh
            </button>
          </div>
          {files.error ? (
            <p role="alert">{files.error.message}</p>
          ) : (
            <pre className="overflow-auto rounded bg-bg-inset p-3 font-mono text-xs">
              {files.data?.[file] ?? "Loading source…"}
            </pre>
          )}
          <form
            className="mt-5 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              run.mutate();
            }}
          >
            <label className="text-xs">
              Workflow input
              <textarea
                aria-label="Workflow input"
                className="field mt-2 block w-full rounded p-2 font-mono"
                value={input}
                onChange={(event) => setInput(event.target.value)}
              />
            </label>
            <button
              className="self-start rounded bg-bg-overlay px-3 py-2 text-xs"
              type="submit"
              disabled={run.isPending}
              data-disabled-reason={
                run.isPending ? "Starting the run" : undefined
              }
            >
              Run once
            </button>
          </form>
          {(run.error || status.error) && (
            <p role="alert" className="mt-3 text-sm text-danger">
              {run.error?.message ?? status.error?.message}
            </p>
          )}
          {status.data && (
            <div role="status" className="mt-4 text-sm">
              <p>{status.data.status}</p>
              <pre className="mt-2 overflow-auto font-mono text-xs">
                {JSON.stringify(
                  status.data.result ?? status.data.error,
                  null,
                  2,
                )}
              </pre>
            </div>
          )}
        </div>
      )}
    </section>
  );
}
