// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubAuthorizationTray, ProjectModal } from "./project-modal.js";

const desktop = vi.hoisted(() => ({
  connectedListener: null as ((result: unknown) => void) | null,
  defaultProjectsDir: vi.fn().mockResolvedValue("/tmp/projects"),
  githubConnectStart: vi.fn().mockResolvedValue({
    userCode: "061F-9C19",
    verificationUri: "https://github.com/login/device",
  }),
  githubConnectCancel: vi.fn().mockResolvedValue(undefined),
  onGithubConnected: vi.fn((listener: (result: unknown) => void) => {
    desktop.connectedListener = listener;
    return () => {
      desktop.connectedListener = null;
    };
  }),
}));

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: desktop,
}));

vi.mock("@catamorphic/react", () => ({
  useGithubStatus: () => ({
    data: { connected: false },
    isLoading: false,
  }),
  useGithubRepos: () => ({
    data: [],
    error: null,
    isError: false,
    isLoading: false,
  }),
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.stubGlobal(
  "ResizeObserver",
  class {
    observe() {}
    unobserve() {}
    disconnect() {}
  },
);

const roots: Root[] = [];

afterEach(() => {
  act(() => {
    for (const root of roots.splice(0)) root.unmount();
  });
  document.body.replaceChildren();
  desktop.connectedListener = null;
  vi.clearAllMocks();
});

describe("GithubAuthorizationTray", () => {
  it("keeps browser authorization non-modal and exposes its actions", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    const onCancel = vi.fn();
    const onOpenUrl = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);

    await act(async () => {
      root.render(
        <GithubAuthorizationTray
          grant={{
            userCode: "061F-9C19",
            verificationUri: "https://github.com/login/device",
          }}
          onCancel={onCancel}
          onOpenUrl={onOpenUrl}
        />,
      );
    });

    const tray = container.querySelector("aside");
    expect(tray?.getAttribute("aria-modal")).toBeNull();
    expect(container.textContent).toContain("061F-9C19");
    const buttons = Array.from(container.querySelectorAll("button"));
    await act(async () =>
      buttons.find((button) => button.textContent === "Copy code")?.click(),
    );
    expect(writeText).toHaveBeenCalledWith("061F-9C19");
    expect(container.textContent).toContain("Copied");

    act(() =>
      buttons.find((button) => button.textContent === "Open GitHub")?.click(),
    );
    expect(onOpenUrl).toHaveBeenCalledWith("https://github.com/login/device");
    act(() =>
      buttons.find((button) => button.textContent === "Cancel")?.click(),
    );
    expect(onCancel).toHaveBeenCalledOnce();
  });

  it("steps the project modal aside and restores it after authorization", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    roots.push(root);
    const queryClient = new QueryClient({
      defaultOptions: { queries: { retry: false } },
    });

    await act(async () => {
      root.render(
        <QueryClientProvider client={queryClient}>
          <ProjectModal
            open
            onClose={() => {}}
            onCreated={() => {}}
            onOpenUrl={() => {}}
          />
        </QueryClientProvider>,
      );
    });
    const githubTab = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "GitHub",
    );
    act(() => githubTab?.click());
    const connect = Array.from(container.querySelectorAll("button")).find(
      (button) => button.textContent === "Connect GitHub",
    );
    await act(async () => connect?.click());

    expect(
      document.querySelector('[data-testid="github-authorization-tray"]'),
    ).not.toBeNull();
    expect(container.querySelector('[aria-hidden="true"]')).not.toBeNull();

    act(() =>
      desktop.connectedListener?.({ connected: true, login: "octocat" }),
    );
    expect(
      document.querySelector('[data-testid="github-authorization-tray"]'),
    ).toBeNull();
    expect(container.querySelector('[aria-hidden="false"]')).not.toBeNull();
  });
});
