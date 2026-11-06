// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { AppScreen } from "./app-screen.js";

const apps = [
  {
    name: "activity",
    title: "Activity",
    id: "app-1",
    activeVersionId: null,
    publishedAt: null,
    icon: "dashboard",
    access: { sessions: "read" },
  },
  {
    name: "notes",
    title: "Notes",
    id: "app-2",
    activeVersionId: null,
    publishedAt: null,
    icon: "default",
    access: {},
  },
];

vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({
    apiClient: {
      GET: vi.fn().mockResolvedValue({ data: apps, response: { status: 200 } }),
    },
  }),
}));
vi.mock("@catamorphic/ui", () => ({
  AppMount: ({ appName }: { appName: string }) => (
    <div data-testid="app-mount">{appName}</div>
  ),
}));
vi.mock("../lib/theme.js", () => ({
  appHostTheme: () => undefined,
  useTheme: () => null,
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    appAccessApproved: vi.fn(),
    appAccessAllow: vi.fn(),
  },
}));

async function mount(appName: string) {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <AppScreen projectId="p1" appName={appName} />
      </QueryClientProvider>,
    ),
  );
  // The app list and the answer arrive on React Query's own schedule.
  await vi.waitFor(() => expect(node.textContent).not.toContain("Loading app"));
  return { node, root };
}

it("asks once before an app that reads chats mounts, and records the answer in main", async () => {
  // Main keeps the answer, signed (ADR 0277); the window only asks.
  let approved = false;
  vi.mocked(desktopApi.appAccessApproved).mockImplementation(
    async () => approved,
  );
  vi.mocked(desktopApi.appAccessAllow).mockImplementation(async () => {
    approved = true;
  });
  const { node, root } = await mount("activity");
  try {
    expect(
      node.querySelector('[data-testid="app-access-consent"]'),
    ).not.toBeNull();
    expect(node.textContent).toContain("Activity wants to read your chats");
    expect(node.querySelector('[data-testid="app-mount"]')).toBeNull();
    await act(async () =>
      node
        .querySelector<HTMLButtonElement>('[data-testid="app-access-allow"]')
        ?.click(),
    );
    expect(desktopApi.appAccessAllow).toHaveBeenCalledWith({
      projectId: "p1",
      app: "activity",
    });
    await vi.waitFor(() =>
      expect(node.querySelector('[data-testid="app-mount"]')).not.toBeNull(),
    );
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

it("mounts an app without access declarations straight away", async () => {
  const { node, root } = await mount("notes");
  try {
    expect(node.querySelector('[data-testid="app-access-consent"]')).toBeNull();
    expect(node.querySelector('[data-testid="app-mount"]')?.textContent).toBe(
      "notes",
    );
    expect(desktopApi.appAccessApproved).not.toHaveBeenCalledWith({
      projectId: "p1",
      app: "notes",
    });
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});

it("skips the question once the profile approved the app", async () => {
  vi.mocked(desktopApi.appAccessApproved).mockResolvedValue(true);
  const { node, root } = await mount("activity");
  try {
    expect(node.querySelector('[data-testid="app-access-consent"]')).toBeNull();
    expect(node.querySelector('[data-testid="app-mount"]')).not.toBeNull();
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
