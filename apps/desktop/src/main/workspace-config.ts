import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { PROJECT_WORKSPACE_CONFIG_PATH } from "@catamorphic/workflow/project-layout";
import type { OpenMode } from "../shared/open-mode.js";
import {
  normalizePaletteTrigger,
  RESERVED_PALETTE_TRIGGERS,
} from "../shared/palette.js";
import { sanitizeProjectExperienceWhen } from "../shared/project-experience.js";
import {
  isHostAction,
  isWorkSourceName,
  rowTargetAllowed,
  SESSION_WORK_SOURCES,
  type SidebarActionInput,
  type SidebarBadge,
  type SidebarItem,
  type SidebarItemPresentation,
  type SidebarMenuEntry,
  type SidebarPreview,
  type SidebarPreviewMetadata,
  type SidebarSectionConfig,
  type SidebarSignal,
  type SidebarTabConfig,
  type SidebarWhen,
  SOURCE_ACTION_PATTERN,
  workSourceName,
} from "../shared/sidebar.js";
import type { SidebarSourceItem } from "../shared/sidebar-source.js";
import {
  type PaletteModeConfig,
  sidebarSections,
  type WorkspaceConfig,
} from "../shared/workspace-config.js";
import { WORKSPACE_AUTHORING_GUIDE } from "./workspace-authoring.js";
import { upgradeWorkspaceLayout } from "./workspace-config-upgrade.js";

/**
 * The user-customizable workspace (ADR 0186): both sidebars and the palette's
 * own modes. The config is a real JS file at
 * `<userData>/profiles/<id>/workspace.js` (same philosophy as keybindings.json:
 * plain, user-visible, agent-editable, file-watched, applies live). The file
 * evaluates in an isolated vm context with no require/process/fs and exports
 * { sidebars: { left, right }, palette? }: icon tabs holding ordered
 * sections, and palette modes over the same sources.
 *
 * Everything crossing into the renderer is DATA: the config is evaluated
 * in the main process and sent over IPC, so menu entries name an action
 * (Work's verb or the source's) rather than carrying a callback.
 */

export type { SidebarSectionConfig } from "../shared/sidebar.js";
export type { WorkspaceConfig } from "../shared/workspace-config.js";

/**
 * Work's own layout (ADR 0234): every section names a source, and its
 * buttons are ordinary header actions. The right sidebar starts empty.
 */
