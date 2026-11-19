// @vitest-environment jsdom
import { agentSessionQueryKey, watcherKeys } from "@catamorphic/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { act, createElement } from "react";
import { createRoot } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { readsChats, useSessionChangeHints } from "./session-change-hints.js";

const hints = vi.hoisted(() => new Set<() => void>());
vi.mock("./desktop-api.js", () => ({
  desktopApi: {
    onSessionsChanged: (listener: () => void) => {
      hints.add(listener);
      return () => hints.delete(listener);
    },
  },
}));

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

afterEach(() => {
  Reflect.deleteProperty(document, "hidden");
  document.body.replaceChildren();
});

it("reads chat lists, attention and watchers again on a hint, never a streaming conversation", () => {
  expect(
    readsChats(["cat", "project", "p", "agent", "sessions", { limit: 100 }]),
  ).toBe(true);
  expect(readsChats(["cat", "agent", "attention"])).toBe(true);
  expect(readsChats(watcherKeys.list("p", "s"))).toBe(true);
  expect(readsChats(agentSessionQueryKey("p", "s"))).toBe(false);
  expect(readsChats(["cat", "project", "p", "apps"])).toBe(false);
  expect(readsChats(["desktop", "sidebar", "agent", "p", "page"])).toBe(false);
});

it("reads nothing for hints while the window is hidden, and once as it shows again", () => {
  const client = new QueryClient();
  const read = vi.spyOn(client, "refetchQueries").mockResolvedValue();
  let hidden = false;
  Object.defineProperty(document, "hidden", {
    configurable: true,
    get: () => hidden,
  });
  const hint = () => {
    for (const listener of hints) listener();
  };
  const Probe = () => {
    useSessionChangeHints();
    return null;
  };
  const root = createRoot(
    document.body.appendChild(document.createElement("div")),
  );
  act(() => {
    root.render(
      createElement(QueryClientProvider, { client }, createElement(Probe)),
    );
  });

  hint();
  expect(read).toHaveBeenCalledTimes(1);

  hidden = true;
  hint();
  hint();
  expect(read).toHaveBeenCalledTimes(1);

  hidden = false;
  document.dispatchEvent(new Event("visibilitychange"));
  expect(read).toHaveBeenCalledTimes(2);
  // Shown again with nothing dropped: nothing to read.
  document.dispatchEvent(new Event("visibilitychange"));
  expect(read).toHaveBeenCalledTimes(2);

  act(() => root.unmount());
  expect(hints.size).toBe(0);
});
