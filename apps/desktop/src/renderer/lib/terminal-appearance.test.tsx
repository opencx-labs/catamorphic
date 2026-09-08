// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { TerminalAppearanceResult } from "../../shared/terminal-appearance.js";
import { desktopApi } from "./desktop-api.js";
import {
  TerminalAppearanceProvider,
  useTerminalAppearance,
} from "./terminal-appearance.js";

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
vi.mock("./theme.js", () => ({ useTheme: () => null }));

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
        <Preview />
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
  });
});
