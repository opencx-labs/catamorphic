import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { CodexItems } from "../items.js";

describe("Codex streamed messages", () => {
  it("withdraws replaced drafts within their own thread and retains completed replies", () => {
    const events: HarnessEvent[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
    });
    items.itemStarted({ type: "agentMessage", id: "first" });
    items.agentDelta("first", "An abandoned fragment");
    items.itemStarted({ type: "agentMessage", id: "child" }, "spawn");
    items.agentDelta("child", "Child still working");
    items.itemCompleted({
      type: "agentMessage",
      id: "replacement",
      text: "Complete reply",
    });
    expect(events.filter((event) => event.type === "item.completed")).toEqual([
      {
        type: "item.completed",
        key: "first",
        status: "cancelled",
        item: { text: "" },
      },
      {
        type: "item.completed",
        key: "replacement",
        status: "completed",
        item: { text: "Complete reply" },
      },
    ]);
    items.itemCompleted(
      { type: "agentMessage", id: "child", text: "Child finished" },
      "spawn",
    );
    items.itemStarted({ type: "agentMessage", id: "dangling" });
    items.closeOpen("completed");
    expect(events.at(-1)).toEqual({
      type: "item.completed",
      key: "dangling",
      status: "cancelled",
    });
  });

  it.each(["failed", "interrupted"] as const)(
    "preserves partial text when a turn is %s",
    (status) => {
      const events: HarnessEvent[] = [];
      const items = new CodexItems({
        emit: (event) => events.push(event),
        serverName: (key) => key,
        hostToolServer: () => "workspace",
      });
      items.itemStarted({ type: "agentMessage", id: "partial" });
      items.agentDelta("partial", "Useful partial answer");
      items.closeOpen(status);
      expect(events.at(-1)).toEqual({
        type: "item.completed",
        key: "partial",
        status: status === "failed" ? "failed" : "cancelled",
      });
    },
  );
});

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
    // A subagent's reasoning is its own.
    items.itemStarted({ id: "r2", type: "reasoning" }, "spawn-1");
    items.reasoningDelta("r2", "**Scanning the child tests**", 0);
    items.itemStarted({ id: "m1", type: "agentMessage" });
    items.itemStarted({ id: "c2", type: "commandExecution", command: "ls" });
    expect(events.filter((event) => event.type === "status")).toEqual([
      { type: "status", text: "Inspecting the parser" },
      { type: "status", text: "Scanning the child tests" },
    ]);
    expect(
      events.flatMap((event) =>
        event.type === "item.started" ? [[event.key, event.activity]] : [],
      ),
    ).toEqual([
      ["r1", undefined],
      ["c1", "Inspecting the parser"],
      ["r2", undefined],
      ["m1", undefined],
      ["c2", "Inspecting the parser"],
    ]);
  });
});
