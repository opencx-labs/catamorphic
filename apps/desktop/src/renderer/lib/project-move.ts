import { useEffect, useRef } from "react";

/**
 * A project a window keeps behind the one it shows can move to a window of
 * its own (ADR 0121, amended 2026-10-14). The window lets it go by
 * unmounting it, and the new window opens it from what this one saved:
 * its tabs, its chats (sent or not) and its shells, which keep running and
 * are taken over there. A file's unsaved edits live only in its editor, so
 * a project holding some stays until they are saved or discarded.
 */

const moving = new Set<string>();
const unsavedReaders = new Map<string, () => string[]>();

/** Marks `projectId` as leaving this window, until `endMove`. */
export function startMove(projectId: string) {
  moving.add(projectId);
}

export function endMove(projectId: string) {
  moving.delete(projectId);
}

/** While true, what unmounts with the project goes with it instead. */
export function isMoving(projectId: string | undefined): boolean {
  return projectId !== undefined && moving.has(projectId);
}

/** The files with unsaved edits a move would lose, by name. */
export function unsavedBeforeMove(projectId: string): string[] {
  return unsavedReaders.get(projectId)?.() ?? [];
}

/** While mounted, `projectId`'s workspace says which files hold edits. */
export function useUnsavedFilesForMove(
  projectId: string | undefined,
  read: () => string[],
) {
  const latest = useRef(read);
  latest.current = read;
  useEffect(() => {
    if (!projectId) return;
    const reader = () => latest.current();
    unsavedReaders.set(projectId, reader);
    return () => {
      if (unsavedReaders.get(projectId) === reader)
        unsavedReaders.delete(projectId);
    };
  }, [projectId]);
}
