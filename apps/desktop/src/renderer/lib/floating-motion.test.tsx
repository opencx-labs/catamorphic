// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CHAT_EXPAND_MS, useRecedingSurface } from "./floating-motion.js";

type Chats = Array<{ localId: string; mode: string }>;

describe("useRecedingSurface", () => {
  let container: HTMLDivElement;
  let root: Root;
  /** What each committed render showed, in order. */
  let seen: Array<string | null>;

  function Probe(props: {
    identity: string;
    activeTabKey: string;
    chats: Chats;
  }) {
    const receding = useRecedingSurface(props);
    // Committed renders only: one React discards never reaches the screen.
    useLayoutEffect(() => {
      seen.push(receding);
    });
    return null;
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    seen = [];
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (activeTabKey: string, chats: Chats, identity = "p1") =>
    act(() =>
      root.render(
        <Probe identity={identity} activeTabKey={activeTabKey} chats={chats} />,
      ),
    );

  it("keeps what was in front while a floating chat grows into its tab", () => {
    render("settings", [{ localId: "a", mode: "partial" }]);
    seen = [];
    render("chat:a", [{ localId: "a", mode: "tab" }]);
    // Every render committed with the chat in front already had it: the
    // surface is never dropped for a frame first.
    expect(seen).toEqual(["settings"]);
    act(() => vi.advanceTimersByTime(CHAT_EXPAND_MS - 1));
    expect(seen.at(-1)).toBe("settings");
    act(() => vi.advanceTimersByTime(1));
    expect(seen.at(-1)).toBeNull();
  });

  it("lets go at once of anything else that changes what is in front", () => {
    render("settings", [{ localId: "a", mode: "tab" }]);
    // A chat that was already a tab, selected from the strip.
    render("chat:a", [{ localId: "a", mode: "tab" }]);
    expect(seen.at(-1)).toBeNull();
    render("settings", [{ localId: "a", mode: "partial" }]);
    expect(seen.at(-1)).toBeNull();
  });

  it("lets go when the workspace changes", () => {
    render("settings", [{ localId: "a", mode: "partial" }]);
    render("chat:a", [{ localId: "a", mode: "tab" }]);
    expect(seen.at(-1)).toBe("settings");
    render("chat:a", [{ localId: "a", mode: "tab" }], "p2");
    expect(seen.at(-1)).toBeNull();
  });

  it("holds nothing when motion is reduced", () => {
    vi.stubGlobal("matchMedia", () => ({ matches: true }));
    render("settings", [{ localId: "a", mode: "partial" }]);
    render("chat:a", [{ localId: "a", mode: "tab" }]);
    expect(seen.at(-1)).toBeNull();
  });

  it("settles on a rebuilt but equal list of chats", () => {
    render("settings", [{ localId: "a", mode: "partial" }]);
    const renders = seen.length;
    // A default workspace rebuilds its chats each render.
    render("settings", [{ localId: "a", mode: "partial" }]);
    expect(seen.length - renders).toBe(1);
  });
});
