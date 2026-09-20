import { describe, expect, it } from "vitest";
import { dropHiddenSubtrees } from "./sidebar-hidden.js";

describe("dropHiddenSubtrees", () => {
  const items = [
    { id: ".catamorphic", parentId: null },
    { id: ".catamorphic/apps", parentId: ".catamorphic" },
    { id: ".catamorphic/apps/work-log", parentId: ".catamorphic/apps" },
    { id: "Launch plan.md", parentId: null },
  ];

  it("hides a folder's whole subtree, not just its row", () => {
    const shown = dropHiddenSubtrees(
      items,
      (item) => item.id === ".catamorphic",
    );
    expect(shown.map((item) => item.id)).toEqual(["Launch plan.md"]);
  });

  it("keeps everything when nothing is hidden", () => {
    expect(dropHiddenSubtrees(items, () => false)).toEqual(items);
  });
});
