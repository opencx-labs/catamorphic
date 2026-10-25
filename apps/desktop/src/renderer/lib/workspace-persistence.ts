import { useEffect, useRef } from "react";
import { desktopApi } from "./desktop-api.js";
import { serializeWorkspace, type Workspace } from "./workspace-state.js";

const savers = new Map<symbol, () => Promise<void>>();
const writes = new Map<string, Promise<void>>();

/** Keep an older in-flight write ahead of the latest shutdown snapshot. */
export function saveWorkspace({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace: Workspace;
}): Promise<void> {
  const snapshot = serializeWorkspace(workspace);
  const write = (writes.get(projectId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => desktopApi.workspaceStateSet(projectId, snapshot))
    .finally(() => {
      if (writes.get(projectId) === write) writes.delete(projectId);
    });
  writes.set(projectId, write);
  return write;
}

/** Quit/update acknowledges only after every mounted project's save settles. */
export async function flushWorkspaceSaves(): Promise<void> {
  await Promise.all([...savers.values()].map((save) => save()));
  await Promise.all([...writes.values()]);
}

/** The regular debounce and shutdown flush read the same current snapshot. */
export function useWorkspacePersistence({
  projectId,
  workspace,
}: {
  projectId: string | undefined;
  workspace: Workspace | undefined;
}) {
  const latest = useRef({ projectId, workspace });
  latest.current = { projectId, workspace };
  useEffect(() => {
    const key = Symbol();
    const save = () => {
      const current = latest.current;
      return current.projectId && current.workspace
        ? saveWorkspace({
            projectId: current.projectId,
            workspace: current.workspace,
          })
        : Promise.resolve();
    };
    savers.set(key, save);
    return () => {
      savers.delete(key);
    };
  }, []);
  useEffect(() => {
    if (!projectId || !workspace) return;
    const timer = window.setTimeout(() => {
      void saveWorkspace({ projectId, workspace }).catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [projectId, workspace]);
}
