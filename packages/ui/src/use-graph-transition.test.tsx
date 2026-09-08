import type { WorkflowNode } from "@catamorphic/parser";
import { act, renderHook } from "@testing-library/react";
import type { Node } from "@xyflow/react";
import { afterEach, expect, it, vi } from "vitest";
import { useGraphTransition } from "./use-graph-transition.js";

const source = (id: string, name: string): WorkflowNode => ({
  id,
  type: "step",
  functionName: name,
  label: name,
  metadata: {},
  sourceRange: {
    start: 0,
    end: 10,
    startLine: 1,
    endLine: 1,
    startColumn: 1,
    endColumn: 11,
  },
});
const node = (id: string, y: number): Node => ({
  id,
  position: { x: 0, y },
  data: {},
  style: { width: 240, height: 44 },
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

it("animates matching steps from their old positions, retains exits, and settles", async () => {
  vi.useFakeTimers();
  vi.stubGlobal("matchMedia", () => ({
    matches: false,
    addEventListener() {},
    removeEventListener() {},
  }));
  const { result, rerender } = renderHook(
    (props) => useGraphTransition({ ...props, edges: [] }),
    {
      initialProps: {
        nodes: [node("a", 0), node("b", 100)],
        graphNodes: [source("a", "keep"), source("b", "remove")],
      },
    },
  );
  rerender({
    nodes: [node("new", 0), node("a2", 100)],
    graphNodes: [source("new", "insert"), source("a2", "keep")],
  });
  expect(result.current.transitioning).toBe(true);
  expect(
    result.current.nodes.find((item) => item.id === "a2")?.position.y,
  ).toBeCloseTo(0);
  expect(result.current.nodes.some((item) => item.id === "leaving:b")).toBe(
    true,
  );
  await act(async () => {
    await vi.advanceTimersByTimeAsync(100);
  });
  const y =
    result.current.nodes.find((item) => item.id === "a2")?.position.y ?? 0;
  expect(y).toBeGreaterThan(0);
  expect(y).toBeLessThan(100);
  await act(async () => {
    await vi.advanceTimersByTimeAsync(150);
  });
  expect(result.current.transitioning).toBe(false);
  expect(result.current.nodes.map((item) => item.id)).toEqual(["new", "a2"]);
  expect(result.current.nodes[1]?.position.y).toBe(100);
});

it("settles immediately for reduced motion", () => {
  vi.stubGlobal("matchMedia", () => ({
    matches: true,
    addEventListener() {},
    removeEventListener() {},
  }));
  const { result, rerender } = renderHook(
    (props) => useGraphTransition({ ...props, edges: [] }),
    {
      initialProps: {
        nodes: [node("a", 0)],
        graphNodes: [source("a", "keep")],
      },
    },
  );
  rerender({ nodes: [node("a", 100)], graphNodes: [source("a", "keep")] });
  expect(result.current.transitioning).toBe(false);
  expect(result.current.nodes[0]?.position.y).toBe(100);
});
