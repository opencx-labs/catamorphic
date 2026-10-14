import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { CodexItems } from "../items.js";

describe("Codex's reasoning title", () => {
  // Codex's own UI keeps its latest reasoning title on its status line
  // through the commands that follow; Work's line fell back to a verb at
  // the first command.
  it("holds the live line through the work that follows, not its messages", () => {
    const events: HarnessEvent[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
    });
    items.itemStarted({ id: "r1", type: "reasoning" });
    items.reasoningDelta("r1", "**Inspecting the parser**\n\nIt walks", 0);
    items.itemCompleted({
      id: "r1",
      type: "reasoning",
      summary: ["**Inspecting the parser**\n\nIt walks the AST."],
    });
    items.itemStarted({ id: "c1", type: "commandExecution", command: "rg x" });
    items.itemStarted({ id: "m1", type: "agentMessage" });
    items.itemStarted({ id: "c2", type: "commandExecution", command: "ls" });
    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", text: "Inspecting the parser" },
    ]);
    expect(
      events.flatMap((event) =>
        event.type === "item.started" ? [[event.key, event.activity]] : [],
      ),
    ).toEqual([
      ["r1", undefined],
      ["c1", "Inspecting the parser"],
      ["m1", undefined],
      ["c2", "Inspecting the parser"],
    ]);
  });
});
