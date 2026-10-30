import {
  MutationObserver,
  onlineManager,
  QueryObserver,
} from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { workQueryClient } from "./query-client.js";

it("refetches nothing when a window comes back, and retries all but a refusal", () => {
  const queries = workQueryClient().getDefaultOptions().queries;
  expect(queries?.refetchOnWindowFocus).toBe(false);
  expect(queries?.refetchOnReconnect).toBe(true);
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
    networkMode: "online",
  }).getDefaultOptions().queries;
  expect(remote).toMatchObject({
    retry: 1,
    staleTime: 1000,
    refetchOnWindowFocus: false,
    networkMode: "online",
  });
});

it("loads and retries local reads and confirms local mutations while offline", async () => {
  const previous = onlineManager.isOnline();
  const client = workQueryClient({ retry: 1 });
  onlineManager.setOnline(false);
  const read = vi
    .fn()
    .mockRejectedValueOnce(new Error("try again"))
    .mockResolvedValue("local history");
  const observer = new QueryObserver(client, {
    queryKey: ["offline-history"],
    queryFn: read,
    retryDelay: 0,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    await vi.waitFor(() =>
      expect(observer.getCurrentResult().data).toBe("local history"),
    );
    expect(read).toHaveBeenCalledTimes(2);
    const mutation = new MutationObserver(client, {
      mutationFn: async () => "saved locally",
    });
    await expect(mutation.mutate()).resolves.toBe("saved locally");
  } finally {
    unsubscribe();
    client.clear();
    onlineManager.setOnline(previous);
  }
});

it("retains offline pausing for remote authorities", () => {
  const previous = onlineManager.isOnline();
  onlineManager.setOnline(false);
  const client = workQueryClient({ networkMode: "online" });
  const read = vi.fn(async () => "remote history");
  const observer = new QueryObserver(client, {
    queryKey: ["remote-history"],
    queryFn: read,
  });
  const unsubscribe = observer.subscribe(() => {});
  try {
    expect(observer.getCurrentResult().fetchStatus).toBe("paused");
    expect(read).not.toHaveBeenCalled();
    expect(client.getDefaultOptions().mutations?.networkMode).toBe("online");
  } finally {
    unsubscribe();
    client.clear();
    onlineManager.setOnline(previous);
  }
});
