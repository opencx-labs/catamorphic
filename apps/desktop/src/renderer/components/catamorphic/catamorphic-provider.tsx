"use client";

import { createCatamorphicClient } from "@catamorphic/api-client";
import {
  type CatamorphicProviderProps,
  CatamorphicProvider as InnerProvider,
} from "@catamorphic/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactNode } from "react";
import { useMemo, useState } from "react";

export interface CatamorphicAppProviderProps {
  /**
   * Base URL of the Catamorphic API (e.g. `https://api.example.com`).
   */
  baseUrl: string;
  /**
   * Optional fetch wrapper. Use to inject auth headers (e.g. session
   * cookies, bearer tokens) before calls hit the network.
   */
  fetch?: typeof globalThis.fetch;
  /**
   * Optional pre-built QueryClient. Pass one if you already have a
   * QueryClientProvider higher up the tree and want to share the cache.
   */
  queryClient?: QueryClient;
  /**
   * Forwarded directly to `<CatamorphicProvider>` from `@catamorphic/react`.
   * Use to override `apiClient` if you need a custom transport.
   */
  apiClient?: CatamorphicProviderProps["apiClient"];
  children: ReactNode;
}

/**
 * Drop-in provider for any host app embedding Catamorphic. Wires
 * `<QueryClientProvider>` and `<CatamorphicProvider>` together with sane
 * defaults (per-instance QueryClient, no retry on 4xx). Replace the
 * `fetch` prop to inject auth.
 *
 * Usage:
 * ```tsx
 * <CatamorphicAppProvider baseUrl={process.env.NEXT_PUBLIC_CATAMORPHIC_URL!}>
 *   <App />
 * </CatamorphicAppProvider>
 * ```
 */
export function CatamorphicAppProvider({
  baseUrl,
  fetch: fetchImpl,
  queryClient: providedQueryClient,
  apiClient: providedApiClient,
  children,
}: CatamorphicAppProviderProps) {
  const [defaultQueryClient] = useState(
    () =>
      new QueryClient({
        defaultOptions: {
          queries: {
            staleTime: 30_000,
            retry: (failureCount, error) => {
              const status = (error as { status?: number })?.status;
              if (status && status >= 400 && status < 500) return false;
              return failureCount < 2;
            },
          },
        },
      }),
  );

  const queryClient = providedQueryClient ?? defaultQueryClient;

  const apiClient = useMemo(
    () =>
      providedApiClient ??
      createCatamorphicClient({ baseUrl, fetch: fetchImpl }),
    [providedApiClient, baseUrl, fetchImpl],
  );

  return (
    <QueryClientProvider client={queryClient}>
      <InnerProvider
        apiClient={apiClient}
        queryClient={queryClient}
        baseUrl={baseUrl}
      >
        {children}
      </InnerProvider>
    </QueryClientProvider>
  );
}
