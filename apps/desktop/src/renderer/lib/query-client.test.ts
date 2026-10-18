import { expect, it } from "vitest";
import { workQueryClient } from "./query-client.js";

it("refetches nothing when a window comes back, and retries all but a refusal", () => {
  const queries = workQueryClient().getDefaultOptions().queries;
  expect(queries?.refetchOnWindowFocus).toBe(false);
  expect(queries?.staleTime).toBe(30_000);
  const retry = queries?.retry;
  if (typeof retry !== "function") throw new Error("Expected a retry rule");
  expect(retry(0, Object.assign(new Error("gone"), { status: 404 }))).toBe(
    false,
  );
  expect(retry(0, Object.assign(new Error("down"), { status: 503 }))).toBe(
    true,
  );
  expect(retry(2, new Error("down"))).toBe(false);
  const remote = workQueryClient({
    retry: 1,
    staleTime: 1000,
  }).getDefaultOptions().queries;
  expect(remote).toMatchObject({
    retry: 1,
    staleTime: 1000,
    refetchOnWindowFocus: false,
  });
});
