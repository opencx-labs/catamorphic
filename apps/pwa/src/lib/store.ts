import { useSyncExternalStore } from "react";
import type { ConnectLink } from "./connect-link.js";

/**
 * Local pwa state: profiles and their server connections. A profile
 * is a person (mirroring the desktop model: the bearer token is theirs);
 * each holds the connect links they've redeemed. Plain localStorage — the
 * MVP has no accounts of its own, and a Capacitor wrap can later swap this
 * for secure storage behind the same module surface.
 */
export interface PwaConnection {
  id: string;
  /** API base from the connect link (usually ending in `/api`). */
  serverUrl: string;
  token: string;
  projectId: string;
  projectName?: string;
  renewUrl?: string;
  addedAt: string;
}

export interface PwaProfile {
  id: string;
  name: string;
  color: string;
  connections: PwaConnection[];
}

export interface PwaState {
  profiles: PwaProfile[];
  activeProfileId: string;
}

/** Same palette as the desktop profile switcher. */
export const PROFILE_COLORS = [
  "#f95225",
  "#4c8dff",
  "#3dba7c",
  "#c465e0",
  "#e0b23f",
  "#e05656",
] as const;

const STORAGE_KEY = "catamorphic-pwa.v1";

function defaultState(): PwaState {
  const profile: PwaProfile = {
    id: crypto.randomUUID(),
    name: "You",
    color: PROFILE_COLORS[0],
    connections: [],
  };
  return { profiles: [profile], activeProfileId: profile.id };
}

function load(): PwaState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as PwaState;
    if (!Array.isArray(parsed.profiles) || parsed.profiles.length === 0) {
      return defaultState();
    }
    if (!parsed.profiles.some((p) => p.id === parsed.activeProfileId)) {
      const first = parsed.profiles[0];
      if (first) parsed.activeProfileId = first.id;
    }
    return parsed;
  } catch {
    return defaultState();
  }
}

let state: PwaState = load();
const listeners = new Set<() => void>();

function commit(next: PwaState): void {
  state = next;
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
  } catch {
    // Quota/private-mode failures: keep the in-memory state working.
  }
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/** The live store value, for non-React flows (URL intake, pairing). */
export function getState(): PwaState {
  return state;
}

export function usePwaState(): PwaState {
  return useSyncExternalStore(subscribe, () => state);
}

export function activeProfile(current: PwaState): PwaProfile {
  return (
    current.profiles.find((p) => p.id === current.activeProfileId) ??
    (current.profiles[0] as PwaProfile)
  );
}

export function connectionById(
  current: PwaState,
  connectionId: string,
): PwaConnection | undefined {
  for (const profile of current.profiles) {
    const found = profile.connections.find((c) => c.id === connectionId);
    if (found) return found;
  }
  return undefined;
}

function updateProfile(
  profileId: string,
  update: (profile: PwaProfile) => PwaProfile,
): void {
  commit({
    ...state,
    profiles: state.profiles.map((profile) =>
      profile.id === profileId ? update(profile) : profile,
    ),
  });
}

/** Add (or refresh) a connection from a redeemed connect link. */
export function addConnection(
  profileId: string,
  link: ConnectLink,
  projectName?: string,
): PwaConnection {
  const existing = state.profiles
    .find((p) => p.id === profileId)
    ?.connections.find(
      (c) =>
        c.serverUrl === link.serverUrl && c.projectId === link.remoteProjectId,
    );
  const connection: PwaConnection = {
    id: existing?.id ?? crypto.randomUUID(),
    serverUrl: link.serverUrl,
    token: link.token,
    projectId: link.remoteProjectId,
    ...(projectName || link.remoteProjectName
      ? { projectName: projectName ?? link.remoteProjectName }
      : {}),
    ...(link.renewUrl ? { renewUrl: link.renewUrl } : {}),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  updateProfile(profileId, (profile) => ({
    ...profile,
    connections: [
      ...profile.connections.filter((c) => c.id !== connection.id),
      connection,
    ],
  }));
  return connection;
}

export function removeConnection(profileId: string, connectionId: string) {
  updateProfile(profileId, (profile) => ({
    ...profile,
    connections: profile.connections.filter((c) => c.id !== connectionId),
  }));
}

export function createProfile(name: string): PwaProfile {
  const color =
    PROFILE_COLORS[state.profiles.length % PROFILE_COLORS.length] ??
    PROFILE_COLORS[0];
  const profile: PwaProfile = {
    id: crypto.randomUUID(),
    name: name.trim() || `Profile ${state.profiles.length + 1}`,
    color,
    connections: [],
  };
  commit({
    ...state,
    profiles: [...state.profiles, profile],
    activeProfileId: profile.id,
  });
  return profile;
}

export function renameProfile(profileId: string, name: string) {
  const trimmed = name.trim();
  if (!trimmed) return;
  updateProfile(profileId, (profile) => ({ ...profile, name: trimmed }));
}

export function setActiveProfile(profileId: string) {
  if (!state.profiles.some((p) => p.id === profileId)) return;
  commit({ ...state, activeProfileId: profileId });
}

export function deleteProfile(profileId: string) {
  if (state.profiles.length <= 1) return;
  const profiles = state.profiles.filter((p) => p.id !== profileId);
  const first = profiles[0];
  if (!first) return;
  commit({
    profiles,
    activeProfileId:
      state.activeProfileId === profileId ? first.id : state.activeProfileId,
  });
}
