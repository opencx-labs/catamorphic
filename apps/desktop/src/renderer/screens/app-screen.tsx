import type {
  AppCollections,
  AppContentState,
  AppIconName,
  AppSurface,
} from "@catamorphic/app";
import { useCatamorphic } from "@catamorphic/react";
import { AppMount } from "@catamorphic/ui";
import { useQuery } from "@tanstack/react-query";
import { useRef } from "react";
import { useSteadyWidthDuringLayoutTransitions } from "../lib/layout-transition.js";
import { appHostTheme, useTheme } from "../lib/theme.js";
import { useAppPreferences } from "../lib/use-app-preferences.js";

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
  /** Host data the newest ready build declares it reads (ADR 0148). */
  access: { sessions?: "read" };
}

export function useApps(projectId: string | undefined) {
  const { apiClient } = useCatamorphic();
  return useQuery<AppSummary[]>({
    queryKey: ["cat", "project", projectId, "apps"],
    queryFn: async () => {
      const result = await apiClient.GET("/api/projects/{projectId}/apps", {
        params: { path: { projectId: projectId ?? "" } },
      });
      // Source listing is builder-only; scoped members open granted app surfaces.
      if (result.response.status === 403) return [];
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
  // The app's frame resizes once per layout transition, not per frame.
  const appBoxRef = useRef<HTMLDivElement>(null);
  const appContentRef = useRef<HTMLDivElement>(null);
  useSteadyWidthDuringLayoutTransitions(appContentRef, appBoxRef);
  const theme = useTheme();
  const apps = useApps(projectId);
  const app = apps.data?.find((entry) => entry.name === appName);
  const sourceExists = app !== undefined;
  // An app that reads this profile's chats waits for a one-time answer
  // before it mounts (ADR 0148). The answer is per project and app, and it
  // is only known once the app list and the profile's answers have loaded:
  // nothing mounts before then, so an unanswered app never runs early and
  // an answered one never flashes the question.
  const { prefs, loaded, update } = useAppPreferences();
  const approvalKey = `${projectId}/${appName}`;
  if (apps.isPending || (app?.access.sessions === "read" && !loaded)) {
    return (
      <div
        className={compact ? "min-w-0" : "flex min-h-0 flex-1 flex-col bg-bg"}
      >
        <div className="grid h-60 place-items-center text-sm text-fg-muted">
          Loading app…
        </div>
      </div>
    );
  }
  const needsConsent =
    app?.access.sessions === "read" &&
    !prefs.appAccessApprovals.includes(approvalKey);
  if (needsConsent && app) {
    return (
      <AppAccessConsent
        app={app}
        compact={compact}
        onAllow={() =>
          void update({
            appAccessApprovals: [...prefs.appAccessApprovals, approvalKey],
          })
        }
      />
    );
  }
  return (
    <div
      ref={appBoxRef}
      className={compact ? "min-w-0" : "flex min-h-0 flex-1 flex-col bg-bg"}
    >
      <div ref={appContentRef} className="flex min-h-0 w-full flex-1 flex-col">
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
              {state === "loading" || (state === "not_found" && apps.isPending)
                ? "Loading app…"
                : state === "not_published" || sourceExists
                  ? "This app has no successful build yet. Ask the assistant to build it."
                  : "App not found."}
            </div>
          )}
        />
      </div>
    </div>
  );
}

/**
 * The request an app makes before it can read the profile's chats. It sits
 * where the app would, in the app's own words, with one primary action.
 */
function AppAccessConsent({
  app,
  compact,
  onAllow,
}: {
  app: AppSummary;
  compact: boolean;
  onAllow: () => void;
}) {
  return (
    <div
      data-testid="app-access-consent"
      className={
        compact
          ? "min-w-0 px-3 py-3"
          : "flex min-h-0 flex-1 items-center justify-center bg-bg p-6"
      }
    >
      <div className="settings-card w-full max-w-md">
        <h2 className="text-sm font-semibold text-fg">
          {app.title} wants to read your chats
        </h2>
        <p className="mt-1 text-xs leading-5 text-fg-muted">
          The app can list your conversations in this project and read their
          messages through its workflows. It never sees anyone else's chats.
          Allow it once for this project; a rebuilt version without this request
          loses the access.
        </p>
        <div className="mt-4 flex gap-2">
          <button
            type="button"
            className="button-primary"
            onClick={onAllow}
            data-testid="app-access-allow"
          >
            Allow
          </button>
        </div>
      </div>
    </div>
  );
}
