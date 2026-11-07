// @vitest-environment jsdom
import { createApiClient } from "@catamorphic/api-client";
import type { CollectionPage } from "@catamorphic/app";
import { CatamorphicProvider } from "@catamorphic/react";
import { QueryClient } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarSourceItem } from "../../shared/sidebar-source.js";
import { CHIPS_OWNER_ID } from "../../shared/workspace-config.js";
import type { desktopApi } from "../lib/desktop-api.js";
import { useAnswerSourceWork, type WorkSources } from "./registry.js";

type WorkListener = Parameters<typeof desktopApi.onSidebarSourceWork>[0];
type WorkRequest = Parameters<WorkListener>[0];
const ipc = vi.hoisted(() => ({
  listeners: new Set<WorkListener>(),
  reply: vi.fn(
    async (
      _result: Parameters<typeof desktopApi.sidebarSourceWorkResult>[0],
    ) => {},
  ),
}));
vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    onSidebarSourceWork: (listener: WorkListener) => {
      ipc.listeners.add(listener);
      return () => {
        ipc.listeners.delete(listener);
      };
    },
    sidebarSourceWorkResult: ipc.reply,
  },
}));

function memorySources(
  rows: WorkSources["rows"] = async () => ({ items: [] }),
) {
  return {
    get: () => {
      throw new Error("Unexpected source lookup");
    },
    rows: vi.fn(rows),
    read: vi.fn(async () => ({ items: [] })),
    execute: vi.fn(async () => {}),
    open: vi.fn(),
    noteRead: vi.fn(),
    watchReads: () => () => {},
    readAll: vi.fn(async () => []),
  } satisfies WorkSources;
}

function Project({
  projectId,
  sources,
}: {
  projectId: string;
  sources: WorkSources | null;
}) {
  useAnswerSourceWork({ projectId, sources });
  return null;
}

let root: Root;
let client: QueryClient;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  ipc.reply.mockClear();
  root = createRoot(document.createElement("div"));
  client = new QueryClient();
});
afterEach(() => {
  act(() => root.unmount());
  expect(ipc.listeners.size).toBe(0);
  client.clear();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

async function retainProjects({
  first,
  second,
}: {
  first: WorkSources | null;
  second: WorkSources | null;
}) {
  await act(async () => {
    root.render(
      <CatamorphicProvider
        apiClient={createApiClient({ baseUrl: "http://test", fetch: vi.fn() })}
        queryClient={client}
      >
        <Project projectId="default" sources={first} />
        <Project projectId="requested" sources={second} />
      </CatamorphicProvider>,
    );
  });
  expect(ipc.listeners.size).toBe(2);
}

async function request(overrides: Partial<WorkRequest> = {}) {
  await act(async () => {
    for (const listener of ipc.listeners)
      listener({
        callId: "call",
        projectId: "requested",
        sectionId: "custom-tabs",
        call: { op: "read", source: "tabs" },
        ...overrides,
      });
  });
}

it.each([false, true])(
  "only the owning project replies when another retained project's sources are available: %s",
  async (otherAvailable) => {
    let finish!: (page: CollectionPage<SidebarSourceItem>) => void;
    const pending = new Promise<CollectionPage<SidebarSourceItem>>(
      (resolve) => {
        finish = resolve;
      },
    );
    const other = memorySources();
    const owner = memorySources(() => pending);
    await retainProjects({
      first: otherAvailable ? other : null,
      second: owner,
    });

    await request();
    // A hidden project's error used to win before this async read completed.
    expect(ipc.reply).not.toHaveBeenCalled();
    expect(other.rows).not.toHaveBeenCalled();
    expect(other.noteRead).not.toHaveBeenCalled();
    expect(owner.rows).toHaveBeenCalledTimes(1);
    expect(owner.noteRead).toHaveBeenCalledExactlyOnceWith(
      "custom-tabs",
      "tabs",
    );
    const page = { items: [{ id: "chat", label: "Requested project's chat" }] };
    await act(async () => finish(page));
    expect(ipc.reply).toHaveBeenCalledExactlyOnceWith({
      callId: "call",
      ok: true,
      value: page,
    });
  },
);

it("reports unavailable sources only from the owning project", async () => {
  const other = memorySources();
  await retainProjects({ first: other, second: null });
  await request();
  expect(ipc.reply).toHaveBeenCalledExactlyOnceWith({
    callId: "call",
    ok: false,
    error: "This project is not open here.",
  });
  expect(other.rows).not.toHaveBeenCalled();
});

it("leaves chips and other projects' requests to their own handlers", async () => {
  const first = memorySources();
  const second = memorySources();
  await retainProjects({ first, second });
  await request({ sectionId: CHIPS_OWNER_ID });
  await request({ projectId: "another-window-project" });
  expect(ipc.reply).not.toHaveBeenCalled();
  expect(first.rows).not.toHaveBeenCalled();
  expect(second.rows).not.toHaveBeenCalled();
});
