import { randomBytes } from "node:crypto";
import http from "node:http";
import type { AddressInfo } from "node:net";
import type { AgentMcpServerConfig } from "@catamorphic/sandbox";
import {
  auth,
  extractWWWAuthenticateParams,
  type OAuthClientMetadata,
  type OAuthClientProvider,
  type OAuthDiscoveryState,
  SdkHttpError,
  type StoredOAuthClientInformation,
  type StoredOAuthTokens,
  UnauthorizedError,
} from "@modelcontextprotocol/client";
import { type ConnectMcpOpts, connectMcpServer } from "./client.js";
import type { McpOAuthClientHint } from "./marketplace.js";

/**
 * OAuth for remote MCP servers (the spec's authorization flow: RFC 9728
 * resource metadata → RFC 8414 server metadata → dynamic client
 * registration → PKCE authorization code). The SDK does the protocol; this
 * module owns the two things a desktop host must supply:
 *
 * - **Persistence.** One {@link McpOAuthState} per connection (client
 *   registration, tokens, discovery, in-flight PKCE verifier), handed in
 *   and out through a tiny store interface so the host keeps it wherever
 *   it keeps secrets.
 * - **The redirect leg.** A loopback HTTP listener on 127.0.0.1 (RFC 8252
 *   native-app style) receives the authorization code while the user
 *   consents in a browser tab the host opened.
 *
 * Tokens then ride as a plain `Authorization: Bearer` header in every
 * harness's server config ({@link bearerHeaders}) — the harnesses that
 * bring their own MCP client (Claude Code, Codex) never learn OAuth
 * exists, and {@link refreshMcpTokens} keeps the header fresh.
 */

export interface McpOAuthState {
  clientInformation?: StoredOAuthClientInformation;
  tokens?: StoredOAuthTokens;
  /** Wall-clock ms when `tokens` were obtained (for expiry math). */
  tokensObtainedAt?: number;
  discovery?: OAuthDiscoveryState;
  codeVerifier?: string;
}

export interface McpOAuthStore {
  load(): McpOAuthState;
  save(state: McpOAuthState): void;
}

/** Thrown (into the SDK's flow) when a non-interactive connect needs a
 * user; callers surface it as "authorize this connection". */
export class McpAuthorizationRequiredError extends Error {
  constructor(message = "This connection needs authorization") {
    super(message);
    this.name = "McpAuthorizationRequiredError";
  }
}

const CLIENT_NAME = "Catamorphic";

function clientMetadata(redirectUrl: string): OAuthClientMetadata {
  return {
    client_name: CLIENT_NAME,
    redirect_uris: [redirectUrl],
    grant_types: ["authorization_code", "refresh_token"],
    response_types: ["code"],
    token_endpoint_auth_method: "none",
  };
}

/**
 * An {@link OAuthClientProvider} over a {@link McpOAuthStore}. Interactive
 * when given `onRedirect` (the authorize flow); otherwise a redirect —
 * meaning the tokens are gone and only a user can get new ones — throws
 * {@link McpAuthorizationRequiredError}.
 */
export function createOAuthProvider(opts: {
  store: McpOAuthStore;
  redirectUrl: string;
  onRedirect?: (url: URL) => void | Promise<void>;
  /** OAuth `state` for this flow (the callback must echo it). */
  state?: string;
}): OAuthClientProvider {
  const { store, redirectUrl, onRedirect } = opts;
  const patch = (partial: Partial<McpOAuthState>) =>
    store.save({ ...store.load(), ...partial });
  return {
    get redirectUrl() {
      return redirectUrl;
    },
    get clientMetadata() {
      return clientMetadata(redirectUrl);
    },
    ...(opts.state ? { state: () => opts.state as string } : {}),
    clientInformation: () => store.load().clientInformation,
    saveClientInformation: (info) => patch({ clientInformation: info }),
    tokens: () => store.load().tokens,
    saveTokens: (tokens) => patch({ tokens, tokensObtainedAt: Date.now() }),
    codeVerifier: () => {
      const verifier = store.load().codeVerifier;
      if (!verifier) throw new Error("No PKCE verifier saved for this flow");
      return verifier;
    },
    saveCodeVerifier: (codeVerifier) => patch({ codeVerifier }),
    discoveryState: () => store.load().discovery,
    saveDiscoveryState: (discovery) => patch({ discovery }),
    redirectToAuthorization: async (url) => {
      if (!onRedirect) throw new McpAuthorizationRequiredError();
      await onRedirect(url);
    },
    invalidateCredentials: (scope) => {
      const state = store.load();
      if (scope === "all") {
        store.save({});
        return;
      }
      if (scope === "client") state.clientInformation = undefined;
      if (scope === "tokens") {
        state.tokens = undefined;
        state.tokensObtainedAt = undefined;
      }
      if (scope === "verifier") state.codeVerifier = undefined;
      if (scope === "discovery") state.discovery = undefined;
      store.save(state);
    },
  };
}

