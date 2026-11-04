// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { useClosingItems } from "./closing-items.js";

let root: Root;
let box: HTMLDivElement;
let playing = false;
function Rows({ items }: { items: { id: string; label: string }[] }) {
  return useClosingItems(items, 400, () => playing).map(({ item, present }) => (
    <span key={item.id} inert={!present}>
      {item.label}
    </span>
  ));
}
const show = (items: { id: string; label: string }[]) =>
  act(async () => root.render(<Rows items={items} />));
const advance = (ms: number) => act(async () => vi.advanceTimersByTime(ms));
beforeEach(() => {
  vi.useFakeTimers();
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  box = document.createElement("div");
  document.body.append(box);
  root = createRoot(box);
  playing = false;
});
afterEach(() => {
  act(() => root.unmount());
  box.remove();
  vi.useRealTimers();
  Reflect.deleteProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT");
});
it("keeps a removed watch through a late exit, then releases it", async () => {
  await show([{ id: "watch", label: "Waiting for checks" }]);
  const row = box.firstElementChild;
  playing = true;
  await show([]);
  await advance(700);
  expect(row?.isConnected).toBe(true);
  expect(row?.hasAttribute("inert")).toBe(true);
  expect(row?.textContent).toBe("Waiting for checks");
  playing = false;
  await advance(50);
  expect(row?.isConnected).toBe(false);
});
it("reverses a removal without losing the watch's node or latest content", async () => {
  await show([{ id: "watch", label: "Waiting for checks" }]);
  const row = box.firstElementChild;
  playing = true;
  await show([]);
  await advance(500);
  await show([{ id: "watch", label: "Waiting for deployment" }]);
  playing = false;
  await advance(1_000);
  expect(box.firstElementChild).toBe(row);
  expect(row?.textContent).toBe("Waiting for deployment");
  expect(row?.hasAttribute("inert")).toBe(false);
});
