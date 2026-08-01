import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";

/**
 * User-customizable sidebar. The config is a real JS file at
 * `<userData>/sidebar.js` (same philosophy as keybindings.json: plain,
 * user-visible, agent-editable, file-watched, applies live). The file
 * evaluates in an isolated vm context — no require/process/fs — and
 * exports an ordered list of sections. Removing a section from the list
 * hides it; adding a `custom` section invents a new one.
 *
 * Everything crossing into the renderer is DATA: the config is evaluated
 * in the main process and sent over IPC, so menu entries name a declared
 * `action` rather than carrying a callback.
 */

/** What a click (or menu entry) does. Declarative so it can cross IPC. */
export type SidebarAction =
  | "open" // open the item's url per its `open` mode
  | "open-tab" // force a new browser tab
  | "open-here" // force reuse of the focused browser tab
  | "copy-url"
  | "pin" // bookmarks: promote to the profile-wide list
  | "unpin"
  | "rename"
  | "remove";

export interface SidebarMenuEntry {
  label: string;
  action: SidebarAction;
  /** Render in the danger color (destructive). */
  danger?: boolean;
}

export interface SidebarItem {
  label: string;
  url: string;
  /** Icon name from lucide-react, e.g. "Globe", "FileText". */
  icon?: string;
  open?: "tab" | "replace";
  /** Hover menu (three-dots). Omit for the section default. */
  menu?: SidebarMenuEntry[];
}

export interface SidebarSectionConfig {
  type: "workflows" | "apps" | "chats" | "bookmarks" | "custom";
  /** Override the section heading. */
  title?: string;
  /** Start collapsed (default open). */
  collapsed?: boolean;
  /** For type "custom": the entries to render. */
  items?: SidebarItem[];
  /** Default click behavior for this section's items. */
  open?: "tab" | "replace";
  /** Override the per-item hover menu for the whole section. */
  menu?: SidebarMenuEntry[];
}

export interface SidebarConfig {
  sections: SidebarSectionConfig[];
}

/** Hover menu for a project bookmark when the config doesn't override it. */
export const DEFAULT_BOOKMARK_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Pin across projects", action: "pin" },
  { label: "Rename…", action: "rename" },
  { label: "Delete", action: "remove", danger: true },
];

/** Same, for an already-pinned bookmark. */
export const DEFAULT_PINNED_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Unpin into this project", action: "unpin" },
  { label: "Rename…", action: "rename" },
  { label: "Delete", action: "remove", danger: true },
];

/** Menu offered to custom items that don't declare their own. */
export const DEFAULT_CUSTOM_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
];

export const DEFAULT_SIDEBAR_CONFIG: SidebarConfig = {
  sections: [
    { type: "workflows" },
    { type: "apps" },
    { type: "chats" },
    { type: "bookmarks" },
  ],
};

export const DEFAULT_SIDEBAR_FILE = `// Catamorphic sidebar configuration.
//
// Plain JavaScript, evaluated in a sandbox (no require/fs/network).
// Edit and save — the sidebar updates live, no restart.
// You can also just ask the assistant to change this for you.
//
// SECTIONS — the list below is the sidebar, in order.
//   Remove a section to hide it. Reorder freely. Add your own.
//
//   { type: "workflows" }   built-in: this project's workflows
//   { type: "apps" }        built-in: this project's apps
//   { type: "chats" }       built-in: this project's chats
//   { type: "bookmarks" }   built-in: browser bookmarks (the address-bar
//                           star writes these; stored in bookmarks.json)
//   { type: "custom", title: "…", items: [ … ] }   your own list
//
// COMMON ATTRIBUTES
//   title:     override the heading
//   collapsed: start collapsed
//   open:      "tab"     — always open in a new browser tab
//              "replace" — reuse the focused browser tab (falls back to a
//                          new tab when the focused tab isn't a browser)
//
// CUSTOM ITEMS
//   { label, url, icon?, open?, menu? }
//   icon: any lucide-react name, e.g. "Globe", "FileText", "Github".
//
// HOVER MENU (the ⋯ button on an item)
//   menu: [{ label, action, danger? }]
//   Actions: "open", "open-tab", "open-here", "copy-url",
//            "pin", "unpin", "rename", "remove".
//   Set menu: [] to give an item no ⋯ button at all.
//   On a section, \`menu\` overrides the menu for all of its items.

module.exports = {
  sections: [
    { type: "workflows" },
    { type: "apps" },
    { type: "chats" },
    { type: "bookmarks" },

    // Example — uncomment to add your own section:
    // {
    //   type: "custom",
    //   title: "Docs",
    //   open: "replace",
    //   items: [
    //     { label: "MDN", url: "https://developer.mozilla.org", icon: "Globe" },
    //     {
    //       label: "Electron",
    //       url: "https://electronjs.org/docs",
    //       open: "tab",
    //       menu: [{ label: "Copy link", action: "copy-url" }],
    //     },
    //   ],
    // },
  ],
};
`;

