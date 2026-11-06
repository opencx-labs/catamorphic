import type { Item } from "@catamorphic/react";
import { describe, expect, it } from "vitest";
import {
  command,
  input,
  notification,
  reply,
  timelineOf,
  turn,
} from "./timeline-fixtures.js";
import {
  createCompletedRowsProjector,
  DEFAULT_WORK_DISPLAY,
  foldsSteps,
  type TurnRow,
  turnRows,
} from "./turn-rows.js";

const collapseCompletedRows = createCompletedRowsProjector();

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
  it("folds read terminal updates, failures and notes together in order", () => {
    const [group] = timelineOf({
      turns: [turn("t1", 1)],
      items: [
        input("t1", "Fix it"),
        command("c1", "t1"),
        reply("n1", "t1", "Checking"),
        notification("failed", "t1", "Tests failed", {
          task: {
            type: "background_command",
            id: "cmd",
            title: "Test",
            status: "failed",
          },
        }),
        command("c2", "t1"),
        notification("passed", "t1", "Tests passed"),
        reply("final", "t1", "Fixed"),
      ],
    });
    if (!group) throw new Error("No turn");
    expect(
      shape(turnRows(group, { live: false, display: DEFAULT_WORK_DISPLAY })),
    ).toEqual(["input", "final[c1,n1,failed,c2,passed]!"]);
    expect(
      shape(
        turnRows(group, {
          live: false,
          display: { live: "all", settled: "keep" },
        }),
      ),
    ).toContain("notifications");
  });

  it.each([
    { status: "in_progress" },
    { attention: "required" },
    {
      task: {
        type: "subsession",
        id: "child",
        title: "Blocked review",
        status: "failed",
      },
    },
    {
      task: {
        type: "background_command",
        id: "cmd",
        title: "Input",
        status: "needs_input",
      },
    },
  ] satisfies Array<Partial<ReturnType<typeof notification>>>)(
    "keeps an actionable or unread update visible: %j",
    (overrides) => {
      const [group] = timelineOf({
        turns: [turn("t1", 1)],
        items: [
          input("t1", "Fix it"),
          reply("note", "t1", "Checking"),
          notification("alert", "t1", "Needs attention", overrides),
          reply("final", "t1", "Waiting"),
        ],
      });
      if (!group) throw new Error("No turn");
      expect(
        shape(turnRows(group, { live: false, display: DEFAULT_WORK_DISPLAY })),
      ).toEqual(["input", "note[]", "notifications", "final[]!"]);
    },
  );

  it("folds automatic completed continuations together while preserving person and turn identities", () => {
    const groups = timelineOf({
      turns: [turn("t1", 1), turn("t2", 2), turn("t3", 3)],
      items: [
        input("t1", "Fix it"),
        command("first", "t1"),
        reply("earlier", "t1", "Tests running"),
        notification("done", "t2", "Tests completed"),
        command("verify", "t2"),
        reply("final", "t2", "All fixed"),
        input("t3", "Next task"),
        reply("next", "t3", "Next answer"),
      ],
    });
    const views = groups.map((group) => ({
      group,
      rows: turnRows(group, { live: false, display: DEFAULT_WORK_DISPLAY }),
      live: false,
    }));
    const collapsed = collapseCompletedRows(views);
    const again = collapseCompletedRows([...views]);
    expect(again.every((view, index) => view === collapsed[index])).toBe(true);
    const changedLive = { ...views[2], live: true };
    if (!changedLive.group || !changedLive.rows)
      throw new Error("No last turn");
    const streaming = collapseCompletedRows([
      ...views.slice(0, 2),
      { group: changedLive.group, rows: changedLive.rows, live: true },
    ]);
    expect(streaming[0]).toBe(collapsed[0]);
    expect(streaming[1]).toBe(collapsed[1]);
    expect(collapsed.map((view) => shape(view.rows))).toEqual([
      ["input"],
      ["final[first,earlier,done,verify]!"],
      ["input", "next[]!"],
    ]);
    expect(collapsed.map((view) => view.group)).toEqual(groups);
    expect(views[0]?.rows).toHaveLength(2);
    expect(collapsed[2]).toBe(views[2]);
    const live = collapseCompletedRows(
      views.map((view, index) => ({ ...view, live: index === 1 })),
    );
    expect(shape(live[0]?.rows ?? [])).toEqual(["input", "earlier[first]!"]);
  });
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