export const DEFAULT_WORKSPACE_CONFIG: WorkspaceConfig = {
  sidebars: {
    left: [
      {
        id: "project",
        title: "Project",
        icon: "House",
        sections: [
          {
            id: "pinned",
            source: "work:pinned",
            title: "",
            presentation: "tiles",
            hideEmpty: true,
            empty: "Drop a tab here to pin it across projects",
          },
          {
            id: "library",
            source: "work:library",
            title: "",
            hideEmpty: true,
          },
          {
            id: "bookmarks",
            source: "work:bookmarks",
            headerActions: [
              {
                label: "Add bookmark",
                action: "add",
                icon: "Plus",
                input: {
                  title: "Add bookmark",
                  submit: "Add",
                  fields: [
                    {
                      name: "url",
                      label: "Address",
                      placeholder: "https://",
                    },
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
          },
          {
            id: "workflows",
            source: "work:workflows",
            hideEmpty: true,
            headerActions: [
              {
                label: "Create workflow",
                action: "open",
                icon: "Plus",
                url: "command:new-workflow",
              },
            ],
          },
          { id: "apps", source: "work:apps", hideEmpty: true },
          // The window's tabs, chats among them, when the person places
          // tabs in the sidebar (Settings). A module wrapping work:tabs can
          // sort them (workspace-authoring.ts).
          {
            id: "tabs",
            source: "work:tabs",
            when: { tabPlacement: "sidebar" },
            headerActions: [
              {
                label: "New tab",
                action: "open",
                icon: "Plus",
                url: "command:new-tab",
              },
            ],
          },
          {
            id: "files",
            source: "work:files",
            collapsed: true,
            headerActions: [
              {
                label: "Find files",
                action: "open",
                icon: "Search",
                url: "command:search-files",
              },
            ],
          },
          {
            id: "remote",
            source: "work:remote",
            title: "Server",
            hideEmpty: true,
            headerActions: [
              { label: "Download updates", action: "sync", icon: "Download" },
              { label: "Upload all", action: "upload-all", icon: "Upload" },
            ],
          },
        ],
      },
    ],
    right: [],
  },
};

/** A workspace.js for a layout: the commented guide, then the data. */
export function workspaceFileFor(config: unknown): string {
  return `${WORKSPACE_AUTHORING_GUIDE.split("\n")
    .map((line) => `// ${line}`)
    .join("\n")}
module.exports = ${JSON.stringify(config, null, 2)};
`;
}

export const DEFAULT_WORKSPACE_FILE = workspaceFileFor(
  DEFAULT_WORKSPACE_CONFIG,
);

const asOpenMode = (value: unknown): OpenMode | undefined =>
  value === "tab" ||
  value === "replace" ||
  value === "side" ||
  value === "floating"
    ? value
    : undefined;

const FIELD_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,39}$/;

function sanitizeInput(raw: unknown): SidebarActionInput | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.fields))
    throw new Error("An action's input needs fields: [{ name, label }].");
  if (raw.fields.length < 1 || raw.fields.length > 4)
    throw new Error("An action asks for one to four values.");
  const names = new Set<string>();
  const fields = raw.fields.map((field) => {
    if (
      !isRecord(field) ||
      typeof field.name !== "string" ||
      !FIELD_NAME.test(field.name) ||
      names.has(field.name) ||
      typeof field.label !== "string" ||
      !field.label.trim()
    )
      throw new Error("Each input field needs a unique name and a label.");
    names.add(field.name);
    return {
      name: field.name,
      label: field.label,
      ...(typeof field.value === "string" ? { value: field.value } : {}),
      ...(typeof field.placeholder === "string"
        ? { placeholder: field.placeholder }
        : {}),
    };
  });
  return {
    ...(typeof raw.title === "string" ? { title: raw.title } : {}),
    ...(typeof raw.submit === "string" ? { submit: raw.submit } : {}),
    fields,
  };
}

function sanitizeMenu(raw: unknown): SidebarMenuEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("Actions must be an array.");
  // An explicit [] means "no menu button"; keep it distinct from absent.
  return raw.map((entry): SidebarMenuEntry => {
    if (
      !isRecord(entry) ||
      typeof entry.label !== "string" ||
      typeof entry.action !== "string"
    )
      throw new Error("Actions need label and action.");
    if (entry.action.startsWith("run:"))
      throw new Error(
        `Action "${entry.action}": name the source's action without run: (ADR 0234).`,
      );
    if (
      !isHostAction(entry.action) &&
      !SOURCE_ACTION_PATTERN.test(entry.action)
    )
      throw new Error(
        `Action "${entry.action}" is not one of Work's verbs (open, open-tab, open-here, open-side, open-floating, copy-url, refresh, search) or a source action (lowercase words joined by dashes).`,
      );
    const input = sanitizeInput(entry.input);
    return {
      label: entry.label,
      action: entry.action,
      ...(entry.danger === true ? { danger: true } : {}),
      ...(typeof entry.icon === "string" ? { icon: entry.icon } : {}),
      ...(typeof entry.url === "string" ? { url: entry.url } : {}),
      ...(typeof entry.disabledReason === "string"
        ? { disabledReason: entry.disabledReason }
        : {}),
      ...(input ? { input } : {}),
    };
  });
}

function sanitizePreview(raw: unknown): SidebarPreview | false | undefined {
  if (raw === false) return false;
  if (!isRecord(raw)) return undefined;
  const metadata = Array.isArray(raw.metadata)
    ? raw.metadata
        .flatMap((entry): SidebarPreviewMetadata[] =>
          isRecord(entry) &&
          typeof entry.label === "string" &&
          typeof entry.value === "string" &&
          entry.label.length > 0 &&
          entry.value.length > 0
            ? [{ label: entry.label, value: entry.value }]
            : [],
        )
        .slice(0, 6)
    : [];
  const title =
    typeof raw.title === "string" && raw.title.length > 0
      ? raw.title
      : undefined;
  const description =
    typeof raw.description === "string" && raw.description.length > 0
      ? raw.description
      : undefined;
  if (!title && !description && metadata.length === 0) return undefined;
  return {
    title,
    description,
    metadata: metadata.length > 0 ? metadata : undefined,
  };
}

function sanitizeBadges(raw: unknown): (string | SidebarBadge)[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw
    .flatMap((badge): (string | SidebarBadge)[] =>
      typeof badge === "string"
        ? [badge]
        : isRecord(badge) && typeof badge.label === "string"
          ? [
              {
                label: badge.label,
                ...(typeof badge.icon === "string" ? { icon: badge.icon } : {}),
              },
            ]
          : [],
    )
    .slice(0, 4);
}

const asSignal = (value: unknown): SidebarSignal | undefined =>
  value === "working" || value === "attention" || value === "unread"
    ? value
    : undefined;

