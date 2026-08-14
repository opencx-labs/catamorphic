import { useCatamorphic } from "@catamorphic/react";
import { AppMount } from "@catamorphic/ui";
import { useQuery } from "@tanstack/react-query";
import { appHostTheme, useTheme } from "../lib/theme.js";

// Must match DESKTOP_TENANT_ID / DESKTOP_USER_ID injected by the embedded
// server (src/main/server/boot.ts) for the single-tenant desktop identity.
const DESKTOP_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
const DESKTOP_USER_ID = "desktop-user";

export interface AppSummary {
  name: string;
  id: string | null;
  activeVersionId: string | null;
  publishedAt: string | null;
}

export function useApps(projectId: string | undefined) {
  const { apiClient } = useCatamorphic();
  return useQuery<AppSummary[]>({
    queryKey: ["cat", "project", projectId, "apps"],
    queryFn: async () => {
      const result = await apiClient.GET("/api/projects/{projectId}/apps", {
        params: { path: { projectId: projectId ?? "" } },
      });
      if (!result.data) throw new Error("Failed to list apps");
      return result.data;
    },
    enabled: Boolean(projectId),
  });
}

export function AppScreen({
  projectId,
  appName,
}: {
  projectId: string;
  appName: string;
}) {
  const theme = useTheme();
  return (
    <div className="min-h-0 flex-1 overflow-y-auto bg-bg-inset p-4">
      <AppMount
        key={`${projectId}:${appName}`}
        projectId={projectId}
        appName={appName}
        context={{
          tenantId: DESKTOP_TENANT_ID,
          user: { id: DESKTOP_USER_ID },
        }}
        // Apps live inside the shell: hand them the full theme — the
        // profile's resolved colors plus the desktop's feel tokens — so
        // shared-vocabulary styling matches it exactly, and keep them
        // current across theme switches.
        theme={theme ? appHostTheme(theme) : undefined}
        className="mx-auto w-full max-w-5xl overflow-hidden rounded-lg border border-border bg-bg-raised"
        // The desktop is the owner's surface: show the newest ready build
        // (the version being developed), not just the published one.
        channel="dev"
        renderState={(state) => (
          <div className="grid h-60 place-items-center text-sm text-fg-muted">
            {state === "loading"
              ? "Loading app…"
              : state === "not_published"
                ? "This app has no successful build yet. Ask the assistant to build it."
                : "App not found."}
          </div>
        )}
      />
    </div>
  );
}
