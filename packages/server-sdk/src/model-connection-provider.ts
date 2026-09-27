import {
  type ConnectionProvider,
  MODEL_CAPABILITY,
  type ModelApi,
} from "@catamorphic/core";

export interface ModelConnectionOptions {
  kind: string;
  displayName: string;
  /** The HTTP API the provider speaks. */
  api: ModelApi;
  /**
   * Where the API's paths go. Defaults to `https://api.anthropic.com` for
   * `anthropic` and `https://api.openai.com/v1` for `openai`; an
   * OpenAI-compatible server (OpenRouter, a self-hosted model) names its
   * own, e.g. `https://openrouter.ai/api/v1`.
   */
  baseUrl?: string;
}

const DEFAULT_BASE_URLS: Record<ModelApi, string> = {
  anthropic: "https://api.anthropic.com",
  openai: "https://api.openai.com/v1",
};

/**
 * A model provider's API key as a connection (ADR 0180). An administrator
 * stores the key once as a service connection; harnesses running in
 * sandboxes reach the provider's HTTP API through the gateway's model
 * routes with their session grant, and the gateway adds the key. The
 * connection carries the `model` capability and has no actions.
 */
export function defineModelConnectionProvider(
  options: ModelConnectionOptions,
): ConnectionProvider {
  const base = new URL(options.baseUrl ?? DEFAULT_BASE_URLS[options.api]);
  if (base.protocol !== "https:" && !isLoopback(base.hostname))
    throw new Error(`${options.kind}: baseUrl must use HTTPS`);
  const baseUrl = base.href.replace(/\/+$/, "");
  return {
    kind: options.kind,
    displayName: options.displayName,
    model: {
      api: options.api,
      baseUrl,
      headers: ({ material }): Record<string, string> => {
        const key = decodeKey(material);
        return options.api === "anthropic"
          ? { "x-api-key": key }
          : { authorization: `Bearer ${key}` };
      },
    },
    beginAuthorization: async () => ({
      challenge: {
        kind: "form",
        fields: [
          { name: "apiKey", label: "API key", secret: true, required: true },
        ],
      },
    }),
    completeAuthorization: async ({ callback }) => {
      const apiKey = callback.apiKey?.trim();
      if (!apiKey) throw new Error("An API key is required");
      return {
        material: new TextEncoder().encode(JSON.stringify({ apiKey })),
        account: { api: options.api, baseUrl },
        capabilities: [MODEL_CAPABILITY],
      };
    },
    listActions: async () => [],
    invoke: async () => {
      throw new Error(
        `${options.displayName} is reached by harnesses through the gateway's model routes, not with actions`,
      );
    },
  };
}

/** The built-in model connections every Work server offers (ADR 0180). */
export function builtinModelConnectionProviders(): ConnectionProvider[] {
  return [
    defineModelConnectionProvider({
      kind: "anthropic",
      displayName: "Anthropic",
      api: "anthropic",
    }),
    defineModelConnectionProvider({
      kind: "openai",
      displayName: "OpenAI",
      api: "openai",
    }),
  ];
}

function decodeKey(material: Uint8Array): string {
  const value: unknown = JSON.parse(new TextDecoder().decode(material));
  if (
    value &&
    typeof value === "object" &&
    "apiKey" in value &&
    typeof value.apiKey === "string" &&
    value.apiKey
  )
    return value.apiKey;
  throw new Error("The stored model key is unreadable");
}

function isLoopback(hostname: string): boolean {
  return (
    hostname === "localhost" ||
    hostname === "127.0.0.1" ||
    hostname === "[::1]" ||
    hostname.endsWith(".localhost")
  );
}