/** `Authorization: Bearer …` for a state that holds tokens, else nothing. */
export function bearerHeaders(
  state: McpOAuthState | undefined,
): Record<string, string> {
  const token = state?.tokens?.access_token;
  return token ? { Authorization: `Bearer ${token}` } : {};
}

/** Whether tokens are within `withinMs` of expiring (or already expired).
 * Tokens without an `expires_in` count as expiring hourly when a refresh
 * token exists (so they get renewed), never otherwise. */
export function tokensExpiring(
  state: McpOAuthState | undefined,
  withinMs = 5 * 60_000,
): boolean {
  const tokens = state?.tokens;
  if (!tokens || !state?.tokensObtainedAt) return false;
  if (!tokens.expires_in) {
    // No lifetime advertised: if we CAN refresh, do so hourly rather than
    // discovering the expiry from a 401 mid-conversation.
    return (
      Boolean(tokens.refresh_token) &&
      Date.now() + withinMs >= state.tokensObtainedAt + 60 * 60_000
    );
  }
  return (
    Date.now() + withinMs >= state.tokensObtainedAt + tokens.expires_in * 1000
  );
}

/** Whether a connect/probe failure means "the server wants a user to
 * authorize" (401 / the SDK's UnauthorizedError) rather than a bug. */
export function isAuthorizationError(error: unknown): boolean {
  if (UnauthorizedError.isInstance(error)) return true;
  if (error instanceof McpAuthorizationRequiredError) return true;
  if (SdkHttpError.isInstance(error) && error.status === 401) return true;
  const message = error instanceof Error ? error.message : String(error);
  return /\b(401|unauthori[sz]ed|authentication (failed|required))\b/i.test(
    message,
  );
}

const CALLBACK_PATH = "/callback";
const AUTHORIZE_TIMEOUT_MS = 5 * 60_000;

/**
 * Run the interactive authorization for a remote server: open the consent
 * page (via `openUrl`), receive the code on a loopback listener, exchange
 * it, then connect once to prove the tokens work. Resolves with the tool
 * count; rejects if the user declined, the flow timed out, or the server
 * turned out not to need auth at all (`alreadyAuthorized` covers that).
 */
