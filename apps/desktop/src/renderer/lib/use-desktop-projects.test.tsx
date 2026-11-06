// @vitest-environment jsdom

import { createApiClient } from "@catamorphic/api-client";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useDesktopProjects } from "./use-desktop-projects.js";

const { client } = vi.hoisted(() => ({ client: { current: {} } }));
vi.mock("@catamorphic/react", async (original) => ({
  ...(await original<typeof import("@catamorphic/react")>()),
  useCatamorphic: () => ({ apiClient: client.current }),
}));
Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root | undefined;
let queryClient: QueryClient | undefined;
afterEach(() => {
  act(() => root?.unmount());
  queryClient?.clear();
  document.body.replaceChildren();
});

function Catalog() {
  const query = useDesktopProjects();
  return (
    <div data-status={query.status}>
      {query.data?.items.map((item) => item.id).join(",")}
    </div>
  );
}
const page = (start: number, count: number, total: number) =>
  new Response(
    JSON.stringify({
      items: Array.from({ length: count }, (_, index) => ({
        id: `project-${start + index}`,
        name: `Project ${start + index}`,
      })),
      total,
    }),
    { headers: { "content-type": "application/json" } },
  );

async function mount(fetch: typeof globalThis.fetch) {
  client.current = createApiClient({ baseUrl: "http://desktop.test", fetch });
  const cache = new QueryClient({
    defaultOptions: { queries: { retry: false, gcTime: 0 } },
  });
  queryClient = cache;
  const container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  await act(async () =>
    root?.render(
      <QueryClientProvider client={cache}>
        <Catalog />
      </QueryClientProvider>,
    ),
  );
  return container;
}

it("publishes the complete catalog only after later pages arrive", async () => {
  let finish!: (response: Response) => void;
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(page(0, 100, 101))
    .mockImplementationOnce(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const container = await mount(fetch);
  await vi.waitFor(() => expect(fetch).toHaveBeenCalledTimes(2));
  expect(container.querySelector('[data-status="pending"]')).not.toBeNull();
  expect(container.textContent).toBe("");
  await act(async () => {
    finish(page(100, 1, 101));
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.querySelector('[data-status="success"]')).not.toBeNull();
  expect(container.textContent).toContain("project-100");
  const request = fetch.mock.calls[1]?.[0];
  expect(request instanceof Request ? request.url : request).toContain(
    "offset=100",
  );
});

it("keeps the previous complete catalog when a later page fails", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(page(0, 1, 1))
    .mockResolvedValueOnce(page(1, 100, 101))
    .mockResolvedValueOnce(
      new Response(JSON.stringify({ error: "unavailable" }), {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
    );
  const container = await mount(fetch);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.textContent).toBe("project-0");
  await act(async () => {
    await queryClient?.invalidateQueries({ queryKey: ["cat", "projects"] });
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.querySelector('[data-status="error"]')).not.toBeNull();
  expect(container.textContent).toBe("project-0");
});

it("rejects an offset traversal when deletion shifts the following page", async () => {
  const fetch = vi
    .fn<typeof globalThis.fetch>()
    .mockResolvedValueOnce(page(0, 100, 201))
    .mockResolvedValueOnce(page(101, 100, 200));
  const container = await mount(fetch);
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
  });
  expect(container.querySelector('[data-status="error"]')).not.toBeNull();
  expect(container.textContent).toBe("");
});
