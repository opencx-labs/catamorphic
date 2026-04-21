import createClient, { type Client } from "openapi-fetch";
import type { paths } from "./schema.js";

/**
 * The api-client wraps openapi-fetch and additionally exposes `baseUrl` /
 * `fetch` so callers can hit endpoints whose path templates aren't
 * representable in openapi-fetch (e.g. Fastify wildcards like `{*}`).
 */
export type CatamorphicApiClient = Client<paths> & {
  baseUrl: string;
  fetch: typeof fetch;
};

export interface CreateCatamorphicClientOptions {
  baseUrl: string;
  /** Custom fetch — pass an authed wrapper for browser embeds. */
  fetch?: typeof fetch;
}

export function createCatamorphicClient(
  options: CreateCatamorphicClientOptions,
): CatamorphicApiClient {
  const fetchImpl: typeof fetch =
    options.fetch ?? globalThis.fetch.bind(globalThis);
  const client = createClient<paths>({
    baseUrl: options.baseUrl,
    fetch: fetchImpl,
  });
  return Object.assign(client, {
    baseUrl: options.baseUrl,
    fetch: fetchImpl,
  });
}

/** Alias matching the public `createApiClient` name used in docs and embeds. */
export const createApiClient = createCatamorphicClient;
