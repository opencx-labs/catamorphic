import type { SourceRange, WorkflowNode } from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import { findNodeAtPosition } from "./find-node-at-position.js";

function range({
  start,
  end,
  startLine,
  startColumn,
  endLine,
  endColumn,
}: SourceRange): SourceRange {
  return { start, end, startLine, startColumn, endLine, endColumn };
}

function node(
  partial: Pick<WorkflowNode, "id" | "type" | "sourceRange"> &
    Partial<WorkflowNode>,
): WorkflowNode {
  return { label: partial.id, metadata: {}, ...partial };
}

// Layout mirrors real parser output: the trigger spans the whole function,
// an if-block wraps two steps, and a third step sits after the block.
const trigger = node({
  id: "trigger",
  type: "trigger",
  sourceRange: range({
    start: 0,
    end: 500,
    startLine: 1,
    startColumn: 1,
    endLine: 30,
    endColumn: 2,
  }),
});
const ifBlock = node({
  id: "if-1",
  type: "if-block",
  sourceRange: range({
    start: 100,
    end: 300,
    startLine: 5,
    startColumn: 3,
    endLine: 15,
    endColumn: 4,
  }),
});
const stepInsideIf = node({
  id: "step-1",
  type: "step",
  sourceRange: range({
    start: 150,
    end: 200,
    startLine: 7,
    startColumn: 5,
    endLine: 8,
    endColumn: 20,
  }),
});
const stepAfterIf = node({
  id: "step-2",
  type: "step",
  sourceRange: range({
    start: 320,
    end: 380,
    startLine: 18,
    startColumn: 3,
    endLine: 19,
    endColumn: 10,
  }),
});

const nodes = [trigger, ifBlock, stepInsideIf, stepAfterIf];

describe("findNodeAtPosition", () => {
  it("returns the step whose range contains the cursor", () => {
    const found = findNodeAtPosition({
      nodes,
      position: { line: 7, column: 10 },
    });
    expect(found?.id).toBe("step-1");
  });

  it("prefers the smallest non-container node over enclosing containers", () => {
    // Line 18 is inside the trigger only via the whole-function span.
    const found = findNodeAtPosition({
      nodes,
      position: { line: 18, column: 5 },
    });
    expect(found?.id).toBe("step-2");
  });

  it("falls back to the smallest container on structural lines", () => {
    // Line 5 is the `if (...)` line: inside if-block and trigger, no step.
    const found = findNodeAtPosition({
      nodes,
      position: { line: 5, column: 10 },
    });
    expect(found?.id).toBe("if-1");
  });

  it("respects column boundaries on the first and last line of a range", () => {
    const before = findNodeAtPosition({
      nodes,
      position: { line: 7, column: 4 },
    });
    expect(before?.id).toBe("if-1");

    const after = findNodeAtPosition({
      nodes,
      position: { line: 8, column: 21 },
    });
    expect(after?.id).toBe("if-1");
  });

  it("returns null when the position is outside every node", () => {
    const found = findNodeAtPosition({
      nodes,
      position: { line: 40, column: 1 },
    });
    expect(found).toBeNull();
  });

  it("prefers durable transition leaves over their boundary", () => {
    const boundary = node({
      id: "boundary",
      type: "durable-boundary",
      sourceRange: range({
        start: 500,
        end: 800,
        startLine: 31,
        startColumn: 1,
        endLine: 45,
        endColumn: 3,
      }),
    });
    const pause = node({
      id: "pause",
      type: "pause",
      sourceRange: range({
        start: 650,
        end: 690,
        startLine: 38,
        startColumn: 12,
        endLine: 38,
        endColumn: 52,
      }),
    });

    expect(
      findNodeAtPosition({
        nodes: [boundary, pause],
        position: { line: 38, column: 20 },
      })?.id,
    ).toBe("pause");
    expect(
      findNodeAtPosition({
        nodes: [boundary, pause],
        position: { line: 31, column: 5 },
      })?.id,
    ).toBe("boundary");
  });
});
