import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { safeStorage } from "electron";
import { z } from "zod";
import {
  CredentialStorageError,
  credentialUnlockError,
  requireCredentialEncryption,
} from "./credential-encryption.js";

/**
 * Per-profile bindings for PROJECT agents:
 * `<userData>/profiles/<id>/agent-bindings.json`.
 *
 * A project agent definition (`.work/agents/<slug>.json`, ADR 0050) is
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

export interface AgentBindingMetadata {
  consentHash: string;
  auth?: { mode: "local" } | { mode: "api-key"; hasApiKey: boolean };
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
      return z
        .strictObject({
          bindings: z.record(
            z.string(),
            z.strictObject({
              consentHash: z.string(),
              auth: z
                .discriminatedUnion("mode", [
                  z.strictObject({ mode: z.literal("local") }),
                  z.strictObject({
                    mode: z.literal("api-key"),
                    apiKeyEncrypted: z.string().min(1).optional(),
                    apiKeyPlaintext: z.string().optional(),
                  }),
                ])
                .optional(),
            }),
          ),
        })
        .parse(JSON.parse(fs.readFileSync(this.file, "utf-8")));
    } catch (cause) {
      if (cause instanceof Error && "code" in cause && cause.code === "ENOENT")
        return { bindings: {} };
      throw new Error(
        "Project agent credentials could not be opened. Restore the saved settings or reconnect the affected agent in Settings.",
        { cause },
      );
    }
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${randomUUID()}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
      flag: "wx",
    });
    fs.renameSync(temporary, this.file);
  }

  get(projectId: string, slug: string): AgentBinding | undefined {
    const stored = this.data.bindings[bindingKey(projectId, slug)];
    return stored ? this.decrypt(stored) : undefined;
  }

  /** Consent inspection never needs to unlock the person's credential. */
  getMetadata(
    projectId: string,
    slug: string,
  ): AgentBindingMetadata | undefined {
    const stored = this.data.bindings[bindingKey(projectId, slug)];
    if (!stored) return undefined;
    if (!stored.auth) return { consentHash: stored.consentHash };
    if (stored.auth.mode === "local")
      return { consentHash: stored.consentHash, auth: { mode: "local" } };
    return {
      consentHash: stored.consentHash,
      auth: {
        mode: "api-key",
        hasApiKey:
          stored.auth.apiKeyEncrypted !== undefined ||
          stored.auth.apiKeyPlaintext !== undefined,
      },
    };
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
    requireCredentialEncryption();
    return {
      mode: "api-key",
      apiKeyEncrypted: safeStorage
        .encryptString(auth.apiKey)
        .toString("base64"),
    };
  }

  private decrypt(stored: StoredBinding): AgentBinding {
    if (!stored.auth) return { consentHash: stored.consentHash };
    if (stored.auth.mode === "local") {
      return { consentHash: stored.consentHash, auth: { mode: "local" } };
    }
    if (stored.auth.apiKeyPlaintext !== undefined)
      throw new CredentialStorageError(
        "This project agent's saved credential is not encrypted. Reconnect the agent in Settings to save it securely. The existing settings have been preserved.",
      );
    let apiKey: string | null = null;
    if (stored.auth.apiKeyEncrypted) {
      requireCredentialEncryption();
      try {
        apiKey = safeStorage.decryptString(
          Buffer.from(stored.auth.apiKeyEncrypted, "base64"),
        );
      } catch (cause) {
        throw credentialUnlockError({ cause });
      }
    }
    return {
      consentHash: stored.consentHash,
      auth: { mode: "api-key", apiKey },
    };
  }
}
