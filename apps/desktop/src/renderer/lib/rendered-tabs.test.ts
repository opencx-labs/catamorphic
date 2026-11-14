import { describe, expect, it } from "vitest";
import { mergeRendered } from "./rendered-tabs.js";
import type { WorkspaceTab } from "./workspace-types.js";

const tab = (name: string, pinned?: boolean): WorkspaceTab => ({
  kind: "run",
  name,
  pinned,
});
const rows = (rendered: ReturnType<typeof mergeRendered>) =>
  rendered.map(
    (entry) =>
      `${entry.id.replace("\u0000pin", "~")}${entry.tab.pinned ? "*" : ""}${entry.exiting ? "(out)" : ""}`,
  );

describe("mergeRendered", () => {
  it("keeps a closed tab where it stood while it leaves", () => {
    const shown = mergeRendered([], [tab("a"), tab("b"), tab("c")]);
    expect(rows(mergeRendered(shown, [tab("a"), tab("c")]))).toEqual([
      "run:a",
      "run:b(out)",
      "run:c",
    ]);
  });

  it("a pinned tab leaves its place as a copy and arrives as a pin", () => {
    const shown = mergeRendered([], [tab("a", true), tab("b"), tab("c")]);
    const widths = new Map([["run:c", 120]]);
    const next = mergeRendered(
      shown,
      [tab("a", true), tab("c", true), tab("b")],
      (id) => widths.get(id),
    );
    expect(rows(next)).toEqual(["run:a*", "run:c*", "run:b", "run:c~(out)"]);
    expect(next.find((entry) => entry.exiting)?.width).toBe(120);
  });

  it("pinned where it stood, the pin leads its leaving copy", () => {
    const shown = mergeRendered([], [tab("a"), tab("b")]);
    expect(rows(mergeRendered(shown, [tab("a", true), tab("b")]))).toEqual([
      "run:a*",
      "run:a~(out)",
      "run:b",
    ]);
  });

  it("an unpinned tab leaves the pins and arrives in full", () => {
    const shown = mergeRendered([], [tab("a", true), tab("b")]);
    expect(rows(mergeRendered(shown, [tab("a"), tab("b")]))).toEqual([
      "run:a~*(out)",
      "run:a",
      "run:b",
    ]);
  });

  it("pinning again replaces the copy still leaving", () => {
    const shown = mergeRendered([], [tab("a"), tab("b")]);
    const pinned = mergeRendered(shown, [tab("a", true), tab("b")]);
    const unpinned = mergeRendered(pinned, [tab("a"), tab("b")]);
    expect(rows(unpinned)).toEqual(["run:a~*(out)", "run:a", "run:b"]);
  });
});
