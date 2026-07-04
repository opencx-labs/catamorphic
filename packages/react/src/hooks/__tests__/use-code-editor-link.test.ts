import type { WorkflowGraph, WorkflowNode } from "@catamorphic/parser";
import { act } from "@testing-library/react";
import { useSetAtom } from "jotai";
import { describe, expect, it } from "vitest";
import { graphAtom, selectedNodeIdAtom } from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import { useCodeEditorLink } from "../use-code-editor-link.js";

function makeNode(
  id: string,
  type: WorkflowNode["type"],
  lines: { startLine: number; endLine: number; start: number; end: number },
): WorkflowNode {
  return {
    id,
    type,
    label: id,
    metadata: {},
    sourceRange: {
      start: lines.start,
      end: lines.end,
      startLine: lines.startLine,
      startColumn: 1,
      endLine: lines.endLine,
      endColumn: 80,
    },
  };
}

const stepA = makeNode("step-a", "step", {
  startLine: 3,
  endLine: 4,
  start: 30,
  end: 80,
});
const stepB = makeNode("step-b", "step", {
  startLine: 6,
  endLine: 7,
  start: 100,
  end: 150,
});

const graph: WorkflowGraph = {
  name: "wf",
  trigger: { parameters: [] },
  nodes: [stepA, stepB],
  edges: [],
  sourceCode: "",
};

function setup() {
  return renderHookWithProviders(() => {
    const link = useCodeEditorLink();
    const setGraph = useSetAtom(graphAtom);
    const setSelectedNodeId = useSetAtom(selectedNodeIdAtom);
    return { link, setGraph, setSelectedNodeId };
  });
}

describe("useCodeEditorLink", () => {
  it("emits a reveal when selection changes from outside the editor", () => {
    const { result } = setup();
    act(() => result.current.setGraph(graph));

    act(() => result.current.setSelectedNodeId("step-a"));

    expect(result.current.link.reveal?.range).toEqual(stepA.sourceRange);
    expect(result.current.link.selectedNode?.id).toBe("step-a");
  });

  it("re-reveals with a new key when the same selection is set again elsewhere", () => {
    const { result } = setup();
    act(() => result.current.setGraph(graph));

    act(() => result.current.setSelectedNodeId("step-a"));
    const firstKey = result.current.link.reveal?.key;

    act(() => result.current.setSelectedNodeId("step-b"));
    act(() => result.current.setSelectedNodeId("step-a"));

    expect(result.current.link.reveal?.key).not.toBe(firstKey);
    expect(result.current.link.reveal?.range).toEqual(stepA.sourceRange);
  });

  it("selects the node under the cursor without echoing a reveal", () => {
    const { result } = setup();
    act(() => result.current.setGraph(graph));

    act(() => {
      result.current.link.handleCursorPositionChange({ line: 6, column: 5 });
    });

    expect(result.current.link.selectedNode?.id).toBe("step-b");
    expect(result.current.link.reveal).toBeNull();
  });

  it("ignores cursor moves that land on the already-selected node", () => {
    const { result } = setup();
    act(() => result.current.setGraph(graph));

    act(() => result.current.setSelectedNodeId("step-a"));
    const revealAfterSelect = result.current.link.reveal;

    act(() => {
      result.current.link.handleCursorPositionChange({ line: 3, column: 5 });
    });

    expect(result.current.link.reveal).toBe(revealAfterSelect);
    expect(result.current.link.selectedNode?.id).toBe("step-a");
  });

  it("clears the reveal when selection is cleared", () => {
    const { result } = setup();
    act(() => result.current.setGraph(graph));

    act(() => result.current.setSelectedNodeId("step-a"));
    act(() => result.current.setSelectedNodeId(null));

    expect(result.current.link.reveal).toBeNull();
    expect(result.current.link.selectedNode).toBeNull();
  });
});
