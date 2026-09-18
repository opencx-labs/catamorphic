// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { GithubAuthorizationTray, ProjectModal } from "./project-modal.js";

const desktop = vi.hoisted(() => ({
  connectedListener: null as ((result: unknown) => void) | null,
  defaultProjectsDir: vi.fn().mockResolvedValue("/tmp/projects"),
  githubImport: vi.fn(),
  githubConnectStart: vi.fn().mockResolvedValue({
    userCode: "061F-9C19",
    verificationUri: "https://github.com/login/device",
  }),
  githubConnectCancel: vi.fn().mockResolvedValue(undefined),
  githubManageRepos: vi.fn().mockResolvedValue(undefined),
  onGithubConnected: vi.fn((listener: (result: unknown) => void) => {
    desktop.connectedListener = listener;
    return () => {
      desktop.connectedListener = null;
    };
  }),
}));

const github = vi.hoisted(() => ({
  connected: false,
  login: undefined as string | undefined,
  repos: [] as Array<{
    id: number;
    name: string;
    fullName: string;
    private: boolean;
    defaultBranch: string;
    cloneUrl: string;
  }>,
}));

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: desktop,
}));

vi.mock("@catamorphic/react", () => ({
  useGithubStatus: () => ({
    data: {
      connected: github.connected,
      ...(github.login ? { login: github.login } : {}),
    },
    isLoading: false,
  }),
  useGithubRepos: () => ({
    data: github.repos,
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
    for (const node of document.body.querySelectorAll("body > div"))
      node.remove();
  });
  document.body.replaceChildren();
  desktop.connectedListener = null;
  github.connected = false;
  github.login = undefined;
  github.repos = [];
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
    const container = document.createElement("div");
    document.body.appendChild(container);
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
        />,
      );
    });

    const tray = document.body.querySelector("aside");
    expect(tray?.getAttribute("aria-modal")).toBeNull();
    expect(document.body.textContent).toContain("061F-9C19");
    const buttons = Array.from(document.body.querySelectorAll("button"));
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('button[aria-label="Copy code"]')
        ?.click(),
    );
    expect(writeText).toHaveBeenCalledWith("061F-9C19");
    expect(document.body.textContent).toContain("Copied");
    expect(document.body.textContent).not.toContain("Open GitHub");
    expect(
      document.body.querySelector('button[aria-label="Code copied"]'),
    ).not.toBeNull();
    const copyStates = document.body.querySelectorAll(
      'button[aria-label="Code copied"] > span > span',
    );
    expect(copyStates).toHaveLength(2);
    expect(copyStates[0]?.className).toContain("invisible");
    expect(copyStates[1]?.className).not.toContain("invisible");
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
          <ProjectModal open onClose={() => {}} onCreated={() => {}} />
        </QueryClientProvider>,
      );
    });
    const githubTab = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.textContent === "GitHub",
    );
    act(() => githubTab?.click());
    const connect = Array.from(document.body.querySelectorAll("button")).find(
      (button) => button.dataset.testid === "github-connect",
    );
    await act(async () => connect?.click());

    expect(
      document.querySelector('[data-testid="github-authorization-tray"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[aria-hidden="true"]')).not.toBeNull();

    act(() =>
      desktop.connectedListener?.({ connected: true, login: "octocat" }),
    );
    expect(
      document.querySelector('[data-testid="github-authorization-tray"]'),
    ).toBeNull();
    expect(document.body.querySelector('[aria-hidden="false"]')).not.toBeNull();
  });

  it("explains missing grants and steps aside while repository access changes", async () => {
    github.connected = true;
    github.login = "octocat";
    github.repos = [
      {
        id: 1,
        name: "visible",
        fullName: "octocat/visible",
        private: true,
        defaultBranch: "main",
        cloneUrl: "https://github.com/octocat/visible.git",
      },
    ];
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
          <ProjectModal open onClose={() => {}} onCreated={() => {}} />
        </QueryClientProvider>,
      );
    });
    act(() => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent === "GitHub")
        ?.click();
    });
    const input = document.body.querySelector<HTMLInputElement>(
      '[data-testid="github-repo-search"]',
    );
    act(() => {
      const setter = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setter?.call(input, "missing");
      input?.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain(
      "No granted repositories match.",
    );
    act(() => {
      Array.from(document.body.querySelectorAll("button"))
        .find((button) => button.textContent === "Manage repository access")
        ?.click();
    });
    expect(desktop.githubManageRepos).toHaveBeenCalledOnce();
    expect(
      document.querySelector('[data-testid="github-repository-access-tray"]'),
    ).not.toBeNull();
    expect(document.body.querySelector('[aria-hidden="true"]')).not.toBeNull();
  });
});

it("locks an import while pending and leaves the selection available for retry", async () => {
  github.connected = true;
  github.repos = [
    {
      id: 1,
      name: "demo",
      fullName: "owner/demo",
      private: false,
      defaultBranch: "main",
      cloneUrl: "https://github.com/owner/demo.git",
    },
  ];
  let rejectImport = (_error: Error) => {};
  desktop.githubImport.mockImplementation(
    () =>
      new Promise((_resolve, reject) => {
        rejectImport = reject;
      }),
  );
  const onClose = vi.fn();
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  roots.push(root);
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  await act(async () =>
    root.render(
      <QueryClientProvider client={client}>
        <ProjectModal open onClose={onClose} onCreated={() => {}} />
      </QueryClientProvider>,
    ),
  );
  const button = (text: string) =>
    Array.from(document.body.querySelectorAll("button")).find((element) =>
      element.textContent?.includes(text),
    );
  await act(async () => button("GitHub")?.click());
  await act(async () => button("owner/demo")?.click());
  const submit = document.body.querySelector<HTMLButtonElement>(
    '[data-testid="project-submit"]',
  );
  expect(submit?.disabled).toBe(false);
  await act(async () => submit?.click());
  expect(desktop.githubImport).toHaveBeenCalledOnce();
  expect(document.body.querySelector("fieldset")?.disabled).toBe(true);
  expect(document.body.querySelector("form")?.getAttribute("aria-busy")).toBe(
    "true",
  );
  await act(async () => {
    button("Cancel")?.click();
    document.dispatchEvent(
      new KeyboardEvent("keydown", { key: "Escape", bubbles: true }),
    );
  });
  expect(onClose).not.toHaveBeenCalled();
  await act(async () => rejectImport(new Error("Unable to clone. Try again.")));
  expect(document.body.textContent).toContain("Unable to clone. Try again.");
  expect(document.body.querySelector("fieldset")?.disabled).toBe(false);
  expect(
    document.body.querySelector<HTMLInputElement>(
      '[data-testid="project-name-input"]',
    )?.value,
  ).toBe("demo");
  expect(submit?.disabled).toBe(false);
});
