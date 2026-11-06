import { describe, expect, it } from "vitest";
import { currentWait } from "./chat-activity.js";

type Item = Parameters<typeof currentWait>[0] extends infer S
  ? S extends { items: readonly (infer I)[] }
    ? I
    : never
  : never;

const call = (
  id: string,
  tool: string,
  input: Record<string, string | number>,
  status: "in_progress" | "completed" = "in_progress",
  turnId = "t1",
): Item =>
  ({
    id,
    sessionId: "s",
    turnId,
    attemptId: null,
    parentItemId: null,
    position: 1,
    status,
    nativeRef: null,
    createdAt: "2026-10-21T00:00:00.000Z",
    updatedAt: "2026-10-21T00:00:00.000Z",
    startedAt: null,
    endedAt: null,
    kind: "tool_call",
    tool,
    server: null,
    description: null,
    input,
    result: null,
    error: null,
  }) satisfies Item;

const state = (...items: Item[]) => ({ items });

describe("currentWait", () => {
  it("names what a turn whose only running step waits is waiting on", () => {
    expect(
      currentWait(
        state(call("a", "mcp__workspace__wait_for_subsessions", {})),
        "t1",
      ),
    ).toBe("subagent");
    expect(
      currentWait(
        state(
          call("b", "mcp__workspace__read_background_output", {
            id: "watch-1",
            wait_seconds: 600,
          }),
        ),
        "t1",
      ),
    ).toBe("watch");
    expect(
      currentWait(
        state(
          call("c", "read_background_output", { id: "abc", wait_for: "ready" }),
        ),
        "t1",
      ),
    ).toBe("command");
  });

  it("is working while anything else runs, or a read does not wait", () => {
    expect(
      currentWait(
        state(
          call("a", "mcp__workspace__wait_for_subsessions", {}),
          call("b", "Bash", { command: "bun test" }),
        ),
        "t1",
      ),
    ).toBeNull();
    expect(
      currentWait(
        state(call("c", "read_background_output", { id: "abc" })),
        "t1",
      ),
    ).toBeNull();
    // Between steps nothing runs: the agent is thinking.
    expect(
      currentWait(
        state(call("d", "wait_for_subsessions", {}, "completed")),
        "t1",
      ),
    ).toBeNull();
    // Another turn's step says nothing about this one.
    expect(
      currentWait(
        state(call("e", "wait_for_subsessions", {}, "in_progress", "t0")),
        "t1",
      ),
    ).toBeNull();
    expect(currentWait(null, "t1")).toBeNull();
  });
});
