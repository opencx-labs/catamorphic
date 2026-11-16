import { useEffect, useRef } from "react";
import { desktopApi } from "./desktop-api.js";
import { serializeWorkspace, type Workspace } from "./workspace-state.js";

const savers = new Map<symbol, () => Promise<void>>();
const writes = new Map<string, Promise<void>>();
/**
 * The last snapshot written or being written, per project. The workspace
 * object changes far more often than what survives a restart (a title, a
 * running chat); an unchanged snapshot is not written again, since every
 * write leaves a dead row version in the embedded database.
 */
const written = new Map<string, string>();

/** Keep an older in-flight write ahead of the latest shutdown snapshot. */
export function saveWorkspace({
  projectId,
  workspace,
}: {
  projectId: string;
  workspace: Workspace;
}): Promise<void> {
  const snapshot = serializeWorkspace(workspace);
  const text = JSON.stringify(snapshot);
  if (written.get(projectId) === text) {
    const pending = writes.get(projectId);
    // The same snapshot is being written: if that write fails, this one
    // (perhaps the flush at quit) writes it again.
    return pending
      ? pending.catch(() =>
          written.has(projectId)
            ? writes.get(projectId)
            : saveWorkspace({ projectId, workspace }),
        )
      : Promise.resolve();
  }
  written.set(projectId, text);
  const write = (writes.get(projectId) ?? Promise.resolve())
    .catch(() => {})
    .then(() => desktopApi.workspaceStateSet(projectId, snapshot))
    .catch((error: unknown) => {
      // Not stored: the same snapshot must be written again next time.
      if (written.get(projectId) === text) written.delete(projectId);
      throw error;
    })
    .finally(() => {
      if (writes.get(projectId) === write) writes.delete(projectId);
    });
  writes.set(projectId, write);
  return write;
}

/**
 * Forget what this window last wrote for a project: another window may have
 * written it since (the project moved), so the next save must not be skipped.
 */
export function forgetWorkspaceSave(projectId: string): void {
  written.delete(projectId);
}

/** Quit/update acknowledges only after every mounted project's save settles. */
export async function flushWorkspaceSaves(): Promise<void> {
  await Promise.all([...savers.values()].map((save) => save()));
  await Promise.all([...writes.values()]);
}

/** Mounted resources join the existing quit/update save acknowledgement. */
export function useWorkspaceFlush({ save }: { save: () => Promise<void> }) {
  const latest = useRef(save);
  latest.current = save;
  useEffect(() => {
    const key = Symbol();
    savers.set(key, () => latest.current());
    return () => {
      savers.delete(key);
    };
  }, []);
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
  useWorkspaceFlush({
    save: () => {
      const current = latest.current;
      return current.projectId && current.workspace
        ? saveWorkspace({
            projectId: current.projectId,
            workspace: current.workspace,
          })
        : Promise.resolve();
    },
  });
  useEffect(() => {
    if (!projectId || !workspace) return;
    const timer = window.setTimeout(() => {
      void saveWorkspace({ projectId, workspace }).catch(() => {});
    }, 500);
    return () => window.clearTimeout(timer);
  }, [projectId, workspace]);
}
