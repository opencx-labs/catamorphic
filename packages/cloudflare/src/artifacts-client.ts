/**
 * Minimal REST client for Cloudflare Artifacts
 * (https://developers.cloudflare.com/artifacts/api/rest-api/).
 *
 * Control-plane routes (create/get/delete repo, issue tokens) authenticate
 * with a Cloudflare API token. Git data-plane operations use short-lived
 * per-repo tokens issued by {@link ArtifactsClient.createToken}.
 */

export interface ArtifactsClientOpts {
  accountId: string;
  /** Cloudflare API token with Artifacts permissions. */
  apiToken: string;
  /**
   * Namespace all repos live under. Namespaces are created implicitly on
   * first repo creation.
   */
  namespace: string;
  /** Defaults to the public Cloudflare v4 API. */
  apiBaseUrl?: string;
  /** Testing hook. */
  fetch?: typeof fetch;
}

export interface ArtifactsRepo {
  id: string;
  name: string;
  defaultBranch: string;
  /** Git smart-HTTP remote URL. */
  remote: string;
}

export interface ArtifactsRepoToken {
  id: string;
  /** Full token string (`art_v1_<secret>?expires=<unix>`). */
  plaintext: string;
  scope: "read" | "write";
  expiresAt: string;
}

interface Envelope<T> {
  result: T | null;
  success: boolean;
  errors: { code: number; message: string }[];
}

export class ArtifactsApiError extends Error {
  readonly status: number;
  readonly codes: number[];

  constructor(opts: { message: string; status: number; codes?: number[] }) {
    super(opts.message);
    this.name = "ArtifactsApiError";
    this.status = opts.status;
    this.codes = opts.codes ?? [];
  }
}

/**
 * Git Basic auth wants only the secret part of a repo token — strip the
 * `?expires=<unix>` suffix Artifacts appends.
 */
export function tokenSecret(token: string): string {
  const idx = token.indexOf("?expires=");
  return idx === -1 ? token : token.slice(0, idx);
}

export class ArtifactsClient {
  readonly namespace: string;

  private readonly baseUrl: string;
  private readonly apiToken: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ArtifactsClientOpts) {
    this.namespace = opts.namespace;
    this.apiToken = opts.apiToken;
    const apiBase = (
      opts.apiBaseUrl ?? "https://api.cloudflare.com/client/v4"
    ).replace(/\/+$/, "");
    this.baseUrl = `${apiBase}/accounts/${opts.accountId}/artifacts/namespaces/${encodeURIComponent(opts.namespace)}`;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
  }

  async createRepo(opts: {
    name: string;
    defaultBranch?: string;
    description?: string;
  }): Promise<ArtifactsRepo & { token: string }> {
    const result = await this.request<{
      id: string;
      name: string;
      default_branch: string;
      remote: string;
      token: string;
    }>("POST", "/repos", {
      name: opts.name,
      default_branch: opts.defaultBranch ?? "main",
      description: opts.description,
    });
    return {
      id: result.id,
      name: result.name,
      defaultBranch: result.default_branch,
      remote: result.remote,
      token: result.token,
    };
  }

  async getRepo(name: string): Promise<ArtifactsRepo | null> {
    try {
      const result = await this.request<{
        id: string;
        name: string;
        default_branch: string;
        remote: string;
      }>("GET", `/repos/${encodeURIComponent(name)}`);
      return {
        id: result.id,
        name: result.name,
        defaultBranch: result.default_branch,
        remote: result.remote,
      };
    } catch (err) {
      if (err instanceof ArtifactsApiError && err.status === 404) return null;
      throw err;
    }
  }

  async deleteRepo(name: string): Promise<void> {
    try {
      await this.request<{ id: string }>(
        "DELETE",
        `/repos/${encodeURIComponent(name)}`,
      );
    } catch (err) {
      if (err instanceof ArtifactsApiError && err.status === 404) return;
      throw err;
    }
  }

  /**
   * Issue a short-lived per-repo git token. `ttl` is in seconds (min 60,
   * default 1 hour here — callers should treat tokens as ephemeral).
   */
  async createToken(opts: {
    repo: string;
    scope: "read" | "write";
    ttl?: number;
  }): Promise<ArtifactsRepoToken> {
    const result = await this.request<{
      id: string;
      plaintext: string;
      scope: "read" | "write";
      expires_at: string;
    }>("POST", "/tokens", {
      repo: opts.repo,
      scope: opts.scope,
      ttl: opts.ttl ?? 3600,
    });
    return {
      id: result.id,
      plaintext: result.plaintext,
      scope: result.scope,
      expiresAt: result.expires_at,
    };
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
  ): Promise<T> {
    const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
      method,
      headers: {
        Authorization: `Bearer ${this.apiToken}`,
        ...(body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    const envelope = (await response
      .json()
      .catch(() => null)) as Envelope<T> | null;

    if (!response.ok || !envelope?.success || envelope.result === null) {
      const errors = envelope?.errors ?? [];
      throw new ArtifactsApiError({
        message:
          errors.map((e) => `${e.code}: ${e.message}`).join("; ") ||
          `Artifacts request failed: ${method} ${path} → ${response.status}`,
        status: response.status,
        codes: errors.map((e) => e.code),
      });
    }

    return envelope.result;
  }
}
