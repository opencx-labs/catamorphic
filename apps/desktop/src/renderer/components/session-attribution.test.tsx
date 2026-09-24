// @vitest-environment jsdom

import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { SessionAttribution } from "./catamorphic/session-attribution.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  (
    globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }
  ).IS_REACT_ACT_ENVIRONMENT = true;
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
});

const label = async (
  author: Parameters<typeof SessionAttribution>[0]["author"],
) => {
  await act(async () => root.render(<SessionAttribution author={author} />));
  return container.querySelector("a")?.textContent;
};

it("names a workflow by its display name, or readably without one", async () => {
  const runId = "00000000-0000-4000-8000-000000000001";
  expect(
    await label({
      kind: "workflow",
      runId,
      workflowName: "staleChatNudge",
      displayName: "Nudge quiet chats",
    }),
  ).toBe("Nudge quiet chats");
  expect(
    await label({ kind: "workflow", runId, workflowName: "staleChatNudge" }),
  ).toBe("Stale chat nudge");
  expect(
    await label({ kind: "workflow", runId, workflowName: "crm.lookup_v2" }),
  ).toBe("Crm lookup v2");
});