function sanitizeSidebarWhen(value: unknown): SidebarWhen | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "permissions",
          "surface",
          "session",
          "pathPrefix",
          "selection",
          "tabPlacement",
        ].includes(key),
    )
  )
    return null;
  const authority = sanitizeProjectExperienceWhen({
    ...(value.permissions !== undefined
      ? { permissions: value.permissions }
      : {}),
  });
  if (authority === null) return null;
  if (
    value.surface !== undefined &&
    (!Array.isArray(value.surface) ||
      value.surface.some((kind) => typeof kind !== "string" || !kind))
  )
    return null;
  if (value.session !== undefined && typeof value.session !== "boolean")
    return null;
  if (value.selection !== undefined && typeof value.selection !== "boolean")
    return null;
  if (value.pathPrefix !== undefined && typeof value.pathPrefix !== "string")
    return null;
  if (
    value.tabPlacement !== undefined &&
    value.tabPlacement !== "top" &&
    value.tabPlacement !== "sidebar"
  )
    return null;
  return {
    ...authority,
    surface: Array.isArray(value.surface)
      ? value.surface.filter((kind): kind is string => typeof kind === "string")
      : undefined,
    session: typeof value.session === "boolean" ? value.session : undefined,
    selection:
      typeof value.selection === "boolean" ? value.selection : undefined,
    pathPrefix:
      typeof value.pathPrefix === "string" ? value.pathPrefix : undefined,
    tabPlacement:
      value.tabPlacement === "top" || value.tabPlacement === "sidebar"
        ? value.tabPlacement
        : undefined,
  };
}

function sanitizePresentation(
  record: Record<string, unknown>,
): SidebarItemPresentation {
  const presentation: SidebarItemPresentation = {
    label: typeof record.label === "string" ? record.label : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
    keywords: Array.isArray(record.keywords)
      ? record.keywords
          .filter((word): word is string => typeof word === "string")
          .slice(0, 32)
      : undefined,
    icon: typeof record.icon === "string" ? record.icon : undefined,
    badges: sanitizeBadges(record.badges),
    progress:
      typeof record.progress === "number" && Number.isFinite(record.progress)
        ? Math.max(0, Math.min(1, record.progress))
        : undefined,
    signal: asSignal(record.signal),
    open: asOpenMode(record.open),
    menu: sanitizeMenu(record.menu),
    contextMenu: sanitizeMenu(record.contextMenu),
    actions: sanitizeMenu(record.actions),
    preview: sanitizePreview(record.preview),
    hide: typeof record.hide === "boolean" ? record.hide : undefined,
  };
  return Object.fromEntries(
    Object.entries(presentation).filter(([, value]) => value !== undefined),
  );
}

