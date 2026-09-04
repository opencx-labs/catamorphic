import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import type { RemoteOAuthCredentials } from "./remote-oauth.js";

/**
 * Remote projects (ADR 0055): a local folder synced from a hosting
 * backend's scoped documents surface. One entry per LOCAL project id: which
 * server, which remote project, refreshable OAuth credentials encrypted at
 * rest via safeStorage, and when it last synced.
 */
/** What the server said this member may do (`GET /me`, ADR 0055). */
export interface RemoteCapabilities {
  builder: boolean;
  source: { remoteUrl: string; defaultBranch: string } | null;
  permissions: string[];
  agents: string[];
  documents: Array<{ path: string; access: "read" | "write" }>;
  features: {
    publications: "public" | "members" | false;
    proposals: boolean;
    proposalsOpenPullRequests: boolean;
    mcp: boolean;
    agentSessions: boolean;
    storeUploadMaxBytes: number;
  };
}

export interface RemoteProjectLink {
  /** Stable key joining this folder locator to profile-local credentials. */
  connectionId: string;
  /** The remote API base, e.g. https://brain.acme.com/api */
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName: string;
  lastSyncAt: string | null;
  /** Last introspection result; absent on hosts without `GET /me`. */
  capabilities?: RemoteCapabilities;
}

export interface RemoteProjectLinkWithCredentials extends RemoteProjectLink {
  credentials: RemoteOAuthCredentials;
}

export interface RemoteProjectInspection {
  link: RemoteProjectLink;
  credentials: RemoteOAuthCredentials | null;
}

interface StoredCredentials {
  credentialsEncrypted?: string;
}

interface StoreFile {
  version: 3;
  links: Record<string, RemoteProjectLink>;
  credentials: Record<string, StoredCredentials>;
}

export const REMOTE_PROJECT_LOCATOR_PATH = ".catamorphic/remote.json";

interface RemoteProjectLocatorFile {
  version: 1;
  connectionId: string;
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName: string;
}

export class RemoteProjectsStore {
  private data: StoreFile;
  private readonly sessionCredentials = new Map<
    string,
    RemoteOAuthCredentials
  >();
  private readonly refreshes = new Map<
    string,
    Promise<RemoteOAuthCredentials>
  >();

  constructor(private readonly filePath: string) {
    this.data = this.load();
  }

  list(): Record<string, RemoteProjectLink> {
    return Object.fromEntries(
      Object.entries(this.data.links).map(([id, stored]) => [
        id,
        publicLink(stored),
      ]),
    );
  }

  get(localProjectId: string): RemoteProjectLinkWithCredentials | null {
    const inspected = this.inspect(localProjectId);
    if (!inspected?.credentials) return null;
    return { ...inspected.link, credentials: inspected.credentials };
  }

  inspect(localProjectId: string): RemoteProjectInspection | null {
    const link = this.data.links[localProjectId];
    if (!link) return null;
    return {
      link,
      credentials:
        this.sessionCredentials.get(link.connectionId) ??
        this.decrypt(this.data.credentials[link.connectionId]),
    };
  }

  set(localProjectId: string, link: RemoteProjectLinkWithCredentials): void {
    const { credentials, ...rest } = link;
    this.data.links[localProjectId] = rest;
    this.storeCredentials(link.connectionId, credentials);
    this.save();
  }

  setLocator(localProjectId: string, link: RemoteProjectLink): void {
    this.data.links[localProjectId] = link;
    this.save();
  }

  updateCredentials(
    localProjectId: string,
    credentials: RemoteOAuthCredentials,
  ): void {
    const link = this.data.links[localProjectId];
    if (!link) return;
    this.storeCredentials(link.connectionId, credentials);
    this.save();
  }

  /** One live token supplier shared by status, sync, ship, and mirroring. */
  async accessToken(
    localProjectId: string,
    options: {
      forceRefresh?: boolean;
      refresh(
        credentials: RemoteOAuthCredentials,
      ): Promise<RemoteOAuthCredentials>;
    },
  ): Promise<string> {
    const inspected = this.inspect(localProjectId);
    if (!inspected?.credentials) {
      throw new Error("Sign in again to reconnect this project");
    }
    const credentials = inspected.credentials;
    const expiresAt = Date.parse(credentials.accessTokenExpiresAt);
    const expired =
      !Number.isFinite(expiresAt) || expiresAt <= Date.now() + 60_000;
    if (!options.forceRefresh && !expired) return credentials.accessToken;

    const connectionId = inspected.link.connectionId;
    const existing = this.refreshes.get(connectionId);
    if (existing) return (await existing).accessToken;
    const refresh = options
      .refresh(credentials)
      .then((next) => {
        this.updateCredentials(localProjectId, next);
        return next;
      })
      .finally(() => this.refreshes.delete(connectionId));
    this.refreshes.set(connectionId, refresh);
    return (await refresh).accessToken;
  }

  touch(
    localProjectId: string,
    lastSyncAt: string,
    capabilities?: RemoteCapabilities,
  ): void {
    const stored = this.data.links[localProjectId];
    if (!stored) return;
    stored.lastSyncAt = lastSyncAt;
    if (capabilities) stored.capabilities = capabilities;
    this.save();
  }

