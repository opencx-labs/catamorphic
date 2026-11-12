// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { ReviewGuideDocument } from "./review-guide-document.js";

vi.mock("@tanstack/react-query", () => ({
  useQuery: () => ({ data: { state: "ready" }, refetch: state.refetch }),
}));

const state = vi.hoisted(() => {
  const turns: {
    status: "failed" | "completed";
    error?: { message: string };
  }[] = [];
  return {
    turns,
    artifacts: [] as {
      id: string;
      kind: string;
      status: string;
      title: string;
      revision: number;
      appName: string;
    }[],
    refetch: vi.fn(),
    send: vi.fn(),
    interrupt: vi.fn(),
  };
});
vi.mock("@catamorphic/react", () => ({
  useCatamorphic: () => ({ apiClient: { GET: vi.fn() } }),
  useSessionArtifacts: () => ({
    data: state.artifacts,
    refetch: state.refetch,
  }),
  useAgentCatalog: () => ({
    data: {
      defaultAgentId: "configured",
      items: [
        {
          id: "configured",
          name: "Configured agent",
          available: true,
          environments: { items: [], defaultEnvironment: "default" },
        },
      ],
    },
  }),
  useAgentChat: () => ({
    timeline: state.turns.map((turn) => ({ turn })),
    send: state.send,
    interrupt: state.interrupt,
    isSending: false,
    isWorking: false,
  }),
}));

it("generates on request and opens the returned ordinary app", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const onOpenArtifact = vi.fn();
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
      onOpenArtifact={onOpenArtifact}
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
    state.artifacts = [
      {
        id: "artifact",
        kind: "app",
        status: "active",
        title: "Review change",
        revision: 1,
        appName: "session-real-id",
      },
    ];
    await act(async () => root.render(ui()));
    expect(host.textContent).toContain("Review change");
    await act(async () =>
      [...host.querySelectorAll("button")]
        .find((button) => button.textContent === "Open review")
        ?.click(),
    );
    expect(onOpenArtifact).toHaveBeenCalledWith(
      "app:session-real-id",
      "Review change",
    );
    expect(localStorage.getItem("review-app:project:1:revision")).toBe(
      "patch-a",
    );
  } finally {
    await act(async () => root.unmount());
    host.remove();
    localStorage.clear();
  }
});

it("shows a settled generation failure and clears it after a successful retry", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  localStorage.clear();
  state.artifacts = [];
  state.turns.push({
    status: "failed",
    error: { message: "App bundle exceeds the size limit." },
  });
  const host = document.createElement("div");
  document.body.append(host);
  const root = createRoot(host);
  const ui = () => (
    <ReviewGuideDocument
      projectId="failed-review"
      number={2}
      title="Change"
      body="Body"
      files={[
        {
          path: "src/app.ts",
          status: "modified",
          additions: 1,
          deletions: 0,
          patch: "@@ -1 +1 @@\n-a\n+b",
        },
      ]}
      revision="patch-b"
    />
  );
  try {
    await act(async () => root.render(ui()));
    expect(host.querySelector('[role="alert"]')?.textContent).toBe(
      "App bundle exceeds the size limit.",
    );
    state.turns.push({ status: "completed" });
    await act(async () => root.render(ui()));
    expect(host.querySelector('[role="alert"]')).toBeNull();
  } finally {
    await act(async () => root.unmount());
    host.remove();
    state.turns.length = 0;
    localStorage.clear();
  }
});