function sanitizeItems(
  raw: unknown,
  depth = 0,
  ids = new Set<string>(),
  parentId = "",
): SidebarItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  if (depth > 20) throw new Error("Item trees cannot exceed 20 levels.");
  return raw.flatMap((entry): SidebarItem[] => {
    if (!isRecord(entry)) return [];
    const when = sanitizeSidebarWhen(entry.when);
    if (when === null) return [];
    const url = typeof entry.url === "string" ? entry.url : undefined;
    const id =
      typeof entry.id === "string"
        ? entry.id
        : `${parentId}/${url ?? entry.label ?? "Folder"}`;
    if (!id || ids.has(id))
      throw new Error("Items need unique stable IDs within their section.");
    ids.add(id);
    const items = sanitizeItems(entry.items, depth + 1, ids, id);
    if (!url && (!items || items.length === 0) && !Array.isArray(entry.actions))
      return [];
    return [
      {
        ...sanitizePresentation(entry),
        id,
        label:
          typeof entry.label === "string" && entry.label
            ? entry.label
            : (url ?? "Folder"),
        url,
        items,
        collapsed: entry.collapsed === true,
        when,
      },
    ];
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stableId(value: unknown): value is string {
  return (
    typeof value === "string" && /^[a-zA-Z0-9][a-zA-Z0-9_-]{0,79}$/.test(value)
  );
}

const WORKFLOW_NAME = /^[a-zA-Z_$][a-zA-Z0-9_$-]{0,99}$/;

/** `work:<name>`, or a module path; nothing else is a source. */
function sanitizeSourceName(value: unknown, where: string): string {
  if (typeof value !== "string" || !value.trim())
    throw new Error(`${where}: source is "work:<name>" or a module path.`);
  if (value.startsWith("work:")) {
    if (!workSourceName(value))
      throw new Error(
        `${where}: ${value} is not one of Work's lists (work:${["pinned", "bookmarks", "library", "workflows", "apps", "chats", "subsessions", "activity", "files", "tabs", "remote", "git", "prs", "session"].join(", work:")}).`,
      );
    return value;
  }
  // A drive letter is a path; any other scheme is a typo for work:.
  if (/^[a-z][a-z0-9+.-]+:/i.test(value))
    throw new Error(
      `${where}: ${value} is not a module path. Work's lists are work:<name>.`,
    );
  return value;
}

/** Grants name Work lists (bare) and workflows a module may use. */
function sanitizeGrants(
  record: Record<string, unknown>,
  where: string,
  module: boolean,
  app = false,
): { collections?: string[]; workflows?: string[] } {
  const list = (key: "collections" | "workflows", valid: RegExp | null) => {
    const raw = record[key];
    if (raw === undefined) return undefined;
    if (!Array.isArray(raw))
      throw new Error(`${where}: ${key} must be an array of names.`);
    return raw.map((name) => {
      if (
        typeof name !== "string" ||
        (valid ? !valid.test(name) : !isWorkSourceName(name))
      )
        throw new Error(
          key === "collections"
            ? `${where}: collections name Work's lists without work: (chats, files, ...).`
            : `${where}: workflows name the project's workflows.`,
        );
      return name;
    });
  };
  const collections = list("collections", null);
  const workflows = list("workflows", WORKFLOW_NAME);
  if (collections && !module && !app)
    throw new Error(
      `${where}: only apps and modules take a collections grant.`,
    );
  if (workflows && !module)
    throw new Error(`${where}: only modules take a workflows grant.`);
  return {
    ...(collections ? { collections } : {}),
    ...(workflows ? { workflows } : {}),
  };
}

function sanitizeSection(
  raw: unknown,
  sectionIds: Set<string>,
): SidebarSectionConfig[] {
  if (!isRecord(raw) || !stableId(raw.id) || sectionIds.has(raw.id))
    throw new Error("Each section needs a unique id.");
  const where = `Section ${raw.id}`;
  if ("type" in raw)
    throw new Error(
      `${where}: sections have no type (ADR 0234). Name a source ("work:chats" or a module path), items, app or note.`,
    );
  sectionIds.add(raw.id);
  const kinds = (["source", "items", "app", "note"] as const).filter(
    (key) => raw[key] !== undefined,
  );
  if (kinds.length !== 1)
    throw new Error(
      `${where} needs exactly one of source, items, app or note.`,
    );
  const when = sanitizeSidebarWhen(raw.when);
  if (when === null) return [];
  const source =
    raw.source === undefined
      ? undefined
      : sanitizeSourceName(raw.source, where);
  const name = workSourceName(source);
  if (name && SESSION_WORK_SOURCES.includes(name) && when?.session !== true)
    throw new Error(
      `${where}: ${source} lists the chat in front; add when: { session: true }.`,
    );
  if (
    raw.app !== undefined &&
    (typeof raw.app !== "string" || !/^[a-zA-Z0-9_-]+$/.test(raw.app))
  )
    throw new Error(`${where}: app is a project app's name.`);
  if (
    raw.note !== undefined &&
    raw.note !== true &&
    (typeof raw.note !== "string" ||
      !raw.note ||
      raw.note.startsWith("/") ||
      raw.note.split(/[\\/]/).includes(".."))
  )
    throw new Error(`${where}: note is a project-relative path, or true.`);
  if (
    raw.presentation !== undefined &&
    raw.presentation !== "rows" &&
    raw.presentation !== "tiles"
  )
    throw new Error(`${where}: presentation is "rows" or "tiles".`);
  const module = source !== undefined && !name;
  const grants = sanitizeGrants(raw, where, module, raw.app !== undefined);
  return [
    {
      id: raw.id,
      ...(source !== undefined ? { source } : {}),
      ...(raw.items !== undefined
        ? { items: sanitizeItems(raw.items) ?? [] }
        : {}),
      ...(typeof raw.app === "string" ? { app: raw.app } : {}),
      ...(raw.note === true || typeof raw.note === "string"
        ? { note: raw.note }
        : {}),
      ...(typeof raw.title === "string" ? { title: raw.title } : {}),
      ...(raw.presentation === "tiles" ? { presentation: "tiles" } : {}),
      ...grants,
      ...(isRecord(raw.itemDefaults)
        ? { itemDefaults: sanitizePresentation(raw.itemDefaults) }
        : {}),
      ...(isRecord(raw.itemOverrides)
        ? {
            itemOverrides: Object.fromEntries(
              Object.entries(raw.itemOverrides).map(([key, value]) => {
                if (!isRecord(value))
                  throw new Error(`${where}: invalid item override ${key}.`);
                return [key, sanitizePresentation(value)];
              }),
            ),
          }
        : {}),
      contextMenu: sanitizeMenu(raw.contextMenu),
      actions: sanitizeMenu(raw.actions),
      headerActions: sanitizeMenu(raw.headerActions),
      menu: sanitizeMenu(raw.menu),
      ...(typeof raw.rowHeight === "number" && Number.isFinite(raw.rowHeight)
        ? { rowHeight: Math.max(28, Math.min(160, raw.rowHeight)) }
        : {}),
      ...(typeof raw.height === "number" && Number.isFinite(raw.height)
        ? { height: Math.max(120, Math.min(1200, raw.height)) }
        : {}),
      ...(raw.collapsed === true ? { collapsed: true } : {}),
      ...(typeof raw.hideEmpty === "boolean"
        ? { hideEmpty: raw.hideEmpty }
        : {}),
      ...(typeof raw.empty === "string" ? { empty: raw.empty } : {}),
      ...(asOpenMode(raw.open) ? { open: asOpenMode(raw.open) } : {}),
      ...(when ? { when } : {}),
    },
  ];
}

function sanitizeTabs({
  raw,
  ids,
  sectionIds,
}: {
  raw: unknown;
  ids: Set<string>;
  sectionIds: Set<string>;
}): SidebarTabConfig[] {
  if (!Array.isArray(raw))
    throw new Error("sidebars.left and sidebars.right must be arrays of tabs.");
  return raw
    .map((tab): SidebarTabConfig => {
      if (
        !isRecord(tab) ||
        !stableId(tab.id) ||
        ids.has(tab.id) ||
        typeof tab.title !== "string" ||
        !tab.title.trim() ||
        !Array.isArray(tab.sections)
      ) {
        throw new Error("Each tab needs a unique id, a title, and sections.");
      }
      ids.add(tab.id);
      const sections = tab.sections.flatMap((section) =>
        sanitizeSection(section, sectionIds),
      );
      const when = sanitizeSidebarWhen(tab.when);
      return {
        id: tab.id,
        title: tab.title,
        icon: typeof tab.icon === "string" ? tab.icon : undefined,
        sections: when === null ? [] : sections,
        when: when ?? undefined,
      };
    })
    .filter((tab) => tab.sections.length > 0);
}

function sanitize(raw: unknown): WorkspaceConfig {
  if (!isRecord(raw))
    throw new Error("Export a workspace configuration object.");
  if (!isRecord(raw.sidebars))
    throw new Error("Export { sidebars: { left, right }, palette? }.");
  const unknown = Object.keys(raw).filter(
    (key) => key !== "sidebars" && key !== "palette",
  );
  if (unknown.length)
    throw new Error(`Unknown workspace keys: ${unknown.join(", ")}.`);
  const ids = new Set<string>();
  const sectionIds = new Set<string>();
  const sides = Object.keys(raw.sidebars).filter(
    (key) => key !== "left" && key !== "right",
  );
  if (sides.length)
    throw new Error(
      `Unknown sidebars: ${sides.join(", ")}. Use left and right.`,
    );
  const sidebars = {
    left: sanitizeTabs({ raw: raw.sidebars.left, ids, sectionIds }),
    right: sanitizeTabs({ raw: raw.sidebars.right, ids, sectionIds }),
  };
  const modes = sanitizePaletteModes({
    raw: raw.palette,
    sections: sidebarSections({ sidebars }),
    ids: sectionIds,
  });
  return { sidebars, ...(modes ? { palette: { modes } } : {}) };
}

/**
 * palette.modes (ADR 0186). Ids share the section namespace because both
 * address executable sources; triggers must not shadow built-in modes.
 */
function sanitizePaletteModes({
  raw,
  sections,
  ids,
}: {
  raw: unknown;
  sections: SidebarSectionConfig[];
  ids: Set<string>;
}): PaletteModeConfig[] | undefined {
  if (raw === undefined) return undefined;
  if (!isRecord(raw) || !Array.isArray(raw.modes))
    throw new Error("palette must be { modes: [...] }.");
  const names = new Set<string>();
  return raw.modes.map((mode): PaletteModeConfig => {
    if (!isRecord(mode) || !stableId(mode.id) || ids.has(mode.id))
      throw new Error(
        "Each palette mode needs a unique id, distinct from section ids.",
      );
    ids.add(mode.id);
    const where = `Palette mode ${mode.id}`;
    if (typeof mode.title !== "string" || !mode.title.trim())
      throw new Error(`${where} needs a title.`);
    const triggers = [
      mode.trigger,
      ...(Array.isArray(mode.aliases) ? mode.aliases : []),
    ].map((value) => {
      const name =
        typeof value === "string" ? normalizePaletteTrigger(value) : null;
      if (!name)
        throw new Error(
          `${where}: triggers are 1 to 32 lowercase letters, digits or dashes.`,
        );
      if (RESERVED_PALETTE_TRIGGERS.has(name))
        throw new Error(`${where}: "${name}" is a built-in mode.`);
      if (names.has(name))
        throw new Error(`${where}: "${name}" is already another mode's name.`);
      names.add(name);
      return name;
    });
    if (mode.aliases !== undefined && !Array.isArray(mode.aliases))
      throw new Error(`${where}: aliases must be an array of names.`);
    const source =
      mode.source === undefined
        ? undefined
        : sanitizeSourceName(mode.source, where);
    const listed = workSourceName(source);
    // The palette has no chat beside it.
    if (listed && SESSION_WORK_SOURCES.includes(listed))
      throw new Error(
        `${where}: ${source} needs a chat; the palette has none.`,
      );
    const section =
      typeof mode.section === "string"
        ? sections.find((item) => item.id === mode.section)
        : undefined;
    if (mode.section !== undefined) {
      if (!section) throw new Error(`${where}: no section ${mode.section}.`);
      // Its rows are one chat's; the palette has no chat beside it.
      if (section.when?.session === true)
        throw new Error(
          `${where}: section ${mode.section} lists the chat in front (when.session); the palette has none.`,
        );
      if (section.source === undefined && !section.items?.length)
        throw new Error(
          `${where}: a mode's section lists rows: a source, or items.`,
        );
    }
    const items = sanitizeItems(mode.items);
    if ([source, section, items].filter(Boolean).length !== 1)
      throw new Error(
        `${where} needs exactly one of source, section or items.`,
      );
    if (
      mode.search !== undefined &&
      mode.search !== "palette" &&
      mode.search !== "source"
    )
      throw new Error(`${where}: search is "palette" or "source".`);
    const module =
      (source !== undefined && !listed) ||
      (section?.source !== undefined && !workSourceName(section.source));
    if (mode.search === "source" && !module)
      throw new Error(`${where}: search "source" needs an executable module.`);
    if (mode.search === "source" && mode.topLevel === true)
      throw new Error(
        `${where}: topLevel rows must be loaded once; use search "palette".`,
      );
    const grants = sanitizeGrants(mode, where, source !== undefined && !listed);
    let when: SidebarWhen | undefined;
    if (mode.when !== undefined) {
      if (
        !isRecord(mode.when) ||
        Object.keys(mode.when).some((key) => key !== "permissions")
      )
        throw new Error(`${where}: when supports permissions only.`);
      const sanitized = sanitizeSidebarWhen(mode.when);
      if (!sanitized) throw new Error(`${where}: invalid when.permissions.`);
      when = sanitized;
    }
    return {
      id: mode.id,
      trigger: triggers[0] ?? "",
      ...(triggers.length > 1 ? { aliases: triggers.slice(1) } : {}),
      title: mode.title.trim(),
      description:
        typeof mode.description === "string" ? mode.description : undefined,
      icon: typeof mode.icon === "string" ? mode.icon : undefined,
      placeholder:
        typeof mode.placeholder === "string" ? mode.placeholder : undefined,
      source,
      section: section?.id,
      items,
      ...grants,
      search: mode.search === "source" ? "source" : "palette",
      topLevel: mode.topLevel === true,
      when,
    };
  });
}

/** Evaluate a workspace.js source in the isolated vm context. Throws. */
/**
 * workspace.js is data written as a script. Nothing of this process enters
 * its context (a host object would hand it this realm's Function, and with
 * it `process`), and its value leaves as JSON, so none of its code runs
 * here. A committed project file is someone else's: this is what keeps it
 * data.
 */
function evaluateWorkspaceModule(source: string, filename: string): unknown {
  const context = vm.createContext(Object.create(null));
  vm.runInContext(
    "var module = { exports: {} }; var exports = module.exports;",
    context,
  );
  vm.runInContext(source, context, { filename, timeout: 250 });
  const json: unknown = vm.runInContext(
    "JSON.stringify(module.exports)",
    context,
    { timeout: 250 },
  );
  return typeof json === "string" ? JSON.parse(json) : undefined;
}

/** Replace a file whole: a crash leaves the old one or the new one. */
function writeFileAtomically(file: string, content: string) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  fs.writeFileSync(temporary, content);
  fs.renameSync(temporary, file);
}

/** Where the original goes: `.v1`, or the next free name if that differs. */
function backupPath(file: string): string | null {
  const original = fs.readFileSync(file, "utf-8");
  for (let index = 1; index < 100; index += 1) {
    const candidate = index === 1 ? `${file}.v1` : `${file}.v1-${index}`;
    if (!fs.existsSync(candidate)) return candidate;
    if (fs.readFileSync(candidate, "utf-8") === original) return null;
  }
  return null;
}

/**
 * A host-owned file written before ADR 0234 is rewritten once in the new
 * shape, its original kept beside it (`.v1`). Committed project files are
 * never rewritten: they keep their error until someone edits them.
 */
function upgradeHostFile(file: string, raw: unknown): unknown {
  const upgraded = upgradeWorkspaceLayout(raw);
  if (upgraded === null) return raw;
  // Checked before anything is written: a layout the rewrite cannot make
  // valid stays as it is on disk, and its error says what to change.
  sanitize(upgraded);
  const backup = backupPath(file);
  if (backup) fs.copyFileSync(file, backup);
  writeFileAtomically(file, workspaceFileFor(upgraded));
  return upgraded;
}

/**
 * Load an entire layout atomically. Invalid edits retain the last valid
 * layout for this exact file; a first invalid load uses defaults and exposes
 * an error. Never silently fall through to a different configuration layer.
 */
const lastGood = new Map<string, WorkspaceConfig>();
const loadErrors = new Map<string, string>();
export function loadWorkspaceConfigFile(
  file: string,
  options: { upgrade?: boolean } = {},
): WorkspaceConfig {
  try {
    const raw = evaluateWorkspaceModule(fs.readFileSync(file, "utf-8"), file);
    const config = sanitize(options.upgrade ? upgradeHostFile(file, raw) : raw);
    lastGood.delete(file);
    lastGood.set(file, config);
    if (lastGood.size > 100) {
      const oldest = lastGood.keys().next().value;
      if (oldest) {
        lastGood.delete(oldest);
        loadErrors.delete(oldest);
      }
    }
    loadErrors.delete(file);
    return config;
  } catch (cause) {
    if (loadErrors.size >= 100) {
      const oldest = loadErrors.keys().next().value;
      if (oldest) loadErrors.delete(oldest);
    }
    loadErrors.set(
      file,
      cause instanceof Error ? cause.message : String(cause),
    );
    return lastGood.get(file) ?? DEFAULT_WORKSPACE_CONFIG;
  }
}

/** Which layer of the ADR-0043 resolution produced the config. */
export type WorkspaceLayer =
  | "project-local"
  | "project"
  | "profile"
  | "default";

export interface ResolvedWorkspaceConfig {
  config: WorkspaceConfig;
  error?: string;
  layer: WorkspaceLayer;
  /** The winning layer's file (absent for the built-in default). */
  file?: string;
}

/** This user's local override for one project (layer 1). */
export function projectLocalWorkspaceFile(
  profileDir: string,
  projectId: string,
): string {
  return path.join(profileDir, "workspace-projects", `${projectId}.js`);
}

/** The project's shared, git-tracked workspace file (layer 2). */
export function projectWorkspaceFile(projectRoot: string): string {
  return path.join(projectRoot, PROJECT_WORKSPACE_CONFIG_PATH);
}

/** The candidate files for a resolution, most specific first. */
export function workspaceLayerFiles(opts: {
  profileDir: string;
  projectId?: string;
  projectRoot?: string | null;
}): Array<{ layer: WorkspaceLayer; file: string }> {
  const layers: Array<{ layer: WorkspaceLayer; file: string }> = [];
  if (opts.projectId) {
    layers.push({
      layer: "project-local",
      file: projectLocalWorkspaceFile(opts.profileDir, opts.projectId),
    });
  }
  if (opts.projectRoot) {
    layers.push({
      layer: "project",
      file: projectWorkspaceFile(opts.projectRoot),
    });
  }
  layers.push({
    layer: "profile",
    file: path.join(opts.profileDir, "workspace.js"),
  });
  return layers;
}

/**
 * Layered workspace resolution (ADR 0043 era): the FIRST existing file wins —
 * this user's per-project override, then the project's shared
 * `.work/workspace.js`, then the profile-global `workspace.js`, then the
 * built-in default. A file that exists but fails to evaluate does NOT slide
 * to the next layer (that would silently reroute a typo); it retains that
 * file's last valid layout, or defaults if none has loaded. `layer` names
 * the file that won even in that case.
 */
export function resolveWorkspaceConfig(opts: {
  profileDir: string;
  projectId?: string;
  projectRoot?: string | null;
}): ResolvedWorkspaceConfig {
  for (const { layer, file } of workspaceLayerFiles(opts)) {
    if (!fs.existsSync(file)) continue;
    // Only files Work keeps for the person are rewritten (ADR 0234).
    const config = loadWorkspaceConfigFile(file, {
      upgrade: layer !== "project",
    });
    return { config, layer, file, error: loadErrors.get(file) };
  }
  return { config: DEFAULT_WORKSPACE_CONFIG, layer: "default" };
}

/**
 * Watch one config-layer file for changes, tolerating the file — and its
 * containing directory — not existing yet (`.work/` is opt-in, and
 * a profile's `workspace-projects/` appears on first override). Watches the
 * file's directory when it exists, and the parent otherwise so we notice
 * the directory being created. Returns a disposer.
 */
export function watchConfigLayerFile(
  file: string,
  onChange: () => void,
): () => void {
  const dir = path.dirname(file);
  const name = path.basename(file);
  const parent = path.dirname(dir);
  const dirName = path.basename(dir);
  let dirWatcher: fs.FSWatcher | undefined;
  let parentWatcher: fs.FSWatcher | undefined;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let disposed = false;

  const fire = () => {
    clearTimeout(debounce);
    debounce = setTimeout(onChange, 100);
  };

  const watchDir = (): boolean => {
    if (disposed || dirWatcher) return dirWatcher !== undefined;
    try {
      const watcher = fs.watch(dir, (_event, changed) => {
        if (changed === name) fire();
      });
      // The directory can vanish (project deleted, .work removed);
      // drop the watcher and let the parent watch re-establish it.
      watcher.on("error", () => {
        watcher.close();
        if (dirWatcher === watcher) dirWatcher = undefined;
      });
      dirWatcher = watcher;
      return true;
    } catch {
      return false; // Directory doesn't exist yet; parent watch retries.
    }
  };

  watchDir();
  // macOS FSEvents occasionally drops a change to a file written right
  // after it was created; a slow stat poll catches what the watch missed.
  const onPoll = (current: fs.Stats, previous: fs.Stats) => {
    if (current.mtimeMs !== previous.mtimeMs || current.size !== previous.size)
      fire();
  };
  fs.watchFile(file, { interval: 2000, persistent: false }, onPoll);
  try {
    parentWatcher = fs.watch(parent, (_event, changed) => {
      if (changed !== dirName) return;
      // The directory was created, removed, or swapped wholesale: rebuild
      // the inner watch and refresh — resolution may have changed either
      // way (the file can appear or disappear with its directory).
      dirWatcher?.close();
      dirWatcher = undefined;
      watchDir();
      fire();
    });
    parentWatcher.on("error", () => parentWatcher?.close());
  } catch {
    // No parent directory either: nothing to watch until it exists.
  }

  return () => {
    disposed = true;
    clearTimeout(debounce);
    fs.unwatchFile(file, onPoll);
    dirWatcher?.close();
    parentWatcher?.close();
  };
}

export class WorkspaceConfigStore {
  private unwatch: (() => void) | undefined;

  constructor(readonly file: string) {}

  /** Write the commented template on first run. */
  ensureFile(): void {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, DEFAULT_WORKSPACE_FILE);
    }
  }

  exists(): boolean {
    return fs.existsSync(this.file);
  }

  read(): string {
    try {
      return fs.readFileSync(this.file, "utf-8");
    } catch {
      return DEFAULT_WORKSPACE_FILE;
    }
  }

  write(source: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, source);
  }

  load(): WorkspaceConfig {
    return loadWorkspaceConfigFile(this.file, { upgrade: true });
  }

  /** The same watch as the project layers: directory events plus a poll. */
  watch(onChange: (config: WorkspaceConfig) => void): void {
    this.unwatch?.();
    this.unwatch = watchConfigLayerFile(this.file, () => onChange(this.load()));
  }

  dispose(): void {
    this.unwatch?.();
    this.unwatch = undefined;
  }
}

