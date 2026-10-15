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

  const pick = async (label: string) => {
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
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      "Open here",
      "Open in new tab",
      "Open to the side",
      "Open floating",
      "Copy path",
      "Show in Finder",
      "Copy file",
    ]);
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
});
