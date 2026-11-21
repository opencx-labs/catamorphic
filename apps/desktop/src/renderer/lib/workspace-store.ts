import { atom, createStore, useAtomValue } from "jotai";
import { selectAtom } from "jotai/utils";
import { useMemo, useRef } from "react";
import type { Workspace } from "./workspace-state.js";

/** Each workspace a project runtime holds, by project (or utility) key. */
export type Workspaces = Readonly<Record<string, Workspace>>;

const workspacesAtom = atom<Workspaces>({});

/**
 * Where a window's workspaces live (ADR 0340): outside React, so what
 * changes them reads and writes the state itself rather than a render's
 * copy of it, and a part of the window follows only the slice it shows.
 *
 * A change applies at once and is told to every follower in the caller's
 * own React batch, so a workspace change and a `setState` made beside it
 * still commit together.
 */
export interface WorkspaceStore {
  get(): Workspaces;
  /** Returning what it was given changes, and tells, nothing. */
  update(change: (current: Workspaces) => Workspaces): void;
  subscribe(listener: () => void): () => void;
  /** The jotai store behind it, for `useWorkspaces`. */
  readonly atoms: ReturnType<typeof createStore>;
}

export function createWorkspaceStore(): WorkspaceStore {
  const atoms = createStore();
  return {
    atoms,
    get: () => atoms.get(workspacesAtom),
    update: (change) => atoms.set(workspacesAtom, change),
    subscribe: (listener) => atoms.sub(workspacesAtom, listener),
  };
}

/**
 * Follow a slice of the workspaces: the component renders again only when
 * the slice changes (by `equal`, identity unless given). `select` may close
 * over what it is given per render; pass `inputs` when it does, as a hook's
 * dependencies.
 */
export function useWorkspaces<T>(
  store: WorkspaceStore,
  select: (workspaces: Workspaces) => T,
  inputs: readonly unknown[] = [],
  equal: (a: T, b: T) => boolean = Object.is,
): T {
  const latest = useRef({ select, equal });
  latest.current = { select, equal };
  const slice = useMemo(
    () =>
      selectAtom(
        workspacesAtom,
        (workspaces: Workspaces) => latest.current.select(workspaces),
        (a: T, b: T) => latest.current.equal(a, b),
      ),
    // biome-ignore lint/correctness/useExhaustiveDependencies: the caller's inputs say when the selector reads something else
    inputs,
  );
  return useAtomValue(slice, { store: store.atoms });
}

/** Every workspace: what the window's root follows while it still draws them all. */
export const allWorkspaces = (workspaces: Workspaces): Workspaces => workspaces;
