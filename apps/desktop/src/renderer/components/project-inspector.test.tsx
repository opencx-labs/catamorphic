// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { RemoteProjectStatus } from "../lib/desktop-api.js";
import {
  displayRemote,
  ProjectInspector,
  type ProjectInspectorData,
  type ProjectInspectorSession,
  ProjectInspectorView,
} from "./project-inspector";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<T>((done, fail) => {
    resolve = done;
    reject = fail;
  });
  return { promise, resolve, reject };
}

const api = vi.hoisted(() => ({
  projectRoot: vi.fn(),
  remoteStatus: vi.fn(),
  sessions: vi.fn(),
}));

// Only what the card reads: anything else it called would throw here.
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    projectRoot: api.projectRoot,
    remoteStatus: api.remoteStatus,
  },
}));
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({
    apiClient: {
      GET: async (
        _path: string,
        init: { params: { path: { projectId: string } } },
      ) => ({ data: await api.sessions(init.params.path.projectId) }),
    },
  }),
}));

const project = {
  id: "alpha",
  name: "Alpha",
  storageType: "managed" as const,
  remoteUrl: null,
  remoteOwnership: null,
  remoteDivergedAt: null,
  defaultBranch: "main",
  createdAt: "2026-08-29T00:00:00.000Z",
  updatedAt: "2026-08-29T00:00:00.000Z",
};

const loaded: ProjectInspectorData = {
  root: "/projects/alpha",
  server: null,
  sessions: [],
};

const memberStatus: RemoteProjectStatus = {
  serverUrl: "https://work.example.test/api",
  remoteProjectId: "remote-alpha",
  remoteProjectName: "Alpha team",
  lastSyncAt: null,
  capabilities: {
    source: null,
    permissions: [],
    agents: ["csm"],
    documents: [{ path: "store/**", access: "write" }],
    features: {
      publications: "members",
      proposals: false,
      proposalsOpenPullRequests: false,
      mcp: true,
      agentSessions: true,
      storeUploadMaxBytes: 10_000_000,
    },
  },
  connection: {
    state: "connected",
    checkedAt: "2026-09-04T00:00:00.000Z",
    message: "Connected",
  },
  local: { modified: [], deleted: [], programEdits: [] },
};

/**
 * The height each line of the card declares, in order: its value rows and
 * the sessions list. jsdom lays nothing out, so the card's height is the
 * sum of what its lines reserve.
 */
function lineHeights(): number[] {
  const card = document.querySelector('[data-testid="project-inspector"]');
  if (!card) throw new Error("No card");
  const declared = (element: Element): number => {
    if (element instanceof HTMLElement && element.style.height)
      return Number.parseFloat(element.style.height);
    const match = element.className.toString().match(/(?:^|\s)h-(\d+)(?:\s|$)/);
    if (match) return Number(match[1]) * 4;
    const child = element.firstElementChild;
    if (!child) throw new Error(`No declared height: ${element.outerHTML}`);
    return declared(child);
  };
  const sessions = [...card.children].find(
    (child) => child.tagName === "SECTION",
  );
  return [
    ...card.querySelectorAll("dd"),
    ...[...(sessions?.children ?? [])].filter(
      (child) => child.tagName !== "H3",
    ),
  ].map(declared);
}

