/**
 * The one-time rewrite of a layout written before ADR 0234, when a section
 * chose a `type` and Work drew it with a component of its own. Works on the
 * evaluated data only; returns null for a layout already in today's shape.
 * Delete once layouts from before 2026-10 no longer need to load.
 */

/** Sections whose screens were removed with the right sidebar's content. */
const REMOVED = new Set(["session", "activity", "subsessions", "git", "prs"]);
/** The tab strip placed in the sidebar became a list of work:tabs. */
const TABS = "tabs";
const LISTS = new Set(["workflows", "apps", "chats", "files", "remote"]);
/** Header buttons the built-in components drew, as header actions. */
const HEADER_ACTIONS: Record<string, unknown[]> = {
  workflows: [
    {
      label: "Create workflow",
      action: "open",
      icon: "Plus",
      url: "command:new-workflow",
    },
  ],
  chats: [
    {
      label: "New chat",
      action: "open",
      icon: "Plus",
      url: "command:new-floating-chat",
    },
  ],
  files: [
    {
      label: "Find files",
      action: "open",
      icon: "Search",
      url: "command:search-files",
    },
  ],
  remote: [
    { label: "Download updates", action: "sync", icon: "Download" },
    { label: "Upload all", action: "upload-all", icon: "Upload" },
  ],
  bookmarks: [
    {
      label: "Add bookmark",
      action: "add",
      icon: "Plus",
      input: {
        title: "Add bookmark",
        submit: "Add",
        fields: [
          { name: "url", label: "Address", placeholder: "https://" },
          { name: "label", label: "Name" },
        ],
      },
    },
    {
      label: "New bookmark folder",
      action: "new-folder",
      icon: "FolderPlus",
      input: {
        title: "New folder",
        submit: "Create",
        fields: [{ name: "label", label: "Name" }],
      },
    },
  ],
};
/** Built-ins that hid while empty unless a layout said otherwise. */
const HIDE_EMPTY = new Set(["workflows", "apps", "remote"]);

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Work's verbs a menu could name that are now commands or source actions. */
function upgradeEntries(raw: unknown): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.map((entry) => {
    if (!isRecord(entry) || typeof entry.action !== "string") return entry;
    if (entry.action.startsWith("run:"))
      return { ...entry, action: entry.action.slice("run:".length) };
    if (entry.action === "new-chat")
      return { ...entry, action: "open", url: "command:new-floating-chat" };
    if (entry.action === "new-workflow")
      return { ...entry, action: "open", url: "command:new-workflow" };
    return entry;
  });
}

function upgradePresentation(
  record: Record<string, unknown>,
): Record<string, unknown> {
  const next = { ...record };
  for (const key of ["menu", "contextMenu", "actions", "headerActions"])
    if (key in next) next[key] = upgradeEntries(next[key]);
  // Rows' own presentation names actions too.
  if (isRecord(next.itemDefaults))
    next.itemDefaults = upgradePresentation(next.itemDefaults);
  if (isRecord(next.itemOverrides))
    next.itemOverrides = Object.fromEntries(
      Object.entries(next.itemOverrides).map(([id, value]) => [
        id,
        isRecord(value) ? upgradePresentation(value) : value,
      ]),
    );
  return next;
}

/** A list section that named a built-in, or a custom one over a source. */
function listName(section: Record<string, unknown>): string | null {
  if (section.type !== "custom") return String(section.type);
  const source = section.source;
  if (!isRecord(source) || typeof source.type !== "string") return null;
  if (source.type === "custom") return null;
  // A chats list scoped to the chat in front listed its children.
  if (
    (source.type === "chats" || source.type === "subsessions") &&
    (source.scope === "children" || source.scope === "session")
  )
    return "subsessions";
  return source.type;
}

