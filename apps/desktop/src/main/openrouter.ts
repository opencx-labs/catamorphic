import { createHash, randomBytes } from "node:crypto";
import http from "node:http";

/**
 * OpenRouter support for the built-in (ai-sdk) agent: the public model
 * catalog (drives the searchable model selector and the best-free-model
 * default) and the browser PKCE flow (a scoped key without the user ever
 * pasting one — "free models, no API key" onboarding).
 */

const API_BASE = "https://openrouter.ai/api/v1";

export interface OpenRouterModel {
  id: string;
  name: string;
  contextLength: number;
  /** Prompt+completion priced at zero (the ":free" variants). */
  free: boolean;
  created: number;
}

let cache: { models: OpenRouterModel[]; fetchedAt: number } | null = null;
const CACHE_TTL_MS = 60 * 60 * 1000;

export async function fetchOpenRouterModels(): Promise<OpenRouterModel[]> {
  if (cache && Date.now() - cache.fetchedAt < CACHE_TTL_MS) {
    return cache.models;
  }
  const response = await fetch(`${API_BASE}/models`);
  if (!response.ok) {
    throw new Error(`OpenRouter model list failed (${response.status})`);
  }
  const payload = (await response.json()) as {
    data: Array<{
      id: string;
      name?: string;
      context_length?: number;
      created?: number;
      pricing?: { prompt?: string; completion?: string };
    }>;
  };
  const models = payload.data.map((model) => ({
    id: model.id,
    name: model.name ?? model.id,
    contextLength: model.context_length ?? 0,
    free:
      Number.parseFloat(model.pricing?.prompt ?? "1") === 0 &&
      Number.parseFloat(model.pricing?.completion ?? "1") === 0,
    created: model.created ?? 0,
  }));
  cache = { models, fetchedAt: Date.now() };
  return models;
}

/**
 * "Best free model" heuristic, since OpenRouter's API exposes no ranking:
 * the newest free model with a serious context window (≥32k), falling back
 * to the newest free model at all. Deliberately dynamic — no model id is
 * pinned in code, so the default improves as OpenRouter's catalog does.
 */
export function bestFreeModelId(models: OpenRouterModel[]): string | undefined {
  const free = models
    .filter((model) => model.free)
    .sort((a, b) => b.created - a.created);
  return (free.find((model) => model.contextLength >= 32_768) ?? free[0])?.id;
}

/**
 * Browser PKCE login: local callback server + system browser. Resolves to
 * a user-scoped API key (https://openrouter.ai/docs — OAuth PKCE).
 */
export async function openRouterPkceLogin(
  openExternal: (url: string) => void,
  timeoutMs = 5 * 60 * 1000,
): Promise<string> {
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");

  const code = await new Promise<string>((resolve, reject) => {
    const server = http.createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://127.0.0.1");
      const received = url.searchParams.get("code");
      response.writeHead(200, { "content-type": "text/html" });
      response.end(
        "<body style='font-family:system-ui;padding:2rem'>Signed in. You can close this tab and return to Catamorphic.</body>",
      );
      if (received) {
        cleanup();
        resolve(received);
      }
    });
    const timer = setTimeout(() => {
      cleanup();
      reject(new Error("OpenRouter sign-in timed out"));
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      server.close();
    };
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      if (address === null || typeof address === "string") {
        cleanup();
        reject(new Error("Callback server failed to bind"));
        return;
      }
      const callback = `http://127.0.0.1:${address.port}/callback`;
      openExternal(
        `https://openrouter.ai/auth?callback_url=${encodeURIComponent(callback)}&code_challenge=${challenge}&code_challenge_method=S256`,
      );
    });
    server.on("error", (error) => {
      cleanup();
      reject(error);
    });
  });

  const exchange = await fetch(`${API_BASE}/auth/keys`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      code,
      code_verifier: verifier,
      code_challenge_method: "S256",
    }),
  });
  if (!exchange.ok) {
    throw new Error(`OpenRouter key exchange failed (${exchange.status})`);
  }
  const { key } = (await exchange.json()) as { key?: string };
  if (!key) throw new Error("OpenRouter returned no key");
  return key;
}
