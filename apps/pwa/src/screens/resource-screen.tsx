import { CatamorphicProvider, useCatamorphic } from "@catamorphic/react";
import { RunDetail } from "@catamorphic/ui";
import { type QueryClient, useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { Screen } from "../components/screen.js";
import { clientFor } from "../lib/api.js";
import type { PwaConnection } from "../lib/store.js";

export function ResourceScreen({
  connection,
  projectId,
  resourceType,
  resourceId,
  queryClient,
}: {
  connection: PwaConnection;
  projectId: string;
  resourceType: "run" | "artifact" | "workflow";
  resourceId: string;
  queryClient: QueryClient;
}) {
  return (
    <CatamorphicProvider
      apiClient={clientFor(connection)}
      queryClient={queryClient}
    >
      <Screen
        title={resourceType === "run" ? "Workflow run" : "Workflow source"}
        back
      >
        <div className="h-full overflow-auto p-4">
          {resourceType === "run" ? (
            <RunDetail runId={resourceId} />
          ) : (
            <Source projectId={projectId} kind={resourceType} id={resourceId} />
          )}
        </div>
      </Screen>
    </CatamorphicProvider>
  );
}
function Source({
  projectId,
  kind,
  id,
}: {
  projectId: string;
  kind: "artifact" | "workflow";
  id: string;
}) {
  const { apiClient } = useCatamorphic();
  const [selected, setSelected] = useState("");
  const query = useQuery({
    queryKey: ["resource-source", projectId, kind, id],
    queryFn: async () => {
      if (kind === "artifact") {
        const response = await apiClient.GET(
          "/api/projects/{projectId}/session-artifacts/{artifactId}/files",
          { params: { path: { projectId, artifactId: id } } },
        );
        if (!response.data)
          throw new Error(
            response.error?.error ?? "This source is unavailable on this host.",
          );
        return response.data;
      }
      const response = await apiClient.GET(
        "/api/projects/{projectId}/workflows/{name}",
        { params: { path: { projectId, name: id } } },
      );
      if (!response.data)
        throw new Error(
          response.error?.error ?? "This workflow is unavailable on this host.",
        );
      return response.data.allFiles;
    },
  });
  if (query.error)
    return (
      <p role="alert" className="text-sm text-danger">
        {query.error.message}
      </p>
    );
  if (!query.data)
    return (
      <p role="status" className="text-sm text-fg-muted">
        Loading source…
      </p>
    );
  const paths = Object.keys(query.data).sort();
  const file =
    selected || paths.find((path) => path.endsWith(".ts")) || paths[0] || "";
  return (
    <div className="space-y-3">
      <label className="block text-sm">
        Source file
        <select
          className="mt-1 block min-h-11 w-full rounded border border-border bg-bg-raised p-2"
          value={file}
          onChange={(event) => setSelected(event.currentTarget.value)}
        >
          {paths.map((path) => (
            <option key={path}>{path}</option>
          ))}
        </select>
      </label>
      <pre className="overflow-auto rounded border border-border bg-bg-inset p-3 text-xs">
        {query.data[file]}
      </pre>
    </div>
  );
}
