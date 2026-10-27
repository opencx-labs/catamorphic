// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { SidebarSourceSession } from "../../shared/sidebar-source.js";
import { useChips } from "./use-chips.js";

const { load } = vi.hoisted(() => ({ load: vi.fn() }));
vi.mock("../sources/module.js", () => ({
  moduleSource: () => ({
    load,
    title: "Custom chips",
    empty: "",
    capabilities: () => ({ move: false, drop: false, reveal: false }),
  }),
}));
vi.mock("./desktop-api.js", () => ({ desktopApi: {} }));
const session: SidebarSourceSession = {
  id: "refresh-chat",
  title: null,
  metadata: {},
};
let root: Root;
let container: HTMLDivElement;
function Probe({ nonce, enabled }: { nonce: number; enabled: boolean }) {
  const view = useChips({
    projectId: "p",
    module: "chips.ts",
    session,
    defaults: [],
    enabled,
    refreshNonce: nonce,
  });
  return (
    <div>
      {view.chips.map((chip) => chip.label).join(",")}
      {view.failure?.message}
    </div>
  );
}
async function render(nonce = 0, enabled = true) {
  await act(async () => root.render(<Probe nonce={nonce} enabled={enabled} />));
}
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  load.mockReset();
  container = document.createElement("div");
  document.body.append(container);
  root = createRoot(container);
});
afterEach(() => {
  act(() => root.unmount());
  container.remove();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
});

it("refreshes unchanged custom chips on request and keeps the last good chips on failure", async () => {
  load.mockResolvedValue({ items: [{ id: "deploy", label: "Building" }] });
  await render();
  expect(container.textContent).toBe("Building");
  load.mockResolvedValue({ items: [{ id: "deploy", label: "Live" }] });
  await render(1);
  expect(container.textContent).toBe("Live");
  expect(load).toHaveBeenCalledTimes(2);
  await render(1);
  expect(load).toHaveBeenCalledTimes(2);
  load.mockRejectedValue(new Error("Try again"));
  await render(2);
  expect(container.textContent).toBe("LiveTry again");
});

it("holds a hidden custom source's refresh until the chat is shown", async () => {
  load.mockResolvedValue({ items: [{ id: "deploy", label: "Live" }] });
  await render(0, false);
  await render(1, false);
  expect(load).not.toHaveBeenCalled();
  await render(1);
  expect(container.textContent).toBe("Live");
  expect(load).toHaveBeenCalledTimes(1);
});