function upgradeSection(
  raw: unknown,
  taken: Set<string>,
): Record<string, unknown>[] {
  if (!isRecord(raw) || !("type" in raw)) return isRecord(raw) ? [raw] : [];
  const { type, source, path, app, items, collections, ...base } =
    upgradePresentation(raw);
  if (type === "app")
    return [{ ...base, app, ...(collections ? { collections } : {}) }];
  if (type === "note")
    return [{ ...base, note: typeof path === "string" ? path : true }];
  if (type === "custom") {
    if (isRecord(source) && source.type === "custom" && source.module)
      return [
        {
          ...base,
          source: source.module,
          ...(collections ? { collections } : {}),
        },
      ];
    if (!isRecord(source)) return [{ ...base, items: items ?? [] }];
  }
  const name = listName(raw);
  if (!name) return [];
  // A layout's own list over a built-in source keeps its rows; a built-in
  // section whose screen went away goes with it.
  if (type !== "custom" && REMOVED.has(name)) return [];
  // The built-in Tabs section showed tabs only while they were placed in
  // the sidebar; a layout's own tabs list showed them always.
  if (name === TABS)
    return [
      {
        ...(type !== "custom"
          ? {
              headerActions: [
                {
                  label: "New tab",
                  action: "open",
                  icon: "Plus",
                  url: "command:new-tab",
                },
              ],
            }
          : {}),
        ...base,
        source: "work:tabs",
        ...(type !== "custom"
          ? {
              when: {
                ...(isRecord(base.when) ? base.when : {}),
                tabPlacement: "sidebar",
              },
            }
          : {}),
      },
    ];
  // Lists of the chat in front run only beside a chat.
  if (name === "subsessions" || name === "session")
    return [
      {
        ...base,
        source: `work:${name}`,
        when: { ...(isRecord(base.when) ? base.when : {}), session: true },
      },
    ];
  if (name === "bookmarks") {
    const unique = (id: string) => {
      let candidate = id;
      for (let index = 2; taken.has(candidate); index += 1)
        candidate = `${id}-${index}`;
      taken.add(candidate);
      return candidate;
    };
    return [
      {
        id: unique("pinned"),
        source: "work:pinned",
        title: "",
        presentation: "tiles",
        hideEmpty: true,
        empty: "Drop a tab here to pin it across projects",
        ...(base.when ? { when: base.when } : {}),
      },
      {
        id: unique("library"),
        source: "work:library",
        title: "",
        hideEmpty: true,
        ...(base.when ? { when: base.when } : {}),
      },
      {
        headerActions: HEADER_ACTIONS.bookmarks,
        ...base,
        source: "work:bookmarks",
      },
    ];
  }
  if (!LISTS.has(name) && !REMOVED.has(name)) return [];
  return [
    {
      ...(HEADER_ACTIONS[name] && type !== "custom"
        ? { headerActions: HEADER_ACTIONS[name] }
        : {}),
      ...(HIDE_EMPTY.has(name) && type !== "custom" ? { hideEmpty: true } : {}),
      ...base,
      source: `work:${name}`,
    },
  ];
}

function upgradeTabs(raw: unknown, taken: Set<string>): unknown {
  if (!Array.isArray(raw)) return raw;
  return raw.flatMap((tab) => {
    if (!isRecord(tab) || !Array.isArray(tab.sections)) return [tab];
    const sections = tab.sections.flatMap((section) =>
      upgradeSection(section, taken),
    );
    return sections.length ? [{ ...tab, sections }] : [];
  });
}

function sectionIds(sidebars: Record<string, unknown>): Set<string> {
  const ids = new Set<string>();
  for (const side of [sidebars.left, sidebars.right])
    if (Array.isArray(side))
      for (const tab of side)
        if (isRecord(tab) && Array.isArray(tab.sections))
          for (const section of tab.sections)
            if (isRecord(section) && typeof section.id === "string")
              ids.add(section.id);
  return ids;
}

function needsUpgrade(raw: Record<string, unknown>): boolean {
  const sidebars = isRecord(raw.sidebars) ? raw.sidebars : {};
  const sections = [sidebars.left, sidebars.right].flatMap((side) =>
    Array.isArray(side)
      ? side.flatMap((tab) =>
          isRecord(tab) && Array.isArray(tab.sections) ? tab.sections : [],
        )
      : [],
  );
  const modes =
    isRecord(raw.palette) && Array.isArray(raw.palette.modes)
      ? raw.palette.modes
      : [];
  return (
    sections.some((section) => isRecord(section) && "type" in section) ||
    modes.some((mode) => isRecord(mode) && isRecord(mode.source))
  );
}

export function upgradeWorkspaceLayout(raw: unknown): unknown | null {
  if (!isRecord(raw) || !isRecord(raw.sidebars) || !needsUpgrade(raw))
    return null;
  const taken = sectionIds(raw.sidebars);
  const sidebars = {
    ...raw.sidebars,
    left: upgradeTabs(raw.sidebars.left, taken),
    right: upgradeTabs(raw.sidebars.right, taken),
  };
  const kept = sectionIds(sidebars);
  const modes =
    isRecord(raw.palette) && Array.isArray(raw.palette.modes)
      ? raw.palette.modes.flatMap((mode) => {
          if (!isRecord(mode)) return [];
          if (typeof mode.section === "string" && !kept.has(mode.section))
            return [];
          const source = mode.source;
          if (!isRecord(source)) return [mode];
          // Lists of the chat in front: the palette has no chat.
          if (
            source.scope === "children" ||
            source.scope === "session" ||
            source.type === "subsessions"
          )
            return [];
          const { source: _source, ...rest } = mode;
          return [
            {
              ...rest,
              source:
                source.type === "custom"
                  ? source.module
                  : `work:${String(source.type)}`,
            },
          ];
        })
      : undefined;
  return {
    ...raw,
    sidebars,
    ...(isRecord(raw.palette)
      ? { palette: { ...raw.palette, modes: modes ?? [] } }
      : {}),
  };
}
