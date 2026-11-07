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

it("keeps rich inspector facts and actions without granting HTML or code execution", () => {
  const row = sanitizeSidebarSourceItem({
    id: "t",
    label: "Task",
    preview: {
      metadata: [
        {
          label: "Reminder time",
          value: "Tomorrow at 14:00 (Asia/Amman)",
          copy: "2027-02-05T11:00:00Z",
          tone: "warning",
          display: "color",
          color: "#ff8833",
          actions: [{ action: "reschedule", label: "Reschedule" }],
        },
      ],
      content: { markdown: "## Notes\n\n- A\n- B" },
      actions: [{ action: "copy-title", label: "Copy title" }],
    },
  });
  expect(row.preview).toMatchObject({
    metadata: [
      {
        label: "Reminder time",
        tone: "warning",
        display: "color",
        color: "#ff8833",
        copy: "2027-02-05T11:00:00Z",
      },
    ],
    content: { markdown: expect.stringContaining("Notes") },
    actions: [{ action: "copy-title" }],
  });
  expect(
    sanitizeSidebarSourceItem({
      id: "t",
      label: "Task",
      preview: { content: { html: "<script>bad()</script>" } },
    }).preview,
  ).toBeUndefined();
  expect(
    sanitizeSidebarSourceItem(
      {
        id: "t",
        label: "Task",
        preview: { content: { app: "details", height: 9999 } },
      },
      new Set(),
      { apps: true },
    ).preview,
  ).toMatchObject({ content: { app: "details", height: 480 } });
});

it("confines inspector actions and requires the existing apps-list grant before mounting app content", () => {
  const bad = {
    action: "open",
    label: "Not allowed",
    url: "command:archive-chat",
  };
  const row = sanitizeSidebarSourceItem({
    id: "t",
    label: "Task",
    preview: {
      actions: [bad],
      metadata: [{ label: "State", value: "Ready", actions: [bad] }],
    },
  });
  expect(row.preview).toMatchObject({
    actions: [],
    metadata: [{ actions: [] }],
  });
  expect(() =>
    sanitizeSidebarSourceItem({
      id: "t",
      label: "Task",
      preview: { content: { app: "details" } },
    }),
  ).toThrow("catamorphic.access.lists");
});
