"use client";

import {
  type CatamorphicApiClient,
  createApiClient,
} from "@catamorphic/api-client";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";
import { type ReactNode, useMemo } from "react";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

/**
 * Browser fetch wrapper that threads the playground's dev-only external user
 * id header — mirrors the legacy `apiFetch` helper so the api-client talks to
 * the server the same way the old ad-hoc client did.
 *
 * openapi-fetch passes a fully-constructed `Request` as `input` (with
 * `Content-Type: application/json` already baked in). If we pass `{ headers }`
 * in the second arg to `fetch()`, it overrides the Request's headers and
 * nukes the content-type — Fastify then rejects with 415. Seed the merged
 * Headers from the Request first, then add our own.
 */
function authedFetch(input: RequestInfo | URL, init?: RequestInit) {
  const existingHeaders =
    input instanceof Request ? input.headers : init?.headers;
  const headers = new Headers(existingHeaders);
  if (typeof window !== "undefined") {
    const userId = window.localStorage.getItem("catamorphic.externalUserId");
    if (userId) headers.set("X-External-User-Id", userId);
  }
  return fetch(input, { ...init, headers });
}

export function PlaygroundProviders({ children }: { children: ReactNode }) {
  const apiClient = useMemo<CatamorphicApiClient>(
    () =>
      createApiClient({
        baseUrl: API_URL,
        fetch: authedFetch,
      }),
    [],
  );
  const queryClient = useMemo(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: { staleTime: 5_000, refetchOnWindowFocus: false },
        },
      }),
    [],
  );
  return (
    <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
      {children}
    </CatamorphicProvider>
  );
}
