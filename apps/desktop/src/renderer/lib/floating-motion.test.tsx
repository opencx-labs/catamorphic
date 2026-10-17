// @vitest-environment jsdom

import { act, useLayoutEffect } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  CHAT_EXPAND_MS,
  useFloatingMotion,
  useRecedingSurface,
} from "./floating-motion.js";

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

describe("useFloatingMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  let motion: ReturnType<typeof useFloatingMotion>;
  /** In order: each commit that shows the exit, and each finish. */
  let events: string[];

  function Probe({ identity }: { identity: string | undefined }) {
    const current = useFloatingMotion(identity);
    const { closing } = current;
    motion = current;
    useLayoutEffect(() => {
      if (closing) events.push("closing");
    }, [closing]);
    return null;
  }

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.useFakeTimers();
    vi.stubGlobal("matchMedia", () => ({ matches: false }));
    events = [];
    container = document.createElement("div");
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    vi.unstubAllGlobals();
    vi.useRealTimers();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  const render = (identity: string | undefined) =>
    act(() => root.render(<Probe identity={identity} />));
  /** The host's finish: the surface leaves the workspace. */
  const leave = (name: string) => () => {
    events.push(name);
    root.render(<Probe identity={undefined} />);
  };

  it("plays the whole exit when the closing state commits late", () => {
    render("p1:app:a");
    act(() => {
      void motion.dismiss(leave("finish"));
      // A busy renderer: the exit's time passes before the closing state
      // reaches the screen.
      vi.advanceTimersByTime(200);
    });
    expect(events).toEqual(["closing"]);
    act(() => vi.advanceTimersByTime(199));
    expect(events).toEqual(["closing"]);
    act(() => vi.advanceTimersByTime(1));
    expect(events).toEqual(["closing", "finish"]);
  });

  it("resolves each dismissal once the surface has left", async () => {
    render("p1:app:a");
    const settled: string[] = [];
    act(() => {
      void motion.dismiss(leave("first")).then(() => settled.push("first"));
    });
    // A dismissal already under way skips this one's finish.
    act(() => {
      void motion.dismiss(leave("second")).then(() => settled.push("second"));
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(events).toEqual(["closing", "first"]);
    expect(settled).toEqual(["first", "second"]);
  });

  it("drops the exit of a surface a newer one replaced, and resolves it", async () => {
    render("p1:app:a");
    let settled = false;
    act(() => {
      void motion.dismiss(leave("finish")).then(() => {
        settled = true;
      });
    });
    render("p1:app:b");
    await act(async () => vi.advanceTimersByTime(200));
    expect(events).toEqual(["closing"]);
    expect(settled).toBe(true);
    expect(motion.closing).toBe(false);
  });

  it("resolves when its finish keeps the surface", async () => {
    render("p1:app:a");
    let settled = false;
    act(() => {
      // A draft asks before it closes: the surface stays.
      void motion
        .dismiss(() => events.push("finish"))
        .then(() => {
          settled = true;
        });
    });
    await act(async () => vi.advanceTimersByTime(200));
    expect(events).toEqual(["closing", "finish"]);
    expect(settled).toBe(true);
    expect(motion.closing).toBe(false);
  });

  it("finishes at once with nothing floating", async () => {
    render(undefined);
    const finish = vi.fn();
    await act(() => motion.dismiss(finish));
    expect(finish).toHaveBeenCalledOnce();
    expect(events).toEqual([]);
  });
});
