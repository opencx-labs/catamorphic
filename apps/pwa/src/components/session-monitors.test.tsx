import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { SessionMonitors } from "./session-monitors.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
const stop = vi.hoisted(() => vi.fn());
vi.mock("@catamorphic/react", () => ({
  useWatchers: () => ({
    data: {
      items: [
        {
          id: "monitor",
          workflowName: "Review",
          status: "active",
          lastError: null,
          lastRun: { id: "run", status: "failed" },
        },
      ],
    },
    stop: { mutate: stop, isPending: false, error: null },
  }),
}));
it("exposes a failed quiet monitor, its retained source/run, and stop action", async () => {
  const node = document.createElement("div");
  document.body.append(node);
  const root = createRoot(node);
  const open = vi.fn();
  try {
    await act(async () =>
      root.render(
        <SessionMonitors
          projectId="project"
          sessionId="session"
          onOpen={open}
        />,
      ),
    );
    expect(node.querySelector("summary")?.textContent).toBe(
      "Monitors (1), 1 failed",
    );
    const buttons = [...node.querySelectorAll("button")];
    await act(async () => {
      for (const button of buttons) button.click();
    });
    expect(open.mock.calls).toEqual([
      ["artifact", "monitor"],
      ["run", "run"],
    ]);
    expect(stop).toHaveBeenCalledExactlyOnceWith("monitor");
  } finally {
    await act(async () => root.unmount());
    node.remove();
  }
});
