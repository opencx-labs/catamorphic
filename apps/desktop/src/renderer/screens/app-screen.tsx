import type {
  AppCollections,
  AppContentState,
  AppIconName,
  AppSurface,
} from "@catamorphic/app";
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
  title: string;
  id: string | null;
  activeVersionId: string | null;
  publishedAt: string | null;
  icon: AppIconName;
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
    refetchInterval: 5000,
  });
}

export function AppScreen({
  projectId,
  appName,
  compact = false,
  visible = true,
  height = 320,
  surface,
  collections,
  onContentState,
}: {
  projectId: string;
  appName: string;
  compact?: boolean;
  visible?: boolean;
  height?: number;
  surface?: AppSurface;
  collections?: AppCollections;
  onContentState?: (state: AppContentState) => void;
}) {
  const theme = useTheme();
  return (
    <div className={compact ? "min-w-0" : "flex min-h-0 flex-1 flex-col bg-bg"}>
      <AppMount
        key={`${projectId}:${appName}`}
        projectId={projectId}
        appName={appName}
        display={{ mode: compact ? "compact" : "full", visible, surface }}
        collections={collections}
        onContentState={onContentState}
        viewportHeight={compact ? height : "fill"}
        refreshIntervalMs={3000}
        context={{
          tenantId: DESKTOP_TENANT_ID,
          user: { id: DESKTOP_USER_ID },
        }}
        // Apps live inside the shell: hand them the full theme — the
        // profile's resolved colors plus the desktop's feel tokens — so
        // shared-vocabulary styling matches it exactly, and keep them
        // current across theme switches.
        theme={theme ? appHostTheme(theme) : undefined}
        className={
          compact
            ? "block w-full bg-bg-raised"
            : "block min-h-0 flex-1 w-full bg-bg"
        }
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
