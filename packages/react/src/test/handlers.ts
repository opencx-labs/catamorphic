import { type HttpHandler, HttpResponse, http } from "msw";

/**
 * Base URL used by tests that render `<CatamorphicProvider>` through the
 * `renderHookWithProviders` helper. Tests that need to exercise a different
 * URL pass `baseUrl` into `renderHookWithProviders`.
 */
export const TEST_API_BASE_URL = "http://test.catamorphic.local";

/**
 * Build a URL under the test API base.
 */
export function apiUrl(path: string): string {
  return `${TEST_API_BASE_URL}${path}`;
}

/**
 * Default handlers. Kept intentionally empty — each test (or suite) declares
 * exactly what it wants with `server.use(...)`, so unhandled requests always
 * fail the test and force us to be explicit.
 */
export const handlers: HttpHandler[] = [];

export { HttpResponse, http };
