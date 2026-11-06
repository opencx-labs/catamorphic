import { describe, expect, it } from "vitest";
import {
  BUBBLE_DRAG_SLOP,
  type BubblePress,
  type BubblePressEvent,
  bubblePress,
} from "./bubble-press.js";

/** Runs events from idle: the press it ends in and every effect asked. */
const run = (events: BubblePressEvent[]) =>
  events.reduce<{ press: BubblePress; effects: unknown[] }>(
    (done, event) => {
      const next = bubblePress(done.press, event);
      return { press: next.press, effects: [...done.effects, ...next.effects] };
    },
    { press: { kind: "idle" }, effects: [] },
  );

describe("bubblePress", () => {
  it("is a tap let go before it is still long enough: voice gets it whole", () => {
    expect(
      run([
        { kind: "down", x: 100, at: 10 },
        { kind: "up", x: 101 },
      ]),
    ).toEqual({
      press: { kind: "idle" },
      effects: [{ kind: "press", at: 10 }, { kind: "release" }],
    });
  });

  it("is a hold once still, pressed as of when the pointer went down", () => {
    expect(
      run([
        { kind: "down", x: 100, at: 10 },
        { kind: "move", x: 100 + BUBBLE_DRAG_SLOP - 1 },
        { kind: "still" },
        // Held, the pointer may wander: the person is talking.
        { kind: "move", x: 300 },
        { kind: "up", x: 300 },
      ]),
    ).toEqual({
      press: { kind: "idle" },
      effects: [{ kind: "press", at: 10 }, { kind: "release" }],
    });
  });

  it("is a drag once it moves while waiting, and never reaches voice", () => {
    expect(
      run([
        { kind: "down", x: 100, at: 10 },
        { kind: "move", x: 100 - BUBBLE_DRAG_SLOP },
        { kind: "still" },
        { kind: "move", x: 40 },
        { kind: "up", x: 30 },
      ]),
    ).toEqual({
      press: { kind: "idle" },
      effects: [
        { kind: "drag", phase: "start", screenX: 100 },
        { kind: "drag", phase: "move", screenX: 95 },
        { kind: "drag", phase: "move", screenX: 40 },
        { kind: "drag", phase: "end", screenX: 30 },
      ],
    });
  });

  it("calls a drag off when the pointer is lost, and lets a hold go", () => {
    expect(
      run([
        { kind: "down", x: 0, at: 0 },
        { kind: "move", x: 20 },
        { kind: "cancel" },
      ]).effects.at(-1),
    ).toEqual({ kind: "drag", phase: "cancel", screenX: 0 });
    expect(
      run([
        { kind: "down", x: 0, at: 0 },
        { kind: "still" },
        { kind: "cancel" },
      ]).effects,
    ).toEqual([{ kind: "press", at: 0 }, { kind: "release" }]);
    // Lost before it was anything: nothing happened.
    expect(run([{ kind: "down", x: 0, at: 0 }, { kind: "cancel" }])).toEqual({
      press: { kind: "idle" },
      effects: [],
    });
  });

  it("ignores a second pointer going down mid-press", () => {
    const { press } = run([
      { kind: "down", x: 0, at: 0 },
      { kind: "still" },
      { kind: "down", x: 50, at: 5 },
    ]);
    expect(press).toEqual({ kind: "held" });
  });
});
