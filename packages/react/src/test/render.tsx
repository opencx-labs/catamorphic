import { createCatamorphicClient } from "@catamorphic/api-client";
import { QueryClient } from "@tanstack/react-query";
import { render, renderHook } from "@testing-library/react";
import { createStore, Provider as JotaiProvider } from "jotai";
import type { ReactNode } from "react";
import { CatamorphicProvider } from "../provider.js";
import { TEST_API_BASE_URL } from "./handlers.js";

export interface RenderWithProvidersOptions {
  baseUrl?: string;
  queryClient?: QueryClient;
}

export interface RenderHookWithProvidersOptions<Props>
  extends RenderWithProvidersOptions {
  /** Initial props for the hook callback (forwarded to `renderHook`). */
  initialProps?: Props;
}

function makeQueryClient(): QueryClient {
  return new QueryClient({
    defaultOptions: {
      queries: { retry: false, gcTime: 0, staleTime: 0 },
      mutations: { retry: false },
    },
  });
}

export function createTestApiClient(baseUrl: string = TEST_API_BASE_URL) {
  return createCatamorphicClient({ baseUrl });
}

/**
 * Mount a React node inside `<CatamorphicProvider>` with a fresh test
 * QueryClient. Each test gets its own QueryClient by default so cache
 * state never leaks across tests.
 */
export function renderWithProviders(
  ui: ReactNode,
  options: RenderWithProvidersOptions = {},
) {
  const apiClient = createTestApiClient(options.baseUrl);
  const queryClient = options.queryClient ?? makeQueryClient();
  const store = createStore();
  return {
    ...render(
      <JotaiProvider store={store}>
        <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
          {ui}
        </CatamorphicProvider>
      </JotaiProvider>,
    ),
    apiClient,
    queryClient,
    store,
  };
}

/**
 * `renderHook` equivalent of `renderWithProviders` — use for hook-only tests.
 */
export function renderHookWithProviders<Result, Props>(
  callback: (props: Props) => Result,
  options: RenderHookWithProvidersOptions<Props> = {},
) {
  const apiClient = createTestApiClient(options.baseUrl);
  const queryClient = options.queryClient ?? makeQueryClient();
  const store = createStore();
  const result = renderHook(callback, {
    wrapper: ({ children }) => (
      <JotaiProvider store={store}>
        <CatamorphicProvider apiClient={apiClient} queryClient={queryClient}>
          {children}
        </CatamorphicProvider>
      </JotaiProvider>
    ),
    ...(options.initialProps !== undefined
      ? { initialProps: options.initialProps }
      : {}),
  });
  return { ...result, apiClient, queryClient, store };
}
