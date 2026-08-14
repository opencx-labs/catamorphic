import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";

/**
 * Per-profile bindings for PROJECT agents:
 * `<userData>/profiles/<id>/agent-bindings.json`.
 *
 * A project agent definition (`agents/<slug>.json`, ADR 0050) is
 * collaborator-authored code committed to the repo. Before it may run with
 * this user's OWN credentials, the profile must hold a consent record for
 * `(projectId, slug)` whose `consentHash` matches the definition's current
 * {@link definitionHash} — covering kind, model, credentials, acp
 * transport, and the persona file. Any change to those makes the stored
 * consent stale and the agent must be re-approved.
 *
 * The binding also carries HOW the approved agent authenticates for this
 * user: the machine's own CLI login (`local`) or an explicit API key,
 * encrypted at rest via safeStorage exactly like the profile agent roster
 * (`agents-store.ts`). `credentials.source: "secret"` definitions never
 * appear here — the project secret is the authorization and the desktop
 * resolves it through core's SecretsService at provider build time.
 */
export type BindingAuth =
  | { mode: "local" }
  | { mode: "api-key"; apiKey: string | null };

export interface AgentBinding {
  consentHash: string;
  auth?: BindingAuth;
}

type StoredAuth =
  | { mode: "local" }
  | { mode: "api-key"; apiKeyEncrypted?: string; apiKeyPlaintext?: string };

interface StoredBinding {
  consentHash: string;
  auth?: StoredAuth;
}

interface BindingsFile {
  bindings: Record<string, StoredBinding>;
}

const bindingKey = (projectId: string, slug: string) => `${projectId}/${slug}`;

export class AgentBindingsStore {
  private data: BindingsFile;

  constructor(private readonly file: string) {
    this.data = this.load();
  }

  private load(): BindingsFile {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, "utf-8"));
      if (raw && typeof raw.bindings === "object" && raw.bindings !== null) {
        return raw as BindingsFile;
      }
    } catch {
      // First run.
    }
    return { bindings: {} };
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
  }

  get(projectId: string, slug: string): AgentBinding | undefined {
    const stored = this.data.bindings[bindingKey(projectId, slug)];
    return stored ? this.decrypt(stored) : undefined;
  }

  /** Record consent for the definition state captured by `consentHash`. */
  bind(projectId: string, slug: string, binding: AgentBinding): AgentBinding {
    const stored: StoredBinding = {
      consentHash: binding.consentHash,
      ...(binding.auth ? { auth: this.encryptAuth(binding.auth) } : {}),
    };
    this.data.bindings[bindingKey(projectId, slug)] = stored;
    this.save();
    return this.decrypt(stored);
  }

  remove(projectId: string, slug: string): boolean {
    const key = bindingKey(projectId, slug);
    if (!(key in this.data.bindings)) return false;
    delete this.data.bindings[key];
    this.save();
    return true;
  }

  private encryptAuth(auth: BindingAuth): StoredAuth {
    if (auth.mode === "local") return { mode: "local" };
    if (!auth.apiKey) return { mode: "api-key" };
    if (safeStorage.isEncryptionAvailable()) {
      return {
        mode: "api-key",
        apiKeyEncrypted: safeStorage
          .encryptString(auth.apiKey)
          .toString("base64"),
      };
    }
    console.warn(
      "[desktop] OS keychain encryption unavailable; storing API key in plaintext.",
    );
    return { mode: "api-key", apiKeyPlaintext: auth.apiKey };
  }

  private decrypt(stored: StoredBinding): AgentBinding {
    if (!stored.auth) return { consentHash: stored.consentHash };
    if (stored.auth.mode === "local") {
      return { consentHash: stored.consentHash, auth: { mode: "local" } };
    }
    let apiKey: string | null = null;
    if (stored.auth.apiKeyEncrypted) {
      try {
        apiKey = safeStorage.decryptString(
          Buffer.from(stored.auth.apiKeyEncrypted, "base64"),
        );
      } catch {
        apiKey = null;
      }
    } else {
      apiKey = stored.auth.apiKeyPlaintext ?? null;
    }
    return {
      consentHash: stored.consentHash,
      auth: { mode: "api-key", apiKey },
    };
  }
}
