import { describe, expect, it } from "vitest";
import { groupTurns, type TimelineItem } from "./turn-groups.js";

const user = (id: string) => ({ id, role: "user" });
const note = (id: string, status = "completed") => ({
  id,
  role: "assistant",
  metadata: { status },
});
const shape = (items: TimelineItem<{ id: string }>[]) =>
  items.map((item) =>
    item.kind === "message"
      ? item.message.id
      : `${item.folded.map((m) => m.id).join("+")}>${item.shown.map((m) => m.id).join("+")}${item.working ? "*" : ""}`,
  );

const log = [user("u1"), note("a1"), note("a2"), note("a3")];

describe("groupTurns", () => {
  it("keeps every note in place by default, running or settled", () => {
    for (const working of [true, false])
      expect(
        shape(
          groupTurns(log, {
            working,
            display: { live: "all", settled: "keep" },
          }),
        ),
      ).toEqual(["u1", "a1", "a2", "a3"]);
  });

  it("folds the notes under the answer once the turn has settled", () => {
    const display = { live: "all", settled: "collapse" } as const;
    expect(shape(groupTurns(log, { working: false, display }))).toEqual([
      "u1",
      "a1+a2>a3",
    ]);
    // Still running: nothing folds yet.
    expect(shape(groupTurns(log, { working: true, display }))).toEqual([
      "u1",
      "a1",
      "a2",
      "a3",
    ]);
  });

  it("shows only the latest note while the turn runs", () => {
    const display = { live: "latest", settled: "collapse" } as const;
    expect(shape(groupTurns(log, { working: true, display }))).toEqual([
      "u1",
      "a1+a2>a3*",
    ]);
  });

  it("only treats the run at the end of the log as running", () => {
    const display = { live: "latest", settled: "keep" } as const;
    expect(
      shape(
        groupTurns([...log, user("u2"), note("b1"), note("b2")], {
          working: true,
          display,
        }),
      ),
    ).toEqual(["u1", "a1", "a2", "a3", "u2", "b1>b2*"]);
  });

  it("keeps a failure and the note before it in place", () => {
    expect(
      shape(
        groupTurns([user("u1"), note("a1"), note("a2"), note("a3", "failed")], {
          working: false,
          display: { live: "all", settled: "collapse" },
        }),
      ),
    ).toEqual(["u1", "a1>a2+a3"]);
  });

  it("leaves a single-message turn alone", () => {
    expect(
      shape(
        groupTurns([user("u1"), note("a1")], {
          working: false,
          display: { live: "latest", settled: "collapse" },
        }),
      ),
    ).toEqual(["u1", "a1"]);
  });
});
