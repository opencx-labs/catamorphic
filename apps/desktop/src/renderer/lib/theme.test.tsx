// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { resolveThemeLayers } from "../../main/theme.js";
import { desktopApi } from "./desktop-api.js";
import { useProjectTheme } from "./theme.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
vi.mock("./desktop-api.js", () => ({
  desktopApi: { getTheme: vi.fn(), onThemeChanged: () => () => {} },
}));

it("never returns a previous project's or profile's theme while its new owner loads", async () => {
  const purple = resolveThemeLayers([{ selection: "catppuccin-macchiato" }]);
  const amber = resolveThemeLayers([{ selection: "dark" }]);
  let finish: (theme: typeof amber) => void = () => {};
  vi.mocked(desktopApi.getTheme)
    .mockResolvedValueOnce(purple)
    .mockImplementation(
      () =>
        new Promise((resolve) => {
          finish = resolve;
        }),
    );
  const container = document.createElement("div");
  const root = createRoot(container);
  function Preview({ project, profile }: { project: string; profile: string }) {
    return (
      <span>{useProjectTheme(project, profile)?.preset ?? "waiting"}</span>
    );
  }
  try {
    await act(async () => {
      root.render(<Preview project="one" profile="a" />);
    });
    expect(container.textContent).toBe("catppuccin-macchiato");
    await act(async () => {
      root.render(<Preview project="two" profile="a" />);
    });
    expect(container.textContent).toBe("waiting");
    const stale = finish;
    await act(async () => {
      root.render(<Preview project="two" profile="b" />);
    });
    expect(container.textContent).toBe("waiting");
    await act(async () => {
      stale(purple);
    });
    expect(container.textContent).toBe("waiting");
    await act(async () => {
      finish(amber);
    });
    expect(container.textContent).toBe("dark");
  } finally {
    await act(async () => {
      root.unmount();
    });
  }
});
