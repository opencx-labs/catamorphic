// @vitest-environment jsdom

import { act, useRef } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { useListMotion } from "./list-motion";

function MotionList({ ids }: { ids: string[] }) {
  const ref = useRef<HTMLDivElement>(null);
  useListMotion(ref, ids, { enterOnFirstPass: true });
  return (
    <div ref={ref}>
      {ids.map((id) => (
        <div key={id} data-item-id={id}>
          {id}
        </div>
      ))}
    </div>
  );
}

describe("useListMotion", () => {
  let container: HTMLDivElement;
  let root: Root;
  const requestFrame = vi.fn(() => 1);

  beforeEach(() => {
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", true);
    vi.stubGlobal("requestAnimationFrame", requestFrame);
    vi.stubGlobal("cancelAnimationFrame", vi.fn());
    vi.stubGlobal("matchMedia", vi.fn().mockReturnValue({ matches: true }));
    vi.stubGlobal(
      "DOMMatrixReadOnly",
      class {
        readonly m42 = 0;
      },
    );
    container = document.createElement("div");
    document.body.append(container);
    root = createRoot(container);
  });

  afterEach(() => {
    act(() => root.unmount());
    container.remove();
    vi.unstubAllGlobals();
    vi.clearAllMocks();
    Reflect.set(globalThis, "IS_REACT_ACT_ENVIRONMENT", false);
  });

  it("keeps filtering static when reduced motion is requested", () => {
    act(() => root.render(<MotionList ids={["one", "two"]} />));
    act(() => root.render(<MotionList ids={["two"]} />));

    const row = container.querySelector<HTMLElement>("[data-item-id=two]");
    expect(requestFrame).not.toHaveBeenCalled();
    expect(row?.style.transition).toBe("");
    expect(row?.style.transform).toBe("");
    expect(row?.style.opacity).toBe("");
  });
});
