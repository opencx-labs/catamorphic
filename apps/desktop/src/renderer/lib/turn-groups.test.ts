import type { Item } from "@catamorphic/react";
import { describe, expect, it } from "vitest";
import {
  command,
  input,
  reply,
  timelineOf,
  turn,
} from "../components/catamorphic/timeline-fixtures.js";
import {
  DEFAULT_WORK_DISPLAY,
  foldsSteps,
  type TurnRow,
  turnRows,
} from "./turn-groups.js";

const items: Item[] = [
  input("t1", "Go"),
  command("c1", "t1"),
  reply("n1", "t1", "First note"),
  command("c2", "t1"),
  reply("n2", "t1", "Second note"),
  command("c3", "t1"),
  reply("a", "t1", "Answer"),
];

const group = (extra: Item[] = []) => {
  const [only] = timelineOf({
    turns: [turn("t1", 1)],
    items: [...items, ...extra],
  });
  if (!only) throw new Error("No turn");
  return only;
};

/** Each row as its kind, and a reply as its id with its steps. */
const shape = (rows: TurnRow[]) =>
  rows.map((row) =>
    row.kind === "reply"
      ? `${row.item.id}[${row.steps.map((step) => step.item.id).join(",")}]${row.answer ? "!" : ""}`
      : row.kind === "steps"
        ? `steps[${row.steps.map((step) => step.item.id).join(",")}]`
        : row.entry.kind,
  );

describe("turnRows", () => {
  it("folds the notes under the answer once the turn has settled", () => {
    expect(
      shape(turnRows(group(), { live: false, display: DEFAULT_WORK_DISPLAY })),
    ).toEqual(["input", "a[c1,n1,c2,n2,c3]!"]);
  });

  it("keeps every note in place when asked to", () => {
    expect(
      shape(
        turnRows(group(), {
          live: false,
          display: { live: "all", settled: "keep" },
        }),
      ),
    ).toEqual(["input", "n1[c1]", "n2[c2]", "a[c3]!"]);
  });

  it("shows every note while the turn runs by default, none of them the answer", () => {
    expect(
      shape(turnRows(group(), { live: true, display: DEFAULT_WORK_DISPLAY })),
    ).toEqual(["input", "n1[c1]", "n2[c2]", "a[c3]"]);
  });

  it("shows only the latest note while the turn runs, when asked to", () => {
    expect(
      shape(
        turnRows(group(), {
          live: true,
          display: { live: "latest", settled: "keep" },
        }),
      ),
    ).toEqual(["input", "a[c1,n1,c2,n2,c3]"]);
  });

  it("keeps every note in place while the turn runs with Notes only, folding their steps", () => {
    const display = { live: "notes", settled: "collapse" } as const;
    expect(shape(turnRows(group(), { live: true, display }))).toEqual([
      "input",
      "n1[c1]",
      "n2[c2]",
      "a[c3]",
    ]);
    // Once answered, the settled choice decides, as with any live choice.
    expect(shape(turnRows(group(), { live: false, display }))).toEqual([
      "input",
      "a[c1,n1,c2,n2,c3]!",
    ]);
    expect(foldsSteps(display)).toBe(true);
    expect(foldsSteps(DEFAULT_WORK_DISPLAY)).toBe(false);
    expect(foldsSteps({ live: "latest", settled: "collapse" })).toBe(false);
  });

  it("keeps the work since the latest note last, never folded", () => {
    expect(
      shape(
        turnRows(group([command("c4", "t1")]), {
          live: true,
          display: { live: "latest", settled: "collapse" },
        }),
      ),
    ).toEqual(["input", "a[c1,n1,c2,n2,c3]", "steps[c4]"]);
  });

  it("never folds notes across a message steered in between", () => {
    const steered = input("t1", "Also this", { id: "steer" });
    expect(
      shape(
        turnRows(
          group([steered, command("c5", "t1"), reply("b", "t1", "Done")]),
          {
            live: false,
            display: DEFAULT_WORK_DISPLAY,
          },
        ),
      ),
    ).toEqual(["input", "a[c1,n1,c2,n2,c3]", "input", "b[c5]!"]);
  });

  it("leaves a single-reply turn alone", () => {
    const [only] = timelineOf({
      turns: [turn("t1", 1)],
      items: [input("t1", "Hi"), reply("a", "t1", "Hello")],
    });
    if (!only) throw new Error("No turn");
    expect(
      shape(turnRows(only, { live: false, display: DEFAULT_WORK_DISPLAY })),
    ).toEqual(["input", "a[]!"]);
  });
});
