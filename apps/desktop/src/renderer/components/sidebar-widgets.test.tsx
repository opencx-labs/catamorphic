// @vitest-environment jsdom

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi } from "../lib/desktop-api.js";
import { SidebarNote } from "./sidebar-widgets.js";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: {
    projectLocalFiles: vi.fn(),
    projectRoot: vi.fn(),
    editorFileRead: vi.fn(),
    onGitChanged: vi.fn(() => () => {}),
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
let root: Root;
let client: QueryClient;
let container: HTMLDivElement;

beforeEach(() => {
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  vi.mocked(desktopApi.projectLocalFiles).mockResolvedValue([]);
  vi.mocked(desktopApi.projectRoot).mockResolvedValue("/project");
});

afterEach(() => {
  act(() => root.unmount());
  client.clear();
  container.remove();
  localStorage.clear();
  vi.resetAllMocks();
});

async function render({
  visible = true,
  path,
}: {
  visible?: boolean;
  path?: string;
} = {}) {
  await act(async () => {
    root.render(
      <QueryClientProvider client={client}>
        <SidebarNote
          projectId="project"
          scope="profile:project:note"
          visible={visible}
          path={path}
          onOpenFile={() => {}}
        />
      </QueryClientProvider>,
    );
  });
}

async function expectText(text: string) {
  await act(async () => {
    await vi.waitFor(() => expect(client.isFetching()).toBe(0));
    await new Promise((resolve) => setTimeout(resolve, 0));
  });
  expect(container.textContent).toContain(text);
}

describe("sidebar notes", () => {
  it("refreshes the file picker after changes made while its tab was hidden", async () => {
    await render();
    await expectText("Pin a note");
    await render({ visible: false });
    vi.mocked(desktopApi.projectLocalFiles).mockResolvedValue([
      { path: "new-note.md" },
    ]);
    await render();
    await expectText("new-note.md");
  });

  it("shows file-list failures and lets the user retry without reopening the tab", async () => {
    vi.mocked(desktopApi.projectLocalFiles).mockRejectedValue(
      new Error("offline"),
    );
    await render();
    await expectText("Could not load project notes.");
    vi.mocked(desktopApi.projectLocalFiles).mockResolvedValue([
      { path: "brief.md" },
    ]);
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[role="alert"] button')
        ?.click(),
    );
    await expectText("brief.md");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });

  it("retries a configured note whose read failed, without requiring another pin", async () => {
    vi.mocked(desktopApi.editorFileRead).mockRejectedValue(
      new Error("unavailable"),
    );
    await render({ path: "brief.md" });
    await expectText("This note could not be read.");
    vi.mocked(desktopApi.editorFileRead).mockResolvedValue({
      content: "Recovered note",
    });
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>('[role="alert"] button')
        ?.click(),
    );
    await expectText("Recovered note");
    expect(container.querySelector('[role="alert"]')).toBeNull();
  });
});