const VALID_TYPES = new Set([
  "workflows",
  "apps",
  "chats",
  "bookmarks",
  "custom",
]);

const VALID_ACTIONS = new Set<SidebarAction>([
  "open",
  "open-tab",
  "open-here",
  "copy-url",
  "pin",
  "unpin",
  "rename",
  "remove",
]);

const asOpenMode = (value: unknown): "tab" | "replace" | undefined =>
  value === "tab" || value === "replace" ? value : undefined;

function sanitizeMenu(raw: unknown): SidebarMenuEntry[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  // An explicit [] means "no menu button"; keep it distinct from absent.
  return raw.flatMap((entry): SidebarMenuEntry[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (
      typeof record.label !== "string" ||
      typeof record.action !== "string" ||
      !VALID_ACTIONS.has(record.action as SidebarAction)
    ) {
      return [];
    }
    return [
      {
        label: record.label,
        action: record.action as SidebarAction,
        danger: record.danger === true,
      },
    ];
  });
}

function sanitizeItems(raw: unknown): SidebarItem[] | undefined {
  if (!Array.isArray(raw)) return undefined;
  return raw.flatMap((entry): SidebarItem[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    if (typeof record.url !== "string") return [];
    return [
      {
        label:
          typeof record.label === "string" && record.label
            ? record.label
            : record.url,
        url: record.url,
        icon: typeof record.icon === "string" ? record.icon : undefined,
        open: asOpenMode(record.open),
        menu: sanitizeMenu(record.menu),
      },
    ];
  });
}

function sanitize(raw: unknown): SidebarConfig {
  const record =
    typeof raw === "object" && raw !== null
      ? (raw as Record<string, unknown>)
      : {};
  const rawSections = Array.isArray(record.sections) ? record.sections : [];
  const sections: SidebarSectionConfig[] = [];
  for (const entry of rawSections) {
    if (typeof entry !== "object" || entry === null) continue;
    const section = entry as Record<string, unknown>;
    if (typeof section.type !== "string" || !VALID_TYPES.has(section.type)) {
      continue;
    }
    sections.push({
      type: section.type as SidebarSectionConfig["type"],
      title: typeof section.title === "string" ? section.title : undefined,
      collapsed: section.collapsed === true,
      items: sanitizeItems(section.items),
      open: asOpenMode(section.open),
      menu: sanitizeMenu(section.menu),
    });
  }
  // An empty/invalid config would leave the user with no sidebar and no
  // obvious way back, so fall back to the defaults.
  return sections.length > 0 ? { sections } : DEFAULT_SIDEBAR_CONFIG;
}

export class SidebarConfigStore {
  private watcher: fs.FSWatcher | undefined;
  private debounce: ReturnType<typeof setTimeout> | undefined;

  constructor(readonly file: string) {}

  /** Write the commented template on first run. */
  ensureFile(): void {
    if (!fs.existsSync(this.file)) {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, DEFAULT_SIDEBAR_FILE);
    }
  }

  read(): string {
    try {
      return fs.readFileSync(this.file, "utf-8");
    } catch {
      return DEFAULT_SIDEBAR_FILE;
    }
  }

  write(source: string): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    fs.writeFileSync(this.file, source);
  }

  /**
   * Does this source evaluate to at least one usable section? Guards the
   * agent-edit path: silently writing a broken file would collapse the
   * user's sidebar to the defaults with no explanation.
   */
  isValidSource(source: string): boolean {
    try {
      const module = { exports: {} as unknown };
      const context = vm.createContext({ module, exports: module.exports });
      vm.runInContext(source, context, { filename: this.file, timeout: 250 });
      const exported = module.exports as { sections?: unknown };
      return (
        Array.isArray(exported?.sections) &&
        sanitize(module.exports).sections.length > 0 &&
        exported.sections.length > 0
      );
    } catch {
      return false;
    }
  }

  load(): SidebarConfig {
    try {
      const module = { exports: {} as unknown };
      const context = vm.createContext({ module, exports: module.exports });
      vm.runInContext(this.read(), context, {
        filename: this.file,
        timeout: 250,
      });
      return sanitize(module.exports);
    } catch (cause) {
      console.warn("[desktop] sidebar.js failed to evaluate:", cause);
      return DEFAULT_SIDEBAR_CONFIG;
    }
  }

  watch(onChange: (config: SidebarConfig) => void): void {
    const dir = path.dirname(this.file);
    const name = path.basename(this.file);
    this.watcher = fs.watch(dir, (_event, changed) => {
      if (changed !== name) return;
      clearTimeout(this.debounce);
      this.debounce = setTimeout(() => onChange(this.load()), 100);
    });
  }

  dispose(): void {
    this.watcher?.close();
    clearTimeout(this.debounce);
  }
}