export async function authorizeMcpServer(
  config: AgentMcpServerConfig,
  opts: {
    store: McpOAuthStore;
    /** Open the consent URL for the user (browser tab, external browser). */
    openUrl: (url: string) => void | Promise<void>;
    /** Called when the loopback listener has served the callback — the
     * host can close the tab it opened. */
    onCallbackServed?: (callbackOrigin: string) => void;
    timeoutMs?: number;
    connect?: ConnectMcpOpts;
    /**
     * A pre-registered client (plugin `.mcp.json` `oauth` block): skips
     * dynamic registration and listens on the port its redirect URI was
     * registered with — servers without registration (Slack) need this.
     */
    client?: McpOAuthClientHint;
  },
): Promise<{ toolCount: number; alreadyAuthorized: boolean }> {
  if (config.transport === "stdio") {
    throw new Error("Only remote (http/sse) servers use OAuth");
  }
  // The callback must echo this — a stray or crafted hit on the loopback
  // port must not be able to finish (or abort) the flow.
  const state = randomBytes(16).toString("hex");
  const listener = await startLoopbackListener(
    opts.client?.callbackPort,
    state,
  );
  try {
    const store = opts.store;
    // Fresh registration every time (the redirect URI carries this run's
    // port) — unless the client is pre-registered, in which case that IS
    // the registration. Stale tokens are exactly what brought us here.
    store.save({
      ...store.load(),
      clientInformation: opts.client
        ? {
            client_id: opts.client.clientId,
            redirect_uris: [listener.redirectUrl],
            token_endpoint_auth_method: "none",
          }
        : undefined,
      tokens: undefined,
      tokensObtainedAt: undefined,
      codeVerifier: undefined,
    });
    let redirected: URL | null = null;
    const provider = createOAuthProvider({
      store,
      redirectUrl: listener.redirectUrl,
      state,
      onRedirect: (url) => {
        redirected = url;
      },
    });
    // The server's own 401 challenge names its resource metadata and the
    // scopes it wants; discovery from those beats guessing well-known
    // paths off the server URL.
    const challenge = await readAuthChallenge(config);
    const scope = opts.client?.scopes?.join(" ") || challenge.scope;
    const result = await auth(provider, {
      serverUrl: config.url,
      ...(challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
      ...(scope ? { scope } : {}),
    });
    if (result === "AUTHORIZED") {
      // Non-interactive success (client credentials on a permissive AS, or
      // a refresh that still worked): nothing to show the user.
      const server = await connectMcpServer(
        withBearer(config, store),
        opts.connect,
      );
      const toolCount = server.tools.length;
      await server.close().catch(() => {});
      return { toolCount, alreadyAuthorized: true };
    }
    if (!redirected) throw new Error("Authorization did not produce a URL");
    await opts.openUrl(String(redirected));
    const callback = await listener.waitForCallback(
      opts.timeoutMs ?? AUTHORIZE_TIMEOUT_MS,
    );
    opts.onCallbackServed?.(listener.origin);
    if (callback.error) {
      throw new Error(
        callback.errorDescription
          ? `${callback.error}: ${callback.errorDescription}`
          : `Authorization failed: ${callback.error}`,
      );
    }
    const finished = await auth(provider, {
      serverUrl: config.url,
      ...(challenge.resourceMetadataUrl
        ? { resourceMetadataUrl: challenge.resourceMetadataUrl }
        : {}),
      authorizationCode: callback.code,
      ...(callback.iss ? { iss: callback.iss } : {}),
    });
    if (finished !== "AUTHORIZED") {
      throw new Error("Authorization did not complete");
    }
    store.save({ ...store.load(), codeVerifier: undefined });
    const server = await connectMcpServer(
      withBearer(config, store),
      opts.connect,
    );
    const toolCount = server.tools.length;
    await server.close().catch(() => {});
    return { toolCount, alreadyAuthorized: false };
  } finally {
    listener.close();
  }
}

/**
 * Refresh the tokens in a store when they're near expiry (or forced).
 * Returns whether the store now holds tokens the caller can trust. Never
 * opens a browser: a refresh that needs a user reports `false` and leaves
 * the state for {@link authorizeMcpServer}.
 */
export async function refreshMcpTokens(
  config: AgentMcpServerConfig,
  store: McpOAuthStore,
  opts: { force?: boolean } = {},
): Promise<boolean> {
  if (config.transport === "stdio") return false;
  const state = store.load();
  if (!state.tokens) return false;
  if (!opts.force && !tokensExpiring(state)) return true;
  if (!state.tokens.refresh_token) return !tokensExpiring(state, 0);
  const provider = createOAuthProvider({
    store,
    // Never used: no onRedirect means a redirect throws instead.
    redirectUrl: `http://127.0.0.1${CALLBACK_PATH}`,
  });
  try {
    return (await auth(provider, { serverUrl: config.url })) === "AUTHORIZED";
  } catch {
    return false;
  }
}

/** One unauthenticated request to read the WWW-Authenticate challenge. */
async function readAuthChallenge(
  config: Extract<AgentMcpServerConfig, { url: string }>,
): Promise<{ resourceMetadataUrl?: URL; scope?: string }> {
  try {
    const response = await fetch(config.url, {
      method: "POST",
      headers: {
        ...config.headers,
        "content-type": "application/json",
        accept: "application/json, text/event-stream",
      },
      body: JSON.stringify({ jsonrpc: "2.0", id: 0, method: "ping" }),
    });
    await response.body?.cancel().catch(() => {});
    if (response.status !== 401) return {};
    const { resourceMetadataUrl, scope } =
      extractWWWAuthenticateParams(response);
    return { resourceMetadataUrl, scope };
  } catch {
    return {};
  }
}

function withBearer(
  config: AgentMcpServerConfig,
  store: McpOAuthStore,
): AgentMcpServerConfig {
  if (config.transport === "stdio") return config;
  return {
    ...config,
    headers: { ...config.headers, ...bearerHeaders(store.load()) },
  };
}

interface CallbackParams {
  code?: string;
  iss?: string;
  error?: string;
  errorDescription?: string;
}

/**
 * The redirect leg. Loopback ONLY — never a LAN-reachable socket: an
 * ephemeral port on 127.0.0.1 by default; a fixed `port` (pre-registered
 * client) on 127.0.0.1 and, best effort, ::1, advertising `localhost`
 * (the host such registrations use; browsers try both families).
 * Callbacks without the expected `state` are ignored (404), so a stray
 * hit can neither finish nor abort the flow.
 */
async function startLoopbackListener(
  port: number | undefined,
  expectedState: string,
): Promise<{
  redirectUrl: string;
  origin: string;
  waitForCallback(timeoutMs: number): Promise<CallbackParams>;
  close(): void;
}> {
  let resolveCallback: ((params: CallbackParams) => void) | null = null;
  const received = new Promise<CallbackParams>((resolve) => {
    resolveCallback = resolve;
  });
  const handler: http.RequestListener = (request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (
      url.pathname !== CALLBACK_PATH ||
      url.searchParams.get("state") !== expectedState
    ) {
      response.writeHead(404).end();
      return;
    }
    const params: CallbackParams = {
      code: url.searchParams.get("code") ?? undefined,
      iss: url.searchParams.get("iss") ?? undefined,
      error: url.searchParams.get("error") ?? undefined,
      errorDescription: url.searchParams.get("error_description") ?? undefined,
    };
    response.writeHead(200, {
      "content-type": "text/html; charset=utf-8",
      "cache-control": "no-store",
    });
    response.end(callbackPage(params));
    resolveCallback?.(params);
  };
  const server = http.createServer(handler);
  await new Promise<void>((resolve, reject) => {
    server.once("error", (error: NodeJS.ErrnoException) =>
      reject(
        error.code === "EADDRINUSE" && port
          ? new Error(
              `Port ${port} is busy — another app is holding this connector's OAuth callback port`,
            )
          : error,
      ),
    );
    server.listen(port ?? 0, "127.0.0.1", () => resolve());
  });
  const bound = (server.address() as AddressInfo).port;
  // Fixed port: `localhost` may resolve to ::1 first; listen there too if
  // we can (a missing/blocked v6 loopback is not an error).
  const v6 = port ? http.createServer(handler) : null;
  if (v6) {
    await new Promise<void>((resolve) => {
      v6.once("error", () => resolve());
      v6.listen(bound, "::1", () => resolve());
    });
  }
  const origin = port
    ? `http://localhost:${bound}`
    : `http://127.0.0.1:${bound}`;
  return {
    redirectUrl: `${origin}${CALLBACK_PATH}`,
    origin,
    waitForCallback: (timeoutMs) =>
      new Promise<CallbackParams>((resolve, reject) => {
        const timer = setTimeout(
          () => reject(new Error("Authorization timed out")),
          timeoutMs,
        );
        void received.then((params) => {
          clearTimeout(timer);
          resolve(params);
        });
      }),
    close: () => {
      server.close();
      v6?.close();
      // Any lingering keep-alive sockets shouldn't pin the process.
      server.closeAllConnections?.();
      v6?.closeAllConnections?.();
    },
  };
}

/** The page the consent redirect lands on. Plain, self-contained; the
 * host closes the tab moments later anyway. */
function callbackPage(params: CallbackParams): string {
  const ok = !params.error && Boolean(params.code);
  const title = ok ? "Connected" : "Authorization failed";
  const detail = ok
    ? "You can close this tab and go back to Catamorphic."
    : escapeHtml(params.errorDescription ?? params.error ?? "Unknown error");
  return `<!doctype html><html><head><meta charset="utf-8"><title>${title}</title>
<style>
  :root{color-scheme:dark light}
  body{margin:0;min-height:100vh;display:grid;place-items:center;font:14px/1.5 Inter,system-ui,sans-serif;background:#0a0a0b;color:#e6e6e6}
  @media (prefers-color-scheme:light){body{background:#fafafa;color:#1a1a1a}}
  main{text-align:center;padding:32px}
  h1{font-size:18px;font-weight:600;margin:0 0 8px}
  p{margin:0;opacity:.7}
  .dot{display:inline-block;width:10px;height:10px;border-radius:50%;background:${ok ? "#4ade80" : "#f87171"};margin-bottom:16px}
</style></head><body><main><span class="dot"></span><h1>${title}</h1><p>${detail}</p></main></body></html>`;
}

function escapeHtml(text: string): string {
  return text.replace(
    /[&<>"']/g,
    (char) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        char
      ] ?? char,
  );
}
