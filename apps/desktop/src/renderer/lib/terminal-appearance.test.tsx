// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveThemeLayers } from "../../main/theme.js";
import type { TerminalAppearanceResult } from "../../shared/terminal-appearance.js";
import { desktopApi } from "./desktop-api.js";
import {
  TerminalAppearanceProvider,
  useTerminalAppearance,
} from "./terminal-appearance.js";
import { ThemeScope } from "./theme.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const listeners = vi.hoisted(
  () => new Set<(prefs: { terminalAppearance: "app" | "ghostty" }) => void>(),
);
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    getPrefs: vi.fn().mockResolvedValue({ terminalAppearance: "ghostty" }),
    terminalGhosttyAppearance: vi.fn(),
    onPrefsChanged: (
      listener: (prefs: { terminalAppearance: "app" | "ghostty" }) => void,
    ) => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  },
}));
const profileTheme = resolveThemeLayers([
  { selection: "catppuccin-macchiato" },
]);
const projectTheme = resolveThemeLayers([
  { selection: "dark", fonts: { mono: "Menlo, monospace" } },
]);

const mocha: TerminalAppearanceResult = {
  ok: true,
  appearance: {
    name: "Mocha",
    fontFamily: "monospace",
    fontSize: 18,
    theme: { background: "#1e1e2e", foreground: "#cdd6f4" },
  },
};
function Preview() {
  const value = useTerminalAppearance();
  return (
    <button
      type="button"
      onClick={value.reload}
      data-ready={value.ready}
      data-loading={value.loading}
      data-background={value.appearance.theme.background}
      data-cursor={value.appearance.theme.cursor}
      data-font={value.appearance.fontFamily}
    >
      {value.appearance.name}:{value.error}
    </button>
  );
}
let root: Root | undefined;
let container: HTMLDivElement;
async function mount() {
  container = document.createElement("div");
  root = createRoot(container);
  await act(async () => {
    root?.render(
      <TerminalAppearanceProvider>
        <ThemeScope theme={projectTheme}>
          <Preview />
        </ThemeScope>
      </TerminalAppearanceProvider>,
    );
  });
}
afterEach(() => {
  act(() => root?.unmount());
  vi.clearAllMocks();
});

describe("terminal appearance loading", () => {
  it("waits for Ghostty before starting a new terminal and retains the last good appearance during a failed reload", async () => {
    let resolve: (result: TerminalAppearanceResult) => void = () => {};
    vi.mocked(desktopApi.terminalGhosttyAppearance).mockImplementation(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    await mount();
    expect(container.querySelector("button")?.dataset.ready).toBe("false");
    await act(async () => {
      resolve(mocha);
    });
    expect(container.textContent).toBe("Mocha:");
    expect(container.querySelector("button")?.dataset.ready).toBe("true");
    await act(async () => {
      container.querySelector("button")?.click();
    });
    expect(container.textContent).toBe("Mocha:");
    expect(container.querySelector("button")?.dataset.loading).toBe("true");
    await act(async () => {
      resolve({ ok: false, error: "Configuration is invalid" });
    });
    expect(container.textContent).toBe("Mocha:Configuration is invalid");
    expect(container.querySelector("button")?.dataset.ready).toBe("true");
    await act(async () => {
      for (const listener of listeners) listener({ terminalAppearance: "app" });
    });
    expect(container.textContent).toBe("App theme:");
  });

  it("falls back to the app appearance when Ghostty is unavailable", async () => {
    vi.mocked(desktopApi.terminalGhosttyAppearance).mockResolvedValue({
      ok: false,
      error: "Ghostty is unavailable",
    });
    await mount();
    expect(container.textContent).toBe("App theme:Ghostty is unavailable");
    expect(container.querySelector("button")?.dataset.ready).toBe("true");
    expect(container.querySelector("button")?.dataset.background).toBe(
      projectTheme.colors["bg-inset"],
    );
  });

  it("derives each terminal from its nearest theme scope, even below the shared appearance loader", async () => {
    vi.mocked(desktopApi.getPrefs).mockResolvedValue({
      terminalAppearance: "app",
    } as Awaited<ReturnType<typeof desktopApi.getPrefs>>);
    await mount();
    const render = async (loaded: boolean) =>
      act(async () => {
        root?.render(
          <ThemeScope theme={profileTheme}>
            <TerminalAppearanceProvider>
              <Preview />
              <ThemeScope theme={loaded ? projectTheme : null}>
                <Preview />
              </ThemeScope>
            </TerminalAppearanceProvider>
          </ThemeScope>,
        );
      });
    await render(false);
    let buttons = container.querySelectorAll("button");
    expect(buttons[0]?.dataset.background).toBe(
      profileTheme.colors["bg-inset"],
    );
    expect(buttons[1]?.dataset.ready).toBe("false");
    await render(true);
    buttons = container.querySelectorAll("button");
    expect(buttons[1]?.dataset.ready).toBe("true");
    expect(buttons[1]?.dataset.background).toBe(
      projectTheme.colors["bg-inset"],
    );
    expect(buttons[1]?.dataset.cursor).toBe(projectTheme.colors.accent);
    expect(buttons[1]?.dataset.font).toBe("Menlo, monospace");
    expect(desktopApi.terminalGhosttyAppearance).not.toHaveBeenCalled();
  });
});
