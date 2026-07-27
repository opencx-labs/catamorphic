import { useCatamorphic } from "@catamorphic/react";
import { AppMount } from "@catamorphic/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useState } from "react";

/**
 * Playground surface for the app lifecycle: list repo apps, build previews and
 * published versions, activate one, and mount the live app the way a host
 * would for a viewer.
 */
export function AppsScreen({ projectId }: { projectId: string }) {
  const { apiClient } = useCatamorphic();
  const queryClient = useQueryClient();
  const [selectedApp, setSelectedApp] = useState<string | null>(null);

  const apps = useQuery({
    queryKey: ["pg-apps", projectId],
    queryFn: async () => {
      const response = await apiClient.GET("/api/projects/{projectId}/apps", {
        params: { path: { projectId } },
      });
      if (!response.data) throw new Error("Failed to list apps");
      return response.data;
    },
  });

  const versions = useQuery({
    queryKey: ["pg-app-versions", projectId, selectedApp],
    enabled: selectedApp !== null,
    queryFn: async () => {
      const response = await apiClient.GET(
        "/api/projects/{projectId}/apps/{appName}/versions",
        { params: { path: { projectId, appName: selectedApp ?? "" } } },
      );
      if (!response.data) throw new Error("Failed to list versions");
      return response.data;
    },
  });

  const commits = useQuery({
    queryKey: ["pg-app-commits", projectId],
    queryFn: async () => {
      const response = await apiClient.GET(
        "/api/projects/{projectId}/commits",
        { params: { path: { projectId } } },
      );
      return response.data?.items ?? [];
    },
  });

  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ["pg-apps", projectId] });
    void queryClient.invalidateQueries({
      queryKey: ["pg-app-versions", projectId, selectedApp],
    });
  };

  const build = useMutation({
    mutationFn: async (args: {
      kind: "preview" | "published";
      commitSha?: string;
    }) => {
      if (!selectedApp) throw new Error("No app selected");
      const response = await apiClient.POST(
        "/api/projects/{projectId}/apps/{appName}/builds",
        {
          params: { path: { projectId, appName: selectedApp } },
          body: { kind: args.kind, commitSha: args.commitSha },
        },
      );
      if (response.error) {
        throw new Error(
          (response.error as { error?: string }).error ?? "Build failed",
        );
      }
      return response.data;
    },
    onSettled: invalidate,
  });

  const publish = useMutation({
    mutationFn: async (versionId: string) => {
      const response = await apiClient.POST(
        "/api/projects/{projectId}/app-versions/{versionId}/publish",
        { params: { path: { projectId, versionId } } },
      );
      if (response.error) {
        throw new Error(
          (response.error as { error?: string }).error ?? "Publish failed",
        );
      }
      return response.data;
    },
    onSettled: invalidate,
  });

  const latestCommit = commits.data?.[0]?.sha;
  const activeVersion = apps.data?.find(
    (app) => app.name === selectedApp,
  )?.activeVersionId;

  return (
    <div className="pg-apps">
      <div className="pg-apps-controls">
        <h2>Apps</h2>
        {apps.isLoading && <p>Loading…</p>}
        {apps.data?.length === 0 && (
          <p className="pg-muted">
            No apps in this project. Add one under apps/ or ask the assistant.
          </p>
        )}
        {apps.data?.map((app) => (
          <button
            key={app.name}
            type="button"
            className={`pg-item ${selectedApp === app.name ? "active" : ""}`}
            onClick={() => setSelectedApp(app.name)}
          >
            {app.name}
            {app.activeVersionId ? " (live)" : ""}
          </button>
        ))}

        {selectedApp && (
          <div className="pg-apps-actions">
            <button
              type="button"
              disabled={build.isPending}
              onClick={() => build.mutate({ kind: "preview" })}
            >
              {build.isPending ? "Building…" : "Build preview"}
            </button>
            <button
              type="button"
              disabled={build.isPending || !latestCommit}
              onClick={() =>
                build.mutate({ kind: "published", commitSha: latestCommit })
              }
            >
              Build for publish
            </button>
            {build.error && <p className="pg-error">{build.error.message}</p>}
            {versions.data?.map((version) => (
              <div key={version.id} className="pg-app-version">
                <span>
                  {version.kind} · {version.status}
                  {version.isActive ? " · live" : ""}
                </span>
                {version.kind === "published" &&
                  version.status === "ready" &&
                  !version.isActive && (
                    <button
                      type="button"
                      disabled={publish.isPending}
                      onClick={() => publish.mutate(version.id)}
                    >
                      Publish
                    </button>
                  )}
                {version.error && (
                  <pre className="pg-error">{version.error}</pre>
                )}
              </div>
            ))}
          </div>
        )}
      </div>

      <div className="pg-apps-stage">
        {selectedApp ? (
          <AppMount
            key={`${selectedApp}:${activeVersion ?? "none"}`}
            projectId={projectId}
            appName={selectedApp}
            context={{
              // Matches the demo identity the playground server injects.
              tenantId: "00000000-0000-4000-8000-000000000001",
              user: { id: "playground-viewer" },
            }}
          />
        ) : (
          <p className="pg-muted">Select an app to view it.</p>
        )}
      </div>
    </div>
  );
}
