// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  OpenResourceButton,
  ResourceLinkBoundary,
} from "./open-resource-button.js";

const api = vi.hoisted(() => ({
  projectRoot: vi.fn(async () => "/Users/ada/alpha"),
  revealFolder: vi.fn(async () => {}),
  copyFileToClipboard: vi.fn(async () => {}),
  sayFileActionFailed: vi.fn(async () => {}),
}));
vi.mock("../lib/desktop-api.js", () => ({ desktopApi: api }));

const opened = vi.fn();

/** A file's tab: its open button, which knows the file. */
function FileTab({ filePath }: { filePath: string }) {
  return (
    <OpenResourceButton onOpen={opened} file={{ projectId: "alpha", filePath }}>
      plan.md
    </OpenResourceButton>
  );
}

/** A reply's file link, inside the chat's boundary for link menus. */
function FileLink({ href }: { href: string }) {
  return (
    <ResourceLinkBoundary projectId="alpha" onOpen={opened}>
      <a href={href}>the plan</a>
    </ResourceLinkBoundary>
  );
}

describe("the file menu", () => {
  let container: HTMLDivElement;
  let root: Root;
  const writeText = vi.fn(async () => {});

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    Object.defineProperty(navigator, "clipboard", {
      configurable: true,
      value: { writeText },
    });
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.clearAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const ALL = [
    "Open here",
    "Open in new tab",
    "Open to the side",
    "Open floating",
    "Copy path",
    "Show in Finder",
    "Copy file",
  ];
  const pick = async (label: string, listed = ALL) => {
    await act(async () => {
      container.querySelector("button, a")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 20,
        }),
      );
    });
    const items = [...document.querySelectorAll('[role="menuitem"]')];
    // The ways to open it first, then what can be done with the file.
    expect(items.map((item) => item.textContent?.trim())).toEqual(listed);
    const item = items.find((entry) => entry.textContent?.trim() === label);
    await act(async () => {
      if (item instanceof HTMLElement) item.click();
    });
  };

  it("acts on the file's path on this machine, a project path resolved", async () => {
    await act(async () => root.render(<FileTab filePath="notes/plan.md" />));
    await pick("Copy path");
    expect(writeText).toHaveBeenCalledWith("/Users/ada/alpha/notes/plan.md");
    await pick("Show in Finder");
    expect(api.revealFolder).toHaveBeenCalledWith(
      "/Users/ada/alpha/notes/plan.md",
    );
    await pick("Copy file");
    expect(api.copyFileToClipboard).toHaveBeenCalledWith(
      "/Users/ada/alpha/notes/plan.md",
    );
  });

  it("still opens it the ways it lists", async () => {
    await act(async () => root.render(<FileTab filePath="notes/plan.md" />));
    await pick("Open to the side");
    // The menu leaves first; the choice runs once it has.
    await act(async () => new Promise((resolve) => setTimeout(resolve, 250)));
    expect(opened).toHaveBeenCalledWith("side");
    expect(api.revealFolder).not.toHaveBeenCalled();
  });

  it("acts the same on a file link in chat", async () => {
    await act(async () => root.render(<FileLink href="notes/plan.md" />));
    await pick("Copy file");
    expect(api.copyFileToClipboard).toHaveBeenCalledWith(
      "/Users/ada/alpha/notes/plan.md",
    );
  });

  it("takes an absolute path as it is", async () => {
    await act(async () =>
      root.render(<FileTab filePath="/tmp/elsewhere/report.md" />),
    );
    await pick("Copy file");
    expect(api.projectRoot).not.toHaveBeenCalled();
    expect(api.copyFileToClipboard).toHaveBeenCalledWith(
      "/tmp/elsewhere/report.md",
    );
  });

  it("has no Copy file for a folder link", async () => {
    await act(async () => root.render(<FileLink href="notes/" />));
    await pick(
      "Copy path",
      ALL.filter((label) => label !== "Copy file"),
    );
    expect(writeText).toHaveBeenCalledWith("/Users/ada/alpha/notes/");
  });

  it("says why when it could not be done, the menu already gone", async () => {
    api.copyFileToClipboard.mockRejectedValueOnce(
      new Error(
        "Error invoking remote method 'catamorphic:copy-file-to-clipboard': Error: ENOENT: no such file or directory, stat '/Users/ada/alpha/notes/plan.md'",
      ),
    );
    await act(async () => root.render(<FileLink href="notes/plan.md" />));
    await pick("Copy file");
    expect(api.sayFileActionFailed).toHaveBeenCalledWith({
      message: "“plan.md” could not be copied",
      detail: "It is no longer at this location.",
    });
  });

  it("leaves once picked, while its owner keeps re-rendering", async () => {
    await act(async () => root.render(<FileTab filePath="notes/plan.md" />));
    await pick("Copy path");
    // A live tab re-renders often; the menu's exit wait does not restart.
    for (let elapsed = 0; elapsed < 400; elapsed += 50)
      await act(async () => {
        root.render(<FileTab filePath="notes/plan.md" />);
        await new Promise((resolve) => setTimeout(resolve, 50));
      });
    expect(document.querySelector('[role="menuitem"]')).toBeNull();
  });

  it("keeps a right-click inside it from reaching its owner", async () => {
    const owner = vi.fn();
    await act(async () =>
      root.render(
        // biome-ignore lint/a11y/noStaticElementInteractions: a tab's catch-all right-click, as the top bar's tabs have
        <div onContextMenu={owner}>
          <FileTab filePath="notes/plan.md" />
        </div>,
      ),
    );
    await act(async () => {
      container.querySelector("button")?.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: 40,
          clientY: 20,
        }),
      );
    });
    const item = document.querySelector('[role="menuitem"]');
    const inside = new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
    });
    await act(async () => {
      item?.dispatchEvent(inside);
    });
    // Neither its owner nor the window's own menu takes it.
    expect(owner).not.toHaveBeenCalled();
    expect(inside.defaultPrevented).toBe(true);
    expect(document.querySelectorAll('[role="menuitem"]')).toHaveLength(7);
  });
});
