// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { CLOSING_MS, useClosingItems } from "../lib/closing-items.js";
import { ClosingCollapsible } from "./closing-collapsible.js";

let node: HTMLDivElement;
let root: Root;
beforeEach(() => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  vi.useFakeTimers({
    toFake: [
      "setTimeout",
      "clearTimeout",
      "requestAnimationFrame",
      "cancelAnimationFrame",
    ],
  });
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
  vi.useRealTimers();
});

function Panels({ ids }: { ids: string[] }) {
  const shown = useClosingItems(ids.map((id) => ({ id })));
  return (
    <>
      {shown.map(({ item, present }) => (
        <ClosingCollapsible key={item.id} open={present}>
          <button type="button" data-panel={item.id}>
            Submit {item.id}
          </button>
        </ClosingCollapsible>
      ))}
    </>
  );
}

const panel = (id: string) => node.querySelector(`[data-panel="${id}"]`);
const box = (id: string) => panel(id)?.closest("[data-collapsible]");

it("keeps a panel that left until it closed, inert at once and closing two frames on", () => {
  act(() => root.render(<Panels ids={["q1", "q2"]} />));
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("open");

  act(() => root.render(<Panels ids={["q2"]} />));
  // Still there, as it was, and nothing in it answers a second press.
  expect(panel("q1")).not.toBeNull();
  expect(panel("q1")?.closest("[inert]")).not.toBeNull();
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("open");
  // Its close starts two frames on, clear of the frame that removed it.
  act(() => vi.advanceTimersToNextFrame());
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("open");
  act(() => vi.advanceTimersToNextFrame());
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("closed");
  // Gone once it closed; the other never moved.
  act(() => vi.advanceTimersByTime(CLOSING_MS));
  expect(panel("q1")).toBeNull();
  expect(panel("q2")?.closest("[inert]")).toBeNull();
});

it("opens a panel that comes back while it closes, in its place", () => {
  act(() => root.render(<Panels ids={["q1", "q2"]} />));
  act(() => root.render(<Panels ids={["q2"]} />));
  act(() => vi.advanceTimersByTime(100));
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("closed");
  // An answer refused: the question asks again.
  act(() => root.render(<Panels ids={["q1", "q2"]} />));
  expect(box("q1")?.getAttribute("data-collapsible")).toBe("open");
  expect(panel("q1")?.closest("[inert]")).toBeNull();
  act(() => vi.advanceTimersByTime(CLOSING_MS * 2));
  expect(
    [...node.querySelectorAll("[data-panel]")].map((element) =>
      element.getAttribute("data-panel"),
    ),
  ).toEqual(["q1", "q2"]);
});
