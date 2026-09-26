import { describe, expect, it } from "vitest";
import { dropHiddenSubtrees } from "./sidebar-hidden.js";

describe("dropHiddenSubtrees", () => {
  const items = [
    { id: ".work", parentId: null },
    { id: ".work/apps", parentId: ".work" },
    { id: ".work/apps/work-log", parentId: ".work/apps" },
    { id: "Launch plan.md", parentId: null },
  ];

  it("hides a folder's whole subtree, not just its row", () => {
    const shown = dropHiddenSubtrees(items, (item) => item.id === ".work");
    expect(shown.map((item) => item.id)).toEqual(["Launch plan.md"]);
  });

  it("keeps everything when nothing is hidden", () => {
    expect(dropHiddenSubtrees(items, () => false)).toEqual(items);
  });
});
