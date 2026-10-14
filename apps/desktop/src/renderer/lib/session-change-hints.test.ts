// @vitest-environment jsdom
import { agentSessionQueryKey, watcherKeys } from "@catamorphic/react";
import { expect, it } from "vitest";
import { readsChats } from "./session-change-hints.js";

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
