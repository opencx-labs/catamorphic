import "@testing-library/jest-dom/vitest";
import { afterAll, afterEach, beforeAll } from "vitest";
import { server } from "./server.js";

// Start MSW mock server before all tests.
beforeAll(() => server.listen({ onUnhandledRequest: "error" }));

// Reset any handlers we override between tests (happy-path vs. error paths).
afterEach(() => server.resetHandlers());

// Shut down after all tests complete.
afterAll(() => server.close());
