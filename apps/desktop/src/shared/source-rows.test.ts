import { describe, expect, it } from "vitest";
import {
  sanitizePresentation,
  sanitizeSidebarSourceItem,
} from "./source-rows.js";

describe("sidebar presentation contract", () => {
  it("retains independent secondary text, current-context and menu choices", () => {
    const row = sanitizeSidebarSourceItem({
      id: "task",
      label: "Review the proposal",
      description: "Tomorrow",
      descriptionVisibility: "hover",
      contextualIndicator: "icon",
      menu: [{ label: "Rename", action: "rename" }],
      contextMenu: [],
      actions: [{ label: "Complete", action: "complete", icon: "Check" }],
    });
    expect(row).toMatchObject({
      descriptionVisibility: "hover",
      contextualIndicator: "icon",
      contextMenu: [],
    });
    expect(row.menu?.[0]?.action).toBe("rename");
    expect(row.actions?.[0]?.action).toBe("complete");
  });
  it("ignores unrecognized presentation choices", () => {
    expect(
      sanitizePresentation({
        descriptionVisibility: "sometimes",
        contextualIndicator: "selected",
      }),
    ).toEqual({});
  });
});
