import {
  applySessionEvents,
  sessionStateFromSnapshot,
} from "@catamorphic/agent-protocol";
import { describe, expect, it } from "vitest";
import {
  notice,
  question,
  reply,
  requestItem,
  snapshot,
  taskNotification,
  toolCall,
  turn,
  userMessage,
} from "../test/session-fixtures.js";
import {
  answerRows,
  QUESTIONS_DISMISSED_MESSAGE,
  sessionQueue,
  sessionTimeline,
  shareTimeline,
} from "./session-timeline.js";

describe("sessionTimeline", () => {
  it("reads a turn as its input, its work, and its answer", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1)],
        items: [
          userMessage("t1:input", 1, "t1", "Build it"),
          toolCall("c1", 2, "t1", "Read"),
          reply("n1", 3, "t1", "Reading first"),
          toolCall("c2", 4, "t1", "Edit"),
          reply("a1", 5, "t1", "Done"),
        ],
      }),
    );
    const [only] = sessionTimeline(state);
    expect(
      only?.entries.map((entry) =>
        entry.kind === "reply"
          ? `${entry.item.text}<${entry.steps.map((step) => step.id).join(",")}>`
          : entry.kind,
      ),
    ).toEqual(["input", "Reading first<c1>", "Done<c2>"]);
  });

  it("puts a turn's input first even when it was queued during the turn before", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [
          turn("t1", 1),
          turn("t2", 2, { startedAt: "2026-10-01T10:00:30.000Z" }),
        ],
        items: [
          userMessage("t1:input", 1, "t1", "First"),
          userMessage("t2:input", 2, "t2", "Second, sent while the first ran"),
          reply("a1", 3, "t1", "First answer"),
          reply("a2", 4, "t2", "Second answer"),
        ],
      }),
    );
    expect(
      sessionTimeline(state).map((group) =>
        group.entries.map((entry) =>
          entry.kind === "input" || entry.kind === "reply"
            ? entry.item.text
            : entry.kind,
        ),
      ),
    ).toEqual([
      ["First", "First answer"],
      ["Second, sent while the first ran", "Second answer"],
    ]);
  });

  it("reads what a turn took in before its input, then the input, then what reached it while it worked", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1)],
        items: [
          // Waited for a turn, and rode this one (ADR 0240).
          taskNotification("n1", 1, "t1", "Unit tests finished"),
          userMessage("t1:input", 2, "t1", "Chips use the same file?"),
          toolCall("c1", 3, "t1", "Read"),
          userMessage("s1", 4, "t1", "Also check the docs", {
            dispatch: "steer",
          }),
          reply("a1", 5, "t1", "Yes, and the docs too"),
        ],
      }),
    );
    expect(
      sessionTimeline(state)[0]?.entries.map((entry) =>
        entry.kind === "input" || entry.kind === "reply"
          ? entry.item.text
          : entry.kind,
      ),
    ).toEqual([
      "notifications",
      "Chips use the same file?",
      "steps",
      "Also check the docs",
      "Yes, and the docs too",
    ]);
  });

  it("leaves queued and withdrawn turns to the queue", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [
          turn("t1", 1, { status: "running" }),
          turn("t2", 2, { status: "queued" }),
          turn("t3", 3, { status: "cancelled" }),
        ],
        items: [
          userMessage("t1:input", 1, "t1", "Running"),
          userMessage("t2:input", 2, "t2", "Waiting"),
          userMessage("t3:input", 3, "t3", "Withdrawn"),
        ],
      }),
    );
    expect(sessionTimeline(state).map((group) => group.key)).toEqual(["t1"]);
    expect(sessionQueue(state).map((queued) => queued.item?.text)).toEqual([
      "Waiting",
    ]);
  });

  it("places a notice between the turns it came between", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1), turn("t2", 2)],
        items: [
          userMessage("t1:input", 1, "t1", "One"),
          notice("n", 15, "agent_changed", "Agent changed"),
          userMessage("t2:input", 22, "t2", "Two"),
        ],
      }),
    );
    expect(sessionTimeline(state).map((group) => group.key)).toEqual([
      "t1",
      "n",
      "t2",
    ]);
  });

  it("reads an answered question as each question with what was picked", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1)],
        items: [
          userMessage("t1:input", 1, "t1", "Make a page"),
          requestItem("x", 2, "t1", "q1"),
          reply("a1", 3, "t1", "Using Grid"),
        ],
        requests: [
          question("q1", {
            status: "resolved",
            response: { kind: "question", answers: ["Grid"] },
          }),
        ],
      }),
    );
    const entries = sessionTimeline(state)[0]?.entries ?? [];
    expect(entries.map((entry) => entry.kind)).toEqual([
      "input",
      "answer",
      "reply",
    ]);
    const answer = entries[1];
    expect(answer?.kind === "answer" ? answerRows(answer) : null).toEqual([
      { question: "Which layout?", answer: "Grid" },
    ]);
  });

  it("reads a later answer message once, at the message", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1)],
        items: [
          userMessage("t1:input", 1, "t1", "Start"),
          requestItem("x", 2, "t1", "q1"),
          userMessage("ans", 4, "t1", "Which layout?\n\nUser answer:\nList", {
            answer: {
              requestId: "q1",
              questions: [
                {
                  question: "Which layout?",
                  header: "Layout",
                  multiSelect: false,
                  options: [],
                },
              ],
              answers: [QUESTIONS_DISMISSED_MESSAGE],
            },
          }),
        ],
        requests: [
          question("q1", {
            blocking: false,
            status: "resolved",
            response: {
              kind: "question",
              answers: [QUESTIONS_DISMISSED_MESSAGE],
            },
          }),
        ],
      }),
    );
    const entries = sessionTimeline(state)[0]?.entries ?? [];
    expect(entries.map((entry) => entry.kind)).toEqual([
      "input",
      "steps",
      "answer",
    ]);
    const answer = entries[2];
    expect(answer?.kind === "answer" && answer.dismissed).toBe(true);
  });
});

describe("shareTimeline", () => {
  it("keeps every turn a streamed delta did not touch, and itself when nothing changed", () => {
    const state = sessionStateFromSnapshot(
      snapshot({
        sequence: 10,
        turns: [turn("t1", 1), turn("t2", 2)],
        items: [
          userMessage("t1:input", 1, "t1", "First"),
          reply("a1", 2, "t1", "First answer"),
          userMessage("t2:input", 3, "t2", "Second"),
          reply("a2", 4, "t2", "Second ans"),
        ],
      }),
    );
    const before = shareTimeline(undefined, sessionTimeline(state));
    expect(shareTimeline(before, sessionTimeline(state))).toBe(before);
    const streamed = applySessionEvents(state, [
      {
        sessionId: state.session.id,
        sequence: 11,
        at: "2026-10-01T10:01:00.000Z",
        commandId: null,
        event: {
          type: "item.text_appended",
          itemId: "a2",
          field: "text",
          text: "wer",
          at: "2026-10-01T10:01:00.000Z",
        },
      },
    ]);
    const after = shareTimeline(before, sessionTimeline(streamed));
    expect(after).not.toBe(before);
    expect(after[0]).toBe(before[0]);
    expect(after[1]).not.toBe(before[1]);
    expect(
      after[1]?.entries.flatMap((entry) =>
        entry.kind === "reply" ? [entry.item.text] : [],
      ),
    ).toEqual(["Second answer"]);
  });
});
