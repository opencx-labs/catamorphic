import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

/**
 * Remote projects (ADR 0055): a local folder synced from a hosting
 * backend's scoped documents surface. One entry per LOCAL project id: which
 * server, which remote project, the member's bearer token (encrypted at
 * rest via safeStorage, like agent API keys), and when it last synced.
 * Profile-level: a profile is a person, and the token is theirs.
 */
/** What the server said this member may do (`GET /me`, ADR 0055). */
export interface RemoteCapabilities {
  builder: boolean;
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
  /** The remote API base, e.g. https://brain.acme.com/api */
  serverUrl: string;
  remoteProjectId: string;
  remoteProjectName: string;
  lastSyncAt: string | null;
  /** Where the user gets a fresh link when the token stops working. */
  renewUrl?: string;
  /** Last introspection result; absent on hosts without `GET /me`. */
  capabilities?: RemoteCapabilities;
}

export interface RemoteProjectLinkWithToken extends RemoteProjectLink {
  token: string;
}

interface StoredLink extends RemoteProjectLink {
  tokenEncrypted?: string;
  tokenPlaintext?: string;
}

interface StoreFile {
  version: 1;
  links: Record<string, StoredLink>;
}

export class RemoteProjectsStore {
  private data: StoreFile;

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

  get(localProjectId: string): RemoteProjectLinkWithToken | null {
    const stored = this.data.links[localProjectId];
    if (!stored) return null;
    return { ...publicLink(stored), token: this.decrypt(stored) };
  }

  set(localProjectId: string, link: RemoteProjectLinkWithToken): void {
    const { token, ...rest } = link;
    this.data.links[localProjectId] = { ...rest, ...this.encrypt(token) };
    this.save();
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
    delete this.data.links[localProjectId];
    this.save();
  }

  private load(): StoreFile {
    try {
      const raw = JSON.parse(
        fs.readFileSync(this.filePath, "utf8"),
      ) as Partial<StoreFile>;
      if (
        raw &&
        raw.version === 1 &&
        raw.links &&
        typeof raw.links === "object"
      ) {
        return { version: 1, links: raw.links };
      }
    } catch {
      // Missing or unreadable: start empty.
    }
    return { version: 1, links: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    fs.writeFileSync(this.filePath, `${JSON.stringify(this.data, null, 2)}\n`);
  }

  private encrypt(
    token: string,
  ): Pick<StoredLink, "tokenEncrypted" | "tokenPlaintext"> {
    if (safeStorage.isEncryptionAvailable()) {
      return {
        tokenEncrypted: safeStorage.encryptString(token).toString("base64"),
      };
    }
    console.warn(
      "[desktop] OS keychain encryption unavailable; storing remote token in plaintext.",
    );
    return { tokenPlaintext: token };
  }

  private decrypt(stored: StoredLink): string {
    if (stored.tokenEncrypted) {
      try {
        return safeStorage.decryptString(
          Buffer.from(stored.tokenEncrypted, "base64"),
        );
      } catch {
        return "";
      }
    }
    return stored.tokenPlaintext ?? "";
  }
}

function publicLink(stored: StoredLink): RemoteProjectLink {
  return {
    serverUrl: stored.serverUrl,
    remoteProjectId: stored.remoteProjectId,
    remoteProjectName: stored.remoteProjectName,
    lastSyncAt: stored.lastSyncAt ?? null,
    ...(stored.renewUrl ? { renewUrl: stored.renewUrl } : {}),
    ...(stored.capabilities ? { capabilities: stored.capabilities } : {}),
  };
}
