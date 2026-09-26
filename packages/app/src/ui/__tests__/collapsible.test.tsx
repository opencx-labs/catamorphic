// @vitest-environment jsdom
import { act } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";
import { Collapsible } from "../collapsible.js";

it("keeps closed content mounted but inert and tweens its measured height", async () => {
  Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
  const node = document.createElement("div");
  const root = createRoot(node);
  await act(async () =>
    root.render(
      <Collapsible open={false}>
        <button type="button">inside</button>
      </Collapsible>,
    ),
  );
  const box = node.querySelector(".cat-collapsible") as HTMLElement;
  expect(box.dataset.state).toBe("closed");
  expect(box.hasAttribute("inert")).toBe(true);
  expect(node.querySelector("button")).not.toBeNull();
  await act(async () =>
    root.render(
      <Collapsible open>
        <button type="button">inside</button>
      </Collapsible>,
    ),
  );
  expect(box.dataset.state).toBe("open");
  expect(box.hasAttribute("inert")).toBe(false);
  // Geometry is inline so hosts without the kit sheet share the motion.
  expect(box.style.overflow).toBe("hidden");
  expect(box.style.transitionProperty).toBe("height, opacity");
  await act(async () => root.unmount());
});