/**
 * A row's record crosses as plain JSON, bounded like session metadata: a
 * larger record is left out (the row still shows), never failing its page.
 */
function sanitizeData(raw: unknown): Record<string, unknown> | undefined {
  if (!isRecord(raw)) return undefined;
  const json = JSON.stringify(raw);
  // Room for a chat's record with its metadata (64 KB at most).
  if (json.length > 131_072) return undefined;
  const parsed: unknown = JSON.parse(json);
  return isRecord(parsed) ? parsed : undefined;
}

/** Validate a module's row before it crosses into the renderer. */
export function sanitizeSidebarSourceItem(
  item: unknown,
  ids = new Set<string>(),
): SidebarSourceItem {
  if (
    !isRecord(item) ||
    typeof item.id !== "string" ||
    !item.id ||
    ids.has(item.id) ||
    typeof item.label !== "string"
  )
    throw new Error("Source items need unique stable IDs and labels.");
  ids.add(item.id);
  const data = sanitizeData(item.data);
  const presentation = sanitizePresentation(item);
  // What a source wrote is bounded, and opens only what a row may: a
  // command that does more than open something stays the layout's.
  const entries = (list: SidebarMenuEntry[] | undefined) =>
    list?.filter((entry) => !entry.url || rowTargetAllowed(entry.url));
  const url =
    typeof item.url === "string" &&
    item.url.length <= 8192 &&
    rowTargetAllowed(item.url)
      ? item.url
      : undefined;
  return {
    ...presentation,
    ...(presentation.description
      ? { description: presentation.description.slice(0, 1000) }
      : {}),
    ...(presentation.icon && presentation.icon.length > 131_072
      ? { icon: undefined }
      : {}),
    ...(presentation.menu ? { menu: entries(presentation.menu) } : {}),
    ...(presentation.contextMenu
      ? { contextMenu: entries(presentation.contextMenu) }
      : {}),
    ...(presentation.actions ? { actions: entries(presentation.actions) } : {}),
    id: item.id,
    label: item.label.slice(0, 1000),
    parentId: typeof item.parentId === "string" ? item.parentId : null,
    hasChildren: item.hasChildren === true,
    url,
    // false opens a row with children the first time it loads.
    ...(typeof item.collapsed === "boolean"
      ? { collapsed: item.collapsed }
      : {}),
    ...(data ? { data } : {}),
  };
}

/** Validate executable source data before it crosses into the renderer. */
export function sanitizeSidebarSourcePage(raw: unknown): {
  items: SidebarSourceItem[];
  cursor?: string;
} {
  if (!isRecord(raw) || !Array.isArray(raw.items) || raw.items.length > 1000)
    throw new Error(
      "Source load must return { items, cursor? }, with at most 1000 items per page.",
    );
  const ids = new Set<string>();
  const items = raw.items.map((item) => sanitizeSidebarSourceItem(item, ids));
  return {
    items,
    cursor: typeof raw.cursor === "string" ? raw.cursor : undefined,
  };
}
