// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { desktopApi, type ProfileConnection } from "../lib/desktop-api.js";
import { ProfileInspector } from "./profile-inspector";

vi.mock("../lib/desktop-api.js", () => ({
  desktopApi: { profileConnections: vi.fn() },
}));

const profile = {
  id: "8b2f4c1e-0000-4000-8000-000000000001",
  name: "Work",
  color: "#e5484d",
  projectIds: ["p1"],
};

describe("ProfileInspector", () => {
  let container: HTMLDivElement;
  let root: Root;
  let loaded: {
    resolve: (value: ProfileConnection[]) => void;
    reject: (error: Error) => void;
  };

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.mocked(desktopApi.profileConnections).mockImplementation(
      () =>
        new Promise((resolve, reject) => {
          loaded = { resolve, reject };
        }),
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });
  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = async (
    defaultProfileId = profile.id,
    onOpenSettings = vi.fn(),
  ) => {
    await act(async () => {
      root.render(
        <ProfileInspector
          profile={profile}
          data={{ profiles: [profile], defaultProfileId }}
          onOpenSettings={onOpenSettings}
        />,
      );
    });
    return onOpenSettings;
  };
  const text = () => container.textContent ?? "";

  it("shows who the profile is and nothing it holds", async () => {
    await render();
    expect(text()).toContain("Work");
    expect(text()).toContain("Default");
    expect(text()).not.toContain(profile.id);
    expect(text()).not.toContain("Projects");
    expect(text()).not.toContain("Agent");
    await render("another");
    expect(text()).not.toContain("Default");
  });

  it("opens settings from the gear", async () => {
    const onOpenSettings = await render();
    await act(async () =>
      container
        .querySelector<HTMLButtonElement>(
          '[aria-label="Open settings for Work"]',
        )
        ?.click(),
    );
    expect(onOpenSettings).toHaveBeenCalled();
  });

  it("lists connections with their icon, favicon or glyph", async () => {
    await render();
    expect(desktopApi.profileConnections).toHaveBeenCalledWith(profile.id);
    expect(container.querySelector("[aria-busy]")).not.toBeNull();
    await act(async () =>
      loaded.resolve([
        { name: "Linear", iconUrl: "https://registry.example/linear.svg" },
        { name: "Docs", url: "https://docs.example.com/mcp" },
        { name: "Local files" },
      ]),
    );
    expect(container.querySelector("[aria-busy]")).toBeNull();
    const rows = [...container.querySelectorAll("li")];
    expect(rows.map((row) => row.textContent)).toEqual([
      "Linear",
      "Docs",
      "Local files",
    ]);
    expect(rows[0]?.querySelector("img")?.getAttribute("src")).toBe(
      "https://registry.example/linear.svg",
    );
    expect(rows[1]?.querySelector("img")?.getAttribute("src")).toBe(
      "https://docs.example.com/favicon.ico",
    );
    expect(rows[2]?.querySelector("img")).toBeNull();
    expect(rows[2]?.querySelector('[aria-label="Local files"]')).not.toBeNull();
  });

  it("falls back to the glyph when every image fails", async () => {
    await render();
    await act(async () =>
      loaded.resolve([
        {
          name: "Linear",
          iconUrl: "https://registry.example/broken.svg",
          url: "https://mcp.linear.example/sse",
        },
      ]),
    );
    const image = () => container.querySelector("li img");
    expect(image()?.getAttribute("src")).toBe(
      "https://registry.example/broken.svg",
    );
    await act(async () => image()?.dispatchEvent(new Event("error")));
    expect(image()?.getAttribute("src")).toBe(
      "https://mcp.linear.example/favicon.ico",
    );
    await act(async () => image()?.dispatchEvent(new Event("error")));
    expect(image()).toBeNull();
  });

  it("collapses a long list, and says when there are none or they cannot load", async () => {
    await render();
    await act(async () =>
      loaded.resolve(
        Array.from({ length: 8 }, (_, index) => ({ name: `C${index}` })),
      ),
    );
    expect(container.querySelectorAll("li")).toHaveLength(6);
    expect(text()).toContain("2 more");
    await act(async () => root.render(<div />));
    await render();
    await act(async () => loaded.resolve([]));
    expect(text()).toContain("None yet");
    await act(async () => root.render(<div />));
    await render();
    await act(async () => loaded.reject(new Error("gone")));
    expect(text()).toContain("Unavailable");
  });
});
