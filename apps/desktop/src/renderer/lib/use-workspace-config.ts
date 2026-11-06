import { useEffect, useState } from "react";
import type { WorkspaceConfig } from "../../shared/workspace-config.js";
import { desktopApi } from "./desktop-api.js";
import { transitionSidebarUpdate } from "./sidebar-transition.js";

/**
 * The layered workspace file (workspace.js: sidebars and palette modes),
 * resolved for the active project: personal override, then the project's
 * .work/workspace.js, then the profile's, then built in. Fetched at boot
 * with no project (the profile layer keeps the boot gate working), again
 * when the project changes, and on every change signal from main, which
 * carries no payload. Unchanged results keep their identity; live edits
 * apply inside a sidebar transition.
 */
export function useWorkspaceConfig({
  projectId,
  scope,
}: {
  projectId: string | undefined;
  /** Profile and project the config was resolved for. */
  scope: string;
}): {
  config: WorkspaceConfig | null;
  /** The scope the current config belongs to; stale while a switch loads. */
  scope: string | undefined;
  error: string | undefined;
} {
  const [config, setConfig] = useState<WorkspaceConfig | null>(null);
  const [loadedScope, setLoadedScope] = useState<string>();
  const [error, setError] = useState<string>();
  useEffect(() => {
    let stale = false;
    let request = 0;
    let signature: string | undefined;
    const refetch = (animate = false) => {
      const currentRequest = ++request;
      void desktopApi.workspaceConfigGet(projectId).then((resolved) => {
        if (stale || currentRequest !== request) return;
        setError(resolved.error);
        const next = JSON.stringify(resolved.config);
        if (signature === next) return;
        const apply = () => {
          if (stale || currentRequest !== request) return;
          signature = next;
          setConfig(resolved.config);
          setLoadedScope(scope);
        };
        if (animate) transitionSidebarUpdate(apply);
        else apply();
      });
    };
    refetch();
    const unsubscribe = desktopApi.onWorkspaceConfigChanged(() =>
      refetch(true),
    );
    return () => {
      stale = true;
      unsubscribe();
    };
  }, [projectId, scope]);
  return { config, scope: loadedScope, error };
}
