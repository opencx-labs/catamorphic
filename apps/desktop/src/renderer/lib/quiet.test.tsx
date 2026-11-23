// @vitest-environment jsdom
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, expect, it } from "vitest";
import { quiet } from "./quiet.js";

Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);

let root: Root;
let node: HTMLDivElement;
beforeEach(() => {
  node = document.createElement("div");
  document.body.append(node);
  root = createRoot(node);
});
afterEach(() => {
  act(() => root.unmount());
  node.remove();
});

it("renders for what it is given, never for a rebuilt handler, and runs the latest", () => {
  let renders = 0;
  function Dialog({
    open,
    onClose,
    onExtra,
  }: {
    open: boolean;
    onClose: () => void;
    onExtra?: () => void;
  }) {
    renders += 1;
    return (
      <button
        type="button"
        data-open={open}
        data-extra={Boolean(onExtra)}
        onClick={() => {
          onClose();
          onExtra?.();
        }}
      />
    );
  }
  const Quiet = quiet(Dialog);
  const said: string[] = [];
  const render = (open: boolean, word: string, extra = false) =>
    act(() =>
      root.render(
        <Quiet
          open={open}
          onClose={() => said.push(word)}
          onExtra={extra ? () => said.push(`extra ${word}`) : undefined}
        />,
      ),
    );
  render(false, "one");
  render(false, "two");
  expect(renders).toBe(1);
  act(() => node.querySelector("button")?.click());
  expect(said).toEqual(["two"]);
  render(true, "three");
  expect(renders).toBe(2);
  expect(node.querySelector("button")?.dataset.open).toBe("true");
  // A handler that arrives is something new it is given.
  render(true, "four", true);
  expect(renders).toBe(3);
  expect(node.querySelector("button")?.dataset.extra).toBe("true");
  act(() => node.querySelector("button")?.click());
  expect(said).toEqual(["two", "four", "extra four"]);
  render(true, "five");
  expect(node.querySelector("button")?.dataset.extra).toBe("false");
});
