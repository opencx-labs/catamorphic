"use client";

import type { CatamorphicApiClient } from "@catamorphic/api-client";
import {
  QueryClient,
  QueryClientProvider,
  useQueryClient,
} from "@tanstack/react-query";
import { createContext, type ReactNode, useContext, useMemo } from "react";

export interface CatamorphicContextValue {
  apiClient: CatamorphicApiClient;
  /** API origin used for browser-return OAuth callbacks, when known. */
  baseUrl?: string;
}

const CatamorphicContext = createContext<CatamorphicContextValue | null>(null);

export interface CatamorphicProviderProps {
  apiClient: CatamorphicApiClient;
  /** API origin used for browser-return OAuth callbacks. */
  baseUrl?: string;
  /**
   * TanStack Query client. Hosts that already have one pass it; if omitted
   * we create an internal one so the provider works standalone.
   */
  queryClient?: QueryClient;
  children: ReactNode;
}

export function CatamorphicProvider({
  apiClient,
  baseUrl,
  queryClient,
  children,
}: CatamorphicProviderProps) {
  const resolvedQueryClient = useMemo(
    () => queryClient ?? new QueryClient(),
    [queryClient],
  );

  const value = useMemo<CatamorphicContextValue>(
    () => ({ apiClient, ...(baseUrl ? { baseUrl } : {}) }),
    [apiClient, baseUrl],
  );

  return (
    <QueryClientProvider client={resolvedQueryClient}>
      <CatamorphicContext.Provider value={value}>
        {children}
      </CatamorphicContext.Provider>
    </QueryClientProvider>
  );
}

export function useCatamorphic(): CatamorphicContextValue {
  const ctx = useContext(CatamorphicContext);
  if (!ctx) {
    throw new Error(
      "useCatamorphic must be used within a <CatamorphicProvider>",
    );
  }
  return ctx;
}

/** Re-export so consumers can grab the same query client instance if needed. */
export { useQueryClient };
