// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReviewGuideDocument } from "./review-guide-document.js";

const state = vi.hoisted(() => {
  const messages: { id: string; role: string; content: string }[] = [];
  return {
    messages,
    send: vi.fn(),
    interrupt: vi.fn(),
  };
});
vi.mock("@catamorphic/react", () => ({
  useAgentCatalog: () => ({
    data: {
      defaultAgentId: "configured",
      items: [
        {
          id: "configured",
          name: "Configured agent",
          available: true,
          environments: { items: [], defaultEnvironment: "local" },
        },
      ],
    },
  }),
  useAgentChat: () => ({
    messages: state.messages,
    send: state.send,
    interrupt: state.interrupt,
    isSending: false,
    isWorking: false,
  }),
}));

it("generates only on request, renders completed output, and opens validated code references", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onOpenFile = vi.fn();
  const files = [
    {
      path: "src/app.ts",
      status: "modified",
      additions: 1,
      deletions: 0,
      patch: "@@ -1 +1 @@\n-a\n+b",
    },
  ];
  const ui = () => (
    <ReviewGuideDocument
      projectId="project"
      number={1}
      title="Change"
      body="Body"
      files={files}
      revision="patch-a"
      onOpenFile={onOpenFile}
    />
  );
  try {
    await act(async () => root.render(ui()));
    expect(state.send).not.toHaveBeenCalled();
    const generate = [...host.querySelectorAll("button")].find(
      (button) => button.textContent === "Generate guide",
    );
    await act(async () => generate?.click());
    expect(state.send).toHaveBeenCalledOnce();
    state.messages = [
      {
        id: "result",
        role: "assistant",
        content:
          "<!-- catamorphic-review-guide -->\n## Behavior\nInspect [implementation](#file=src%2Fapp.ts).\n<!-- /catamorphic-review-guide -->",
      },
    ];
    await act(async () => root.render(ui()));
    expect(host.textContent).toContain("Behavior");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "implementation")
        ?.click(),
    );
    expect(onOpenFile).toHaveBeenCalledWith(files[0]);
    expect(localStorage.getItem("review-guide:project:1")).toContain(
      "## Behavior",
    );
    expect(localStorage.getItem("review-guide:project:1:revision")).toBe(
      "patch-a",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  }
});
