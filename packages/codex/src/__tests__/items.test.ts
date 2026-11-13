import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import { describe, expect, it } from "vitest";
import { CodexItems } from "../items.js";

describe("Codex native async questions", () => {
  it("projects structured questions once, without duplicating their generated prose", () => {
    const events: HarnessEvent[] = [];
    const asked: unknown[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
      questions: (key, questions) => asked.push({ key, questions }),
    });
    const question = {
      type: "agentMessage",
      id: "native-question",
      delivery: "async",
      text: "Which theme? Orange or Blue?",
      questions: [
        { title: "Which theme?", options: ["Orange", "Blue"] },
        { title: "Anything else?", options: null },
      ],
    };
    items.itemStarted(question);
    items.itemCompleted(question);
    items.itemCompleted(question);
    expect(asked).toEqual([
      {
        key: 'question:[null,"native-question"]',
        questions: [
          {
            question: "Which theme?",
            header: "Question",
            multiSelect: false,
            options: [
              { label: "Orange", description: "" },
              { label: "Blue", description: "" },
            ],
          },
          {
            question: "Anything else?",
            header: "Question",
            multiSelect: false,
            options: [],
          },
        ],
      },
    ]);
    expect(events).toEqual([]);
    expect(items.workStarted).toBe(true);
    // Private child threads may reuse a native item id.
    items.itemCompleted(question, "child");
    expect(asked).toHaveLength(2);
    expect(asked[1]).toMatchObject({
      key: 'question:["child","native-question"]',
    });
  });

  it("withdraws text streamed before the question metadata arrives", () => {
    const events: HarnessEvent[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
      questions: () => {},
    });
    items.itemStarted({ type: "agentMessage", id: "question" });
    items.agentDelta("question", "Which theme?");
    items.itemCompleted({
      type: "agentMessage",
      id: "question",
      text: "Which theme?",
      delivery: "async",
      questions: [{ title: "Which theme?" }],
    });
    expect(events.at(-1)).toEqual({
      type: "item.completed",
      key: "question",
      status: "cancelled",
      item: { text: "" },
    });
  });

  it("keeps an independent reply when questions arrive or are replayed", () => {
    const events: HarnessEvent[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
      questions: () => {},
    });
    items.itemStarted({ type: "agentMessage", id: "reply" });
    const question = {
      type: "agentMessage",
      id: "reply",
      delivery: "async",
      questions: [{ title: "Anything else?" }],
    };
    items.itemStarted(question, "child");
    items.itemCompleted(question, "child");
    items.itemCompleted(question, "child");
    items.agentDelta("reply", "Useful independent work");
    expect(events.at(-1)).toMatchObject({
      type: "item.delta",
      key: "reply",
      text: "Useful independent work",
    });
    expect(events.some((event) => event.type === "item.completed")).toBe(false);
  });

  it.each([
    { delivery: "async", questions: [] },
    { delivery: "async", questions: [{ title: "" }] },
    { delivery: "async", questions: [{ title: "Theme?", options: [42] }] },
    { delivery: null, questions: [{ title: "Theme?" }] },
  ])("preserves ordinary text for unsupported metadata: %j", (metadata) => {
    const events: HarnessEvent[] = [];
    const asked: unknown[] = [];
    const items = new CodexItems({
      emit: (event) => events.push(event),
      serverName: (key) => key,
      hostToolServer: () => "workspace",
      questions: (...question) => asked.push(question),
    });
    items.itemCompleted({
      type: "agentMessage",
      id: "message",
      text: "Readable message",
      ...metadata,
    });
    expect(asked).toEqual([]);
    expect(events.at(-1)).toMatchObject({
      type: "item.completed",
      status: "completed",
      item: { text: "Readable message" },
    });
  });
});

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
