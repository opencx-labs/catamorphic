// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { PullRequestStatusRead } from "../../shared/pr-details.js";
import { usePullRequestStatuses } from "./pr-status.js";

const { read } = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock("./desktop-api.js", () => ({ desktopApi: { prStatus: read } }));
const url = "https://github.com/acme/web/pull/42";
const status = {
  number: 42,
  title: "Current title",
  url,
  repository: "acme/web",
  author: "octo",
  head: "work/example",
  base: "main",
  state: "open" as const,
  additions: 1,
  deletions: 0,
  changedFiles: 1,
  comments: 0,
  updatedAt: "2026-10-24T00:00:00Z",
};
let container: HTMLDivElement;
let root: Root;
let client: QueryClient;
function Probe({ enabled = true }: { enabled?: boolean }) {
  const results = usePullRequestStatuses({ urls: [url], enabled });
  return <div>{results.get(url)?.state ?? "unavailable"}</div>;
}
const advance = async (ms: number) => {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
  await act(async () => {
    await vi.advanceTimersByTimeAsync(2);
  });
};
const render = async (enabled = true) => {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <Probe enabled={enabled} />
      </QueryClientProvider>,
    );
  });
  await advance(1);
};
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers();
  read.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient();
});
afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  vi.useRealTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

it("refreshes anonymous public reads less often and replaces an open state after merge", async () => {
  read.mockResolvedValue({
    status,
    source: "public",
  } satisfies PullRequestStatusRead);
  await render();
  expect(container.textContent).toBe("open");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2);
    window.dispatchEvent(new Event("focus"));
    await vi.advanceTimersByTimeAsync(1);
  });
  expect(read).toHaveBeenCalledTimes(1);
  read.mockResolvedValue({
    status: { ...status, state: "merged" },
    source: "public",
  } satisfies PullRequestStatusRead);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(240_000);
    await vi.advanceTimersByTimeAsync(2);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("merged");
  await act(async () => {
    await vi.advanceTimersByTimeAsync(600_000);
  });
  expect(read).toHaveBeenCalledTimes(2);
});

it("polls a closed authenticated PR so reopening is reflected", async () => {
  read.mockResolvedValue({
    status: { ...status, state: "closed" },
    source: "github-cli",
  } satisfies PullRequestStatusRead);
  await render();
  read.mockResolvedValue({
    status,
    source: "github-cli",
  } satisfies PullRequestStatusRead);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(60_000);
    await vi.advanceTimersByTimeAsync(2);
  });
  expect(read).toHaveBeenCalledTimes(2);
  expect(container.textContent).toBe("open");
});

it("does not read statuses for a hidden chat", async () => {
  read.mockResolvedValue({
    status,
    source: "public",
  } satisfies PullRequestStatusRead);
  await render(false);
  expect(read).not.toHaveBeenCalled();
  await render();
  expect(read).toHaveBeenCalledTimes(1);
});