  delete(localProjectId: string): void {
    if (!(localProjectId in this.data.links)) return;
    const connectionId = this.data.links[localProjectId]?.connectionId;
    delete this.data.links[localProjectId];
    if (
      connectionId &&
      !Object.values(this.data.links).some(
        (link) => link.connectionId === connectionId,
      )
    ) {
      delete this.data.credentials[connectionId];
      this.sessionCredentials.delete(connectionId);
    }
    this.save();
  }

  private load(): StoreFile {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<StoreFile>;
      if (
        raw &&
        raw.version === 3 &&
        raw.links &&
        typeof raw.links === "object" &&
        raw.credentials &&
        typeof raw.credentials === "object"
      ) {
        return {
          version: 3,
          links: raw.links,
          credentials: raw.credentials,
        };
      }
    } catch {
      // Missing or unreadable: start empty.
    }
    return { version: 3, links: {}, credentials: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.chmodSync(this.filePath, 0o600);
  }

  private storeCredentials(
    connectionId: string,
    credentials: RemoteOAuthCredentials,
  ): void {
    this.sessionCredentials.set(connectionId, credentials);
    const encrypted = this.encrypt(credentials);
    if (encrypted) this.data.credentials[connectionId] = encrypted;
    else delete this.data.credentials[connectionId];
  }

  private encrypt(
    credentials: RemoteOAuthCredentials,
  ): StoredCredentials | null {
    const serialized = JSON.stringify(credentials);
    if (safeStorage.isEncryptionAvailable()) {
      return {
        credentialsEncrypted: safeStorage
          .encryptString(serialized)
          .toString("base64"),
      };
    }
    console.warn(
      "[desktop] OS keychain encryption unavailable; remote credentials will last only for this session.",
    );
    return null;
  }

  private decrypt(
    stored: StoredCredentials | undefined,
  ): RemoteOAuthCredentials | null {
    if (!stored) return null;
    if (!stored.credentialsEncrypted) return null;
    let serialized: string;
    try {
      serialized = safeStorage.decryptString(
        Buffer.from(stored.credentialsEncrypted, "base64"),
      );
    } catch {
      return null;
    }
    try {
      const parsed = JSON.parse(serialized) as Partial<RemoteOAuthCredentials>;
      if (
        typeof parsed.clientId !== "string" ||
        typeof parsed.accessToken !== "string" ||
        typeof parsed.refreshToken !== "string" ||
        typeof parsed.accessTokenExpiresAt !== "string" ||
        typeof parsed.tokenEndpoint !== "string" ||
        typeof parsed.scope !== "string"
      ) {
        return null;
      }
      return {
        clientId: parsed.clientId,
        accessToken: parsed.accessToken,
        refreshToken: parsed.refreshToken,
        accessTokenExpiresAt: parsed.accessTokenExpiresAt,
        tokenEndpoint: parsed.tokenEndpoint,
        scope: parsed.scope,
      };
    } catch {
      return null;
    }
  }
}

function publicLink(stored: RemoteProjectLink): RemoteProjectLink {
  return {
    connectionId: stored.connectionId,
    serverUrl: stored.serverUrl,
    remoteProjectId: stored.remoteProjectId,
    remoteProjectName: stored.remoteProjectName,
    lastSyncAt: stored.lastSyncAt ?? null,
    ...(stored.capabilities ? { capabilities: stored.capabilities } : {}),
  };
}

export function writeRemoteProjectLocator(
  rootPath: string,
  link: RemoteProjectLink,
): void {
  const filePath = path.join(rootPath, REMOTE_PROJECT_LOCATOR_PATH);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const locator: RemoteProjectLocatorFile = {
    version: 1,
    connectionId: link.connectionId,
    serverUrl: link.serverUrl,
    remoteProjectId: link.remoteProjectId,
    remoteProjectName: link.remoteProjectName,
  };
  fs.writeFileSync(filePath, `${JSON.stringify(locator, null, 2)}\n`);
}

export function readRemoteProjectLocator(
  rootPath: string,
): RemoteProjectLink | null {
  try {
    const value = JSON.parse(
      fs.readFileSync(path.join(rootPath, REMOTE_PROJECT_LOCATOR_PATH), "utf8"),
    ) as Partial<RemoteProjectLocatorFile>;
    if (
      value.version !== 1 ||
      typeof value.connectionId !== "string" ||
      typeof value.serverUrl !== "string" ||
      typeof value.remoteProjectId !== "string" ||
      typeof value.remoteProjectName !== "string"
    ) {
      return null;
    }
    const server = new URL(value.serverUrl);
    if (server.protocol !== "https:" && server.protocol !== "http:") {
      return null;
    }
    return {
      connectionId: value.connectionId,
      serverUrl: value.serverUrl.replace(/\/+$/, ""),
      remoteProjectId: value.remoteProjectId,
      remoteProjectName: value.remoteProjectName,
      lastSyncAt: null,
    };
  } catch {
    return null;
  }
}
