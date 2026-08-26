import { useSyncExternalStore } from "react";
import type { ConnectLink } from "./connect-link.js";

/**
 * Local PWA state: profiles and their server connections. Remote servers use
 * refreshable OAuth credentials; a paired desktop uses its separate local
 * device token. Plain localStorage remains behind this module so a native
 * wrapper can replace it with secure storage.
 */
export interface RemoteOAuthCredentials {
  clientId: string;
  accessToken: string;
  refreshToken: string;
  accessTokenExpiresAt: string;
  tokenEndpoint: string;
  scope: string;
}

interface PwaConnectionBase {
  id: string;
  /** API base from the connect link (usually ending in `/api`). */
  serverUrl: string;
  projectId: string;
  projectName?: string;
  /**
   * For a paired-desktop connection: which of its projects also live on
   * a remote server (the desktop's remote-project links, ADR 0055),
   * keyed by the DESKTOP's project id. When the desktop is asleep or off
   * this network, the UI offers the mirror as the way in.
   */
  mirrors?: Record<
    string,
    { serverUrl: string; projectId: string; name: string }
  >;
  addedAt: string;
}

export interface RemotePwaConnection extends PwaConnectionBase {
  kind: "remote";
  credentials?: RemoteOAuthCredentials;
}

export interface DevicePwaConnection extends PwaConnectionBase {
  kind: "device";
  credentials: { accessToken: string };
}

export type PwaConnection = RemotePwaConnection | DevicePwaConnection;

export interface PwaProfile {
  id: string;
  name: string;
  color: string;
  connections: PwaConnection[];
}

export interface PwaState {
  version: 2;
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

const STORAGE_KEY = "catamorphic-pwa.v2";

/**
 * UUID v4 backed by getRandomValues, which remains available on the local
 * HTTP origin used by desktop pairing. crypto.randomUUID is secure-context
 * only and would abort this module before React can mount on that origin.
 */
function randomId(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x40;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function defaultState(): PwaState {
  const profile: PwaProfile = {
    id: randomId(),
    name: "You",
    color: PROFILE_COLORS[0],
    connections: [],
  };
  return { version: 2, profiles: [profile], activeProfileId: profile.id };
}

function load(): PwaState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw) as PwaState;
    if (
      parsed.version !== 2 ||
      !Array.isArray(parsed.profiles) ||
      parsed.profiles.length === 0
    ) {
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

/** The connection holding this exact server+project, if one exists. */
export function findConnection(
  current: PwaState,
  serverUrl: string,
  projectId: string,
): PwaConnection | undefined {
  for (const profile of current.profiles) {
    const found = profile.connections.find(
      (c) => c.serverUrl === serverUrl && c.projectId === projectId,
    );
    if (found) return found;
  }
  return undefined;
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

/** Add a remote locator, optionally completing it with OAuth credentials. */
export function addRemoteConnection(input: {
  profileId: string;
  link: ConnectLink;
  credentials?: RemoteOAuthCredentials;
  projectName?: string;
}): RemotePwaConnection {
  const existing = state.profiles
    .find((p) => p.id === input.profileId)
    ?.connections.find(
      (c) =>
        c.kind === "remote" &&
        c.serverUrl === input.link.serverUrl &&
        c.projectId === input.link.remoteProjectId,
    );
  const existingRemote = existing?.kind === "remote" ? existing : undefined;
  const credentials = input.credentials ?? existingRemote?.credentials;
  const connection: RemotePwaConnection = {
    id: existing?.id ?? randomId(),
    kind: "remote",
    serverUrl: input.link.serverUrl,
    projectId: input.link.remoteProjectId,
    ...(input.projectName || input.link.remoteProjectName
      ? { projectName: input.projectName ?? input.link.remoteProjectName }
      : {}),
    ...(credentials ? { credentials } : {}),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  updateProfile(input.profileId, (profile) => ({
    ...profile,
    connections: [
      ...profile.connections.filter((c) => c.id !== connection.id),
      connection,
    ],
  }));
  return connection;
}

/** Add or refresh the separate local credential issued by desktop pairing. */
export function addDeviceConnection(input: {
  profileId: string;
  serverUrl: string;
  name: string;
  accessToken: string;
  mirrors?: NonNullable<PwaConnection["mirrors"]>;
}): DevicePwaConnection {
  const serverUrl = input.serverUrl.replace(/\/+$/, "");
  const existing = state.profiles
    .find((profile) => profile.id === input.profileId)
    ?.connections.find(
      (connection) =>
        connection.kind === "device" && connection.serverUrl === serverUrl,
    );
  const connection: DevicePwaConnection = {
    id: existing?.id ?? randomId(),
    kind: "device",
    serverUrl,
    projectId: "",
    projectName: input.name,
    credentials: { accessToken: input.accessToken },
    ...(input.mirrors ? { mirrors: input.mirrors } : {}),
    addedAt: existing?.addedAt ?? new Date().toISOString(),
  };
  updateProfile(input.profileId, (profile) => ({
    ...profile,
    connections: [
      ...profile.connections.filter((item) => item.id !== connection.id),
      connection,
    ],
  }));
  return connection;
}

export function updateRemoteCredentials(
  connectionId: string,
  credentials: RemoteOAuthCredentials,
): void {
  for (const profile of state.profiles) {
    const source = profile.connections.find(
      (item) => item.id === connectionId && item.kind === "remote",
    );
    if (source?.kind !== "remote") continue;
    updateProfile(profile.id, (current) => ({
      ...current,
      connections: current.connections.map((connection) =>
        connection.kind === "remote" &&
        connection.serverUrl === source.serverUrl &&
        connection.credentials?.clientId === credentials.clientId
          ? { ...connection, credentials }
          : connection,
      ),
    }));
    return;
  }
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
    id: randomId(),
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
    version: 2,
    profiles,
    activeProfileId:
      state.activeProfileId === profileId ? first.id : state.activeProfileId,
  });
}
