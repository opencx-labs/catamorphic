import type {
  SidebarSourceEffect,
  SidebarSourceItem,
  SidebarSourceModule,
  WorkspaceConfig,
} from "../src/index.js";

export const source = {
  async load({ session, surface }) {
    return {
      items: [
        {
          id: "todo",
          label: session?.title ?? surface?.kind ?? "Tasks",
          description: "Tomorrow",
          descriptionVisibility: "hover",
          contextualIndicator: "icon",
        },
      ],
    };
  },
  async action({ action, mode }) {
    if (action === "open") return { open: "file:todo.md", mode };
  },
} satisfies SidebarSourceModule;

export const layout = {
  sidebars: {
    left: [
      {
        id: "tasks",
        title: "Tasks",
        sections: [
          {
            id: "tasks",
            source: "./tasks.ts",
            itemDefaults: { contextMenu: [] },
          },
        ],
      },
    ],
    right: [],
  },
} satisfies WorkspaceConfig;

export const badRow: SidebarSourceItem = {
  id: "bad",
  label: "Bad",
  // @ts-expect-error Description visibility is a closed documented choice.
  descriptionVisibility: "on-hover",
};
export const badEffect: SidebarSourceEffect = {
  open: "file:todo.md",
  // @ts-expect-error Effects use the same opening modes as source actions.
  mode: "new-window",
};
export const badLayout: WorkspaceConfig = {
  sidebars: {
    left: [
      {
        id: "tasks",
        title: "Tasks",
        sections: [
          {
            id: "tasks",
            // @ts-expect-error Row presentation belongs in itemDefaults or itemOverrides.
            contextMenu: [],
          },
        ],
      },
    ],
    right: [],
  },
};

export const form = {
  fields: [
    {
      name: "reminders",
      label: "Reminders",
      type: "repeat",
      fields: [
        {
          name: "preset",
          label: "When",
          type: "select",
          options: [{ label: "One week", value: "week" }],
        },
        {
          name: "after",
          label: "After",
          type: "number",
          min: 1,
          when: { field: "preset", equals: "custom" },
        },
        { name: "at", label: "At", type: "datetime" },
      ],
    },
  ],
} satisfies import("../src/index.js").SidebarActionInput;
export const inspector: import("../src/index.js").SidebarPreview = {
  metadata: [
    {
      label: "Status",
      value: "Ready",
      tone: "success",
      display: "badge",
      copy: "Ready",
    },
  ],
  content: { app: "details", data: { id: "one" } },
  actions: [{ action: "copy-title", label: "Copy title" }],
};
export const copied: SidebarSourceEffect = { copy: "Full title" };
