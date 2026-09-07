import type { WorkflowNode } from "@catamorphic/parser";
import { act } from "@testing-library/react";
import { useAtomValue, useSetAtom } from "jotai";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  codeAtom,
  graphAtom,
  graphParseStateAtom,
  selectedNodeIdAtom,
} from "../../atoms.js";
import { renderHookWithProviders } from "../../test/render.js";
import type { ParseResult } from "../use-workflow-graph.js";
import { useWorkflowGraph } from "../use-workflow-graph.js";

function resultFor(label: string, nodes?: WorkflowNode[]): ParseResult {
  return {
    graph: {
      name: label,
      capabilities: { batchProcessing: false, cancellation: false },
      input: { parameters: [] },
      triggers: [],
      canSuspend: false,
      nodes: nodes ?? [],
      edges: [],
      sourceCode: label,
    },
    layoutedNodes: [],
    layoutedEdges: [],
  };
}
function deferred<T>() {
  let resolve: (value: T) => void = () => {};
  const promise = new Promise<T>((accept) => {
    resolve = accept;
  });
  return { promise, resolve };
}
function setup(onParse: (code: string) => Promise<ParseResult | null>) {
  return renderHookWithProviders(() => ({
    ...useWorkflowGraph({ onParse }),
    setCode: useSetAtom(codeAtom),
    graph: useAtomValue(graphAtom),
    status: useAtomValue(graphParseStateAtom),
    select: useSetAtom(selectedNodeIdAtom),
    selected: useAtomValue(selectedNodeIdAtom),
  }));
}
afterEach(() => vi.useRealTimers());

describe("workflow preview revisions", () => {
  it("ignores a slow response after a newer edit, even during debounce", async () => {
    vi.useFakeTimers();
    const first = deferred<ParseResult>();
    const onParse = vi
      .fn()
      .mockReturnValueOnce(first.promise)
      .mockResolvedValue(resultFor("latest"));
    const { result } = setup(onParse);
    act(() => result.current.setCode("first"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => result.current.setCode("latest"));
    await act(async () => {
      first.resolve(resultFor("stale"));
    });
    expect(result.current.graph).toBeNull();
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.graph?.name).toBe("latest");
    expect(result.current.status.status).toBe("ready");
  });

  it("keeps the last valid graph and exposes failures, including an empty draft", async () => {
    vi.useFakeTimers();
    const onParse = vi
      .fn()
      .mockResolvedValueOnce(resultFor("good"))
      .mockRejectedValue(new Error("Missing workflow definition"));
    const { result } = setup(onParse);
    act(() => result.current.setCode("good"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => result.current.setCode("broken"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.graph?.name).toBe("good");
    expect(result.current.status).toEqual({
      status: "error",
      error: "Missing workflow definition",
    });
    act(() => result.current.setCode(""));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.graph?.name).toBe("good");
    expect(result.current.status.status).toBe("error");
  });

  it("keeps the selected logical step when insertion renumbers parser ids", async () => {
    vi.useFakeTimers();
    const node = (id: string, functionName: string): WorkflowNode => ({
      id,
      functionName,
      type: "step",
      label: functionName,
      metadata: {},
      sourceRange: {
        start: 0,
        end: 1,
        startLine: 1,
        endLine: 1,
        startColumn: 1,
        endColumn: 2,
      },
    });
    const onParse = vi
      .fn()
      .mockResolvedValueOnce(resultFor("first", [node("node_1", "sendEmail")]))
      .mockResolvedValueOnce(
        resultFor("next", [
          node("node_1", "validate"),
          node("node_2", "sendEmail"),
        ]),
      );
    const { result } = setup(onParse);
    act(() => result.current.setCode("first"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    act(() => result.current.select("node_1"));
    act(() => result.current.setCode("next"));
    await act(async () => {
      await vi.advanceTimersByTimeAsync(300);
    });
    expect(result.current.selected).toBe("node_2");
  });
});