describe("ProjectInspectorView", () => {
  let container: HTMLDivElement;
  let root: Root;
  let client: QueryClient;
  const writeText = vi.fn();

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
    client = new QueryClient();
    writeText.mockReset().mockResolvedValue(undefined);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    api.projectRoot.mockReset();
    api.remoteStatus.mockReset();
    api.sessions.mockReset();
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    client.clear();
    for (const node of document.querySelectorAll(
      "[data-sidebar-menu], [data-menu-shield]",
    ))
      node.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = async (
    data: ProjectInspectorData,
    options: {
      current?: boolean;
      remoteUrl?: string | null;
      onDelete?: () => void;
    } = {},
  ) => {
    await act(async () => {
      root.render(
        <ProjectInspectorView
          project={{ ...project, remoteUrl: options.remoteUrl ?? null }}
          current={options.current ?? true}
          data={data}
          onDelete={options.onDelete ?? (() => undefined)}
        />,
      );
    });
  };
  const text = () => container.textContent ?? "";
  const menu = () => document.querySelector<HTMLElement>('[role="menu"]');
  const openMenu = async () => {
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[aria-label="Actions for Alpha"]')
        ?.click(),
    );
    const shown = menu();
    if (!shown) throw new Error("The actions menu did not open");
    return shown;
  };
  const menuClosing = () =>
    menu()?.classList.contains("animate-pop-out") === true &&
    !document.querySelector("[data-menu-shield]");

  it("says where the project lives, without worktrees, pull requests or a warning", async () => {
    await render(loaded, { remoteUrl: "https://github.com/example/alpha.git" });
    expect(
      [...container.querySelectorAll("dt")].map((term) => term.textContent),
    ).toEqual(["Folder", "Git remote", "Work server"]);
    expect(text()).toContain("/projects/alpha");
    expect(text()).toContain("https://github.com/example/alpha.git");
    expect(text()).toContain("Current");
    for (const gone of [
      "Worktrees",
      "Changes",
      "Open PRs",
      "pull request",
      "could not load",
    ])
      expect(text()).not.toContain(gone);
    expect(container.querySelector('[role="alert"]')).toBeNull();
    // The current project's chats are in the sidebar.
    expect(text()).not.toContain("Sessions");
  });

  it("says None for a project without a Git remote or a Work server", async () => {
    await render(loaded);
    const values = () =>
      [...container.querySelectorAll("dd")].map((value) => value.textContent);
    expect(values()).toEqual(["/projects/alpha", "None", "None"]);
    // No folder is an answer too; only a failed read is Unavailable.
    await render({ ...loaded, root: null });
    expect(values()).toEqual(["None", "None", "None"]);
    await render({ ...loaded, root: "unavailable" });
    expect(values()).toEqual(["Unavailable", "None", "None"]);
  });

  it("offers deleting only once the project is known to be this person's", async () => {
    for (const server of [undefined, "unavailable" as const]) {
      await render({ ...loaded, server });
      await openMenu();
      expect(menu()?.textContent).toBe("Remove from this device…");
      await act(async () => {
        document
          .querySelector("[data-menu-shield]")
          ?.dispatchEvent(
            new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
          );
        await new Promise((resolve) => setTimeout(resolve, 220));
      });
    }
    await render({ ...loaded, server: null });
    await openMenu();
    expect(menu()?.textContent).toBe("Delete project…");
  });

  it("names a connected server and its state, and offers removal to a member", async () => {
    await render({ ...loaded, server: memberStatus });
    expect(container.querySelectorAll("dd")[2]?.textContent).toBe(
      "Alpha teamConnected",
    );
    await openMenu();
    expect(menu()?.textContent).toBe("Remove from this device…");
  });

  it("copies the Git remote and the folder path, and says so", async () => {
    await render(loaded, { remoteUrl: "git@github.com:example/alpha.git" });
    const copy = (label: string) =>
      container.querySelector<HTMLButtonElement>(`[aria-label="${label}"]`);
    await act(async () => copy("Copy Git remote")?.click());
    expect(writeText).toHaveBeenLastCalledWith(
      "git@github.com:example/alpha.git",
    );
    expect(copy("Copy Git remote")?.dataset.copied).toBe("true");
    expect(
      copy("Copy Git remote")?.closest("dd")?.querySelector('[role="status"]')
        ?.textContent,
    ).toBe("Copied");
    await act(async () => copy("Copy folder path")?.click());
    expect(writeText).toHaveBeenLastCalledWith("/projects/alpha");
    // No native tooltips: the full value shows in the app's own hint.
    expect(container.querySelector("[title]")).toBeNull();
  });

  it("keeps a remote's secrets out of what it shows and copies", () => {
    const cases: Array<[string, string]> = [
      // http(s): the user is often a token, so all userinfo goes.
      [
        "https://ada:secret@github.com/example/a.git",
        "https://github.com/example/a.git",
      ],
      ["https://user:pa#ss@github.com/o/r.git", "https://github.com/o/r.git"],
      ["https://tok@github.com:o/r.git", "https://github.com:o/r.git"],
      ["https://tok:123#x@github.com/o/r", "https://github.com/o/r"],
      ["git+https://user:tok@host/x.git", "git+https://host/x.git"],
      // Unparseable: everything up to its last @ goes.
      ["https://u:a/b@host/x", "https://host/x"],
      // ssh keeps its user and loses a password.
      ["ssh://user:secret@host/x.git", "ssh://user@host/x.git"],
      ["ssh://user:pa/ss@host/x", "ssh://user@host/x"],
      // Nothing secret: unchanged.
      [
        "ssh://git@github.com/example/a.git",
        "ssh://git@github.com/example/a.git",
      ],
      ["ssh://git@host:22/x", "ssh://git@host:22/x"],
      ["git@github.com:example/a.git", "git@github.com:example/a.git"],
      ["https://github.com/o/r", "https://github.com/o/r"],
    ];
    for (const [remote, shown] of cases)
      expect(displayRemote(remote), remote).toBe(shown);
  });

  it("opens its actions in the app's menu and deletes from there", async () => {
    const onDelete = vi.fn();
    await render(loaded, { onDelete });
    expect(text()).not.toContain("Delete project");
    const shown = await openMenu();
    expect(shown.getAttribute("aria-label")).toBe("Actions for Alpha");
    expect(
      container
        .querySelector('[aria-label="Actions for Alpha"]')
        ?.getAttribute("aria-expanded"),
    ).toBe("true");
    await act(async () =>
      [...shown.querySelectorAll("button")]
        .find((button) => button.textContent === "Delete project…")
        ?.click(),
    );
    expect(menuClosing()).toBe(true);
    // The action runs once the menu has left.
    await act(() => new Promise((resolve) => setTimeout(resolve, 220)));
    expect(onDelete).toHaveBeenCalledOnce();
  });

  it("forgets a pick once its menu opens again", async () => {
    const onDelete = vi.fn();
    await render(loaded, { onDelete });
    const shown = await openMenu();
    await act(async () =>
      [...shown.querySelectorAll("button")]
        .find((button) => button.textContent === "Delete project…")
        ?.click(),
    );
    // Opened again before the picked menu had left, then dismissed.
    await openMenu();
    await act(async () => {
      document
        .querySelector("[data-menu-shield]")
        ?.dispatchEvent(
          new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
        );
      await new Promise((resolve) => setTimeout(resolve, 220));
    });
    expect(menu()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("closes its menu on a press anywhere else, which does nothing more", async () => {
    const onDelete = vi.fn();
    await render(loaded, { onDelete });
    await openMenu();
    const shield = document.querySelector<HTMLElement>("[data-menu-shield]");
    expect(shield).not.toBeNull();
    await act(async () => {
      shield?.dispatchEvent(
        new MouseEvent("mousedown", { bubbles: true, cancelable: true }),
      );
    });
    expect(menuClosing()).toBe(true);
    await act(() => new Promise((resolve) => setTimeout(resolve, 220)));
    expect(menu()).toBeNull();
    expect(onDelete).not.toHaveBeenCalled();
  });

  it("closes its menu on Escape", async () => {
    await render(loaded);
    const shown = await openMenu();
    await act(async () => {
      shown.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "Escape",
          bubbles: true,
          cancelable: true,
        }),
      );
    });
    expect(menuClosing()).toBe(true);
  });

  it("lists another project's ongoing sessions with their state", async () => {
    const sessions: ProjectInspectorSession[] = [
      { id: "session-1", title: "Working chat", running: true },
      { id: "session-2", title: "Asking chat", attentionRequired: true },
      { id: "session-3", title: "Closed chat", status: "closed" },
    ];
    await render({ ...loaded, sessions }, { current: false });
    expect(text()).toContain("Sessions");
    expect(text()).toContain("Working chatWorking");
    expect(text()).toContain("Asking chatNeeds attention");
    expect(text()).not.toContain("Closed chat");
    expect(text()).not.toContain("Current");
  });

  it("holds every line while values load, at the height the values take", async () => {
    await render(
      { root: undefined, server: undefined, sessions: undefined },
      { current: false },
    );
    const loading = lineHeights();
    expect(container.querySelectorAll('[aria-busy="true"]')).toHaveLength(3);
    expect(text()).not.toContain("Loading…");
    await render(
      {
        root: "/projects/alpha",
        server: memberStatus,
        sessions: [{ id: "session-1", title: "Working chat", running: true }],
      },
      { current: false },
    );
    expect(lineHeights()).toEqual(loading);
    await render(
      { root: "unavailable", server: "unavailable", sessions: [] },
      { current: false },
    );
    expect(lineHeights()).toEqual(loading);
  });

  it("loads only what it shows and keeps its size as the reads arrive", async () => {
    const rootRead = deferred<string | null>();
    const serverRead = deferred<RemoteProjectStatus | null>();
    const sessionsRead = deferred<{ items: ProjectInspectorSession[] }>();
    api.projectRoot.mockReturnValue(rootRead.promise);
    api.remoteStatus.mockReturnValue(serverRead.promise);
    api.sessions.mockReturnValue(sessionsRead.promise);
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectInspector
            project={project}
            current={false}
            onDelete={() => undefined}
          />
        </QueryClientProvider>,
      );
    });
    const values = () =>
      [...container.querySelectorAll("dd")].map((value) => value.textContent);
    // React Query hands results over on a later task.
    const arrive = (resolve: () => void) =>
      act(async () => {
        resolve();
        await new Promise((done) => setTimeout(done, 5));
      });
    const loading = lineHeights();
    expect(values()).toEqual(["Loading", "None", "Loading"]);
    await arrive(() => rootRead.resolve("/projects/alpha"));
    expect(values()).toEqual(["/projects/alpha", "None", "Loading"]);
    expect(lineHeights()).toEqual(loading);
    // A project on no server is an answer, not a failure.
    await arrive(() => serverRead.resolve(null));
    expect(values()).toEqual(["/projects/alpha", "None", "None"]);
    expect(lineHeights()).toEqual(loading);
    await arrive(() =>
      sessionsRead.resolve({
        items: [{ id: "session-1", title: "Working chat", running: true }],
      }),
    );
    expect(lineHeights()).toEqual(loading);
    expect(text()).toContain("Working chat");
    expect(container.querySelector('[aria-busy="true"]')).toBeNull();
    expect(api.remoteStatus).toHaveBeenCalledWith("alpha");
  });

  it("says a read failed on its own line, quietly", async () => {
    api.projectRoot.mockResolvedValue("/projects/alpha");
    api.remoteStatus.mockRejectedValue(new Error("Project folder not found"));
    await act(async () => {
      root.render(
        <QueryClientProvider client={client}>
          <ProjectInspector project={project} current onDelete={() => {}} />
        </QueryClientProvider>,
      );
    });
    await act(() => new Promise((resolve) => setTimeout(resolve, 0)));
    expect(container.querySelectorAll("dd")[2]?.textContent).toBe(
      "Unavailable",
    );
    expect(container.querySelector('[role="alert"]')).toBeNull();
    expect(text()).not.toContain("could not load");
    expect(api.sessions).not.toHaveBeenCalled();
  });
});
