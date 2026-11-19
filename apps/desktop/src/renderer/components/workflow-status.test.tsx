// @vitest-environment jsdom

import type { WorkflowGraph } from "@catamorphic/react/types";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { WorkflowStatus } from "./workflow-status.js";

let container: HTMLDivElement;
let root: Root;

beforeEach(() => {
  container = document.createElement("div");
  document.body.appendChild(container);
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
  container.remove();
  document.body.innerHTML = "";
});

/** The parts of a parsed workflow the status card reads. */
const graph = {
  name: "pollGithub",
  displayName: "Poll GitHub",
  input: { parameters: [] },
  nodes: [],
  triggers: [],
  connections: [],
  permissions: ["events:write"],
  documents: [
    { path: "store/config.json", access: "read" },
    { path: "store/github-polling/", access: "write" },
  ],
} as unknown as WorkflowGraph;

it("lists the store documents a workflow declares beside its permissions (ADR 0335)", async () => {
  await act(async () =>
    root.render(
      <WorkflowStatus
        graph={graph}
        workflowName="pollGithub"
        filePath=".work/workflows/src/github-polling.ts"
        saving={false}
        dirty={false}
        conflict={false}
        preview="ready"
        automation={{ kind: "off" }}
        canEdit
        openRequest={1}
        onDescribeChange={() => {}}
        onCode={() => {}}
        onOpenInEditor={() => {}}
        onRuns={() => {}}
        onAutomation={() => {}}
      />,
    ),
  );
  const text = document.body.textContent ?? "";
  expect(text).toContain("Record events that start the project's automations");
  expect(text).toContain(
    "Read store/config.json; Write store/github-polling/ and everything in it",
  );
});
