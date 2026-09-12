import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import type { OpenMode } from "../shared/open-mode.js";
import { sanitizeProjectExperienceWhen } from "../shared/project-experience.js";
import { SIDEBAR_AUTHORING_GUIDE } from "./sidebar-authoring.js";

/**
 * User-customizable sidebar. The config is a real JS file at
 * `<userData>/profiles/<id>/sidebar.js` (same philosophy as keybindings.json:
 * plain, user-visible, agent-editable, file-watched, applies live). The file
 * evaluates in an isolated vm context with no require/process/fs and exports
 * left and right arrays of icon tabs, each holding ordered widget sections.
 *
 * Everything crossing into the renderer is DATA: the config is evaluated
 * in the main process and sent over IPC, so menu entries name a declared
 * `action` rather than carrying a callback.
 */

import type {
  SidebarAction,
  SidebarConfig,
  SidebarItem,
  SidebarItemPresentation,
  SidebarMenuEntry,
  SidebarPreview,
  SidebarPreviewMetadata,
  SidebarSectionConfig,
  SidebarSource,
  SidebarTabConfig,
  SidebarWhen,
} from "../shared/sidebar.js";

export type { SidebarConfig, SidebarSectionConfig } from "../shared/sidebar.js";

/** Hover menu for a project bookmark when the config doesn't override it. */
export const DEFAULT_BOOKMARK_MENU: SidebarMenuEntry[] = [
  { label: "Open in new tab", action: "open-tab" },
  { label: "Copy link", action: "copy-url" },
  { label: "Pin across projects", action: "pin" },
  { label: "Edit bookmark…", action: "edit" },
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
  left: [
    {
      id: "project",
      title: "Project",
      icon: "House",
      sections: [
        { id: "bookmarks", type: "bookmarks" },
        { id: "workflows", type: "workflows" },
        { id: "apps", type: "apps" },
        { id: "chats", type: "chats" },
        { id: "tabs", type: "tabs" },
        { id: "files", type: "files", collapsed: true },
        { id: "remote", type: "remote", title: "Server" },
      ],
    },
  ],
  right: [
    {
      id: "companion",
      title: "Activity",
      icon: "Activity",
      sections: [
        { id: "activity", type: "activity" },
        {
          id: "subsessions",
          type: "subsessions",
          title: "Subsessions",
          when: { surface: ["chat"], session: true },
          hideEmpty: true,
        },
        { id: "changes", type: "git", hideEmpty: true },
      ],
    },
    {
      id: "reviews",
      title: "Pull requests",
      icon: "GitPullRequest",
      when: { builder: true },
      sections: [{ id: "prs", type: "prs" }],
    },
  ],
};

export const DEFAULT_SIDEBAR_FILE = `${SIDEBAR_AUTHORING_GUIDE.split("\n")
  .map((line) => `// ${line}`)
  .join("\n")}
module.exports = ${JSON.stringify(DEFAULT_SIDEBAR_CONFIG, null, 2)};
`;

const VALID_TYPES = new Set([
  "workflows",
  "apps",
  "files",
  "chats",
  "subsessions",
  "bookmarks",
  "tabs",
  "git",
  "prs",
  "remote",
  "custom",
  "activity",
  "note",
  "app",
]);

const VALID_ACTIONS = new Set<SidebarAction>([
  "open",
  "open-tab",
  "open-here",
  "open-side",
  "open-floating",
  "copy-url",
  "pin",
  "unpin",
  "rename",
  "edit",
  "remove",
  "close",
  "archive",
  "unarchive",
  "mark-read",
  "mark-unread",
  "stop",
  "fork",
  "new-subsession",
  "history",
  "publish",
  "new-chat",
  "new-workflow",
  "refresh",
  "search",
]);

const asOpenMode = (value: unknown): OpenMode | undefined =>
  value === "tab" ||
  value === "replace" ||
  value === "side" ||
  value === "floating"
    ? value
    : undefined;

function sanitizeMenu(raw: unknown): SidebarMenuEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("Actions must be an array.");
  // An explicit [] means "no menu button"; keep it distinct from absent.
  return raw.flatMap((entry): SidebarMenuEntry[] => {
    if (!isRecord(entry)) throw new Error("Actions need label and action.");
    const record = entry;
    if (
      typeof record.label !== "string" ||
      typeof record.action !== "string" ||
      !VALID_ACTIONS.has(record.action as SidebarAction)
    ) {
      throw new Error("Action needs a label and a supported action name.");
    }
    return [
      {
        label: record.label,
        action: record.action as SidebarAction,
        danger: record.danger === true,
        icon: typeof record.icon === "string" ? record.icon : undefined,
        url: typeof record.url === "string" ? record.url : undefined,
        disabledReason:
          typeof record.disabledReason === "string"
            ? record.disabledReason
            : undefined,
      },
    ];
  });
}

function sanitizePreview(raw: unknown): SidebarPreview | false | undefined {
  if (raw === false) return false;
  if (typeof raw !== "object" || raw === null) return undefined;
  const record = raw as Record<string, unknown>;
  const metadata = Array.isArray(record.metadata)
    ? record.metadata
        .flatMap((entry): SidebarPreviewMetadata[] => {
          if (typeof entry !== "object" || entry === null) return [];
          const item = entry as Record<string, unknown>;
          if (
            typeof item.label !== "string" ||
            typeof item.value !== "string" ||
            item.label.length === 0 ||
            item.value.length === 0
          ) {
            return [];
          }
          return [{ label: item.label, value: item.value }];
        })
        .slice(0, 4)
    : [];
  const title =
    typeof record.title === "string" && record.title.length > 0
      ? record.title
      : undefined;
  const description =
    typeof record.description === "string" && record.description.length > 0
      ? record.description
      : undefined;
  if (!title && !description && metadata.length === 0) return undefined;
  return {
    title,
    description,
    metadata: metadata.length > 0 ? metadata : undefined,
  };
}

function sanitizeSidebarWhen(value: unknown): SidebarWhen | null | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value)) return null;
  if (
    Object.keys(value).some(
      (key) =>
        ![
          "builder",
          "permissions",
          "surface",
          "session",
          "pathPrefix",
          "selection",
        ].includes(key),
    )
  )
    return null;
  const authority = sanitizeProjectExperienceWhen({
    ...(value.builder !== undefined ? { builder: value.builder } : {}),
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
  };
}

function sanitizeSource(value: unknown): SidebarSource | undefined {
  if (value === undefined) return undefined;
  if (!isRecord(value) || !isSectionType(value.type))
    throw new Error("Source needs a supported type.");
  const scope = value.scope;
  if (
    scope !== undefined &&
    scope !== "project" &&
    scope !== "session" &&
    scope !== "children"
  )
    throw new Error("Unknown source scope.");
  if (
    scope &&
    scope !== "project" &&
    !["chats", "subsessions"].includes(value.type)
  )
    throw new Error(
      "Session and children scope require a chats or subsessions source.",
    );
  const filter: Record<string, string | number | boolean> = {};
  if (value.filter !== undefined) {
    if (!isRecord(value.filter))
      throw new Error("Source filter must be a field/value object.");
    for (const [key, entry] of Object.entries(value.filter)) {
      if (
        typeof entry !== "string" &&
        typeof entry !== "boolean" &&
        (typeof entry !== "number" || !Number.isFinite(entry))
      )
        throw new Error(
          "Filter values must be strings, booleans or finite numbers.",
        );
      filter[key] = entry;
    }
  }
  const sort = value.sort;
  if (
    sort !== undefined &&
    (!isRecord(sort) ||
      typeof sort.field !== "string" ||
      (sort.direction !== undefined &&
        sort.direction !== "asc" &&
        sort.direction !== "desc"))
  )
    throw new Error("Sort needs field and asc/desc direction.");
  return {
    type: value.type,
    scope,
    filter,
    sort:
      isRecord(sort) && typeof sort.field === "string"
        ? {
            field: sort.field,
            direction: sort.direction === "desc" ? "desc" : "asc",
          }
        : undefined,
    groupBy: typeof value.groupBy === "string" ? value.groupBy : undefined,
    pageSize:
      typeof value.pageSize === "number"
        ? Math.max(1, Math.min(100, Math.floor(value.pageSize)))
        : undefined,
    includeLatent: value.includeLatent === true,
  };
}

function sanitizePresentation(
  record: Record<string, unknown>,
): SidebarItemPresentation {
  const presentation: SidebarItemPresentation = {
    label: typeof record.label === "string" ? record.label : undefined,
    description:
      typeof record.description === "string" ? record.description : undefined,
    icon: typeof record.icon === "string" ? record.icon : undefined,
    badges: Array.isArray(record.badges)
      ? record.badges.filter(
          (badge): badge is string => typeof badge === "string",
        )
      : undefined,
    progress:
      typeof record.progress === "number" && Number.isFinite(record.progress)
        ? Math.max(0, Math.min(1, record.progress))
        : undefined,
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
  if (depth > 20) throw new Error("Custom item trees cannot exceed 20 levels.");
  return raw.flatMap((entry): SidebarItem[] => {
    if (typeof entry !== "object" || entry === null) return [];
    const record = entry as Record<string, unknown>;
    const when = sanitizeSidebarWhen(record.when);
    if (when === null) return [];
    const url = typeof record.url === "string" ? record.url : undefined;
    const id =
      typeof record.id === "string"
        ? record.id
        : `${parentId}/${url ?? record.label ?? "Folder"}`;
    if (!id || ids.has(id))
      throw new Error(
        "Custom items need unique stable IDs within their section.",
      );
    ids.add(id);
    const items = sanitizeItems(record.items, depth + 1, ids, id);
    if (
      !url &&
      (!items || items.length === 0) &&
      !Array.isArray(record.actions)
    )
      return [];
    return [
      {
        ...sanitizePresentation(record),
        id,
        label:
          typeof record.label === "string" && record.label
            ? record.label
            : (url ?? "Folder"),
        url,
        icon: typeof record.icon === "string" ? record.icon : undefined,
        open: asOpenMode(record.open),
        menu: sanitizeMenu(record.menu),
        preview: sanitizePreview(record.preview),
        items,
        collapsed: record.collapsed === true,
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

function isSectionType(value: unknown): value is SidebarSectionConfig["type"] {
  return typeof value === "string" && VALID_TYPES.has(value);
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
    throw new Error("Both left and right must be arrays of tabs.");
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
      const sections = tab.sections.flatMap(
        (section): SidebarSectionConfig[] => {
          if (
            !isRecord(section) ||
            !stableId(section.id) ||
            sectionIds.has(section.id) ||
            !isSectionType(section.type)
          ) {
            throw new Error(
              "Each widget needs a unique id and a supported type.",
            );
          }
          sectionIds.add(section.id);
          const when = sanitizeSidebarWhen(section.when);
          if (when === null) return [];
          const source = sanitizeSource(section.source);
          if (
            (source?.type ?? section.type) === "app" &&
            (typeof section.app !== "string" ||
              !/^[a-zA-Z0-9_-]+$/.test(section.app))
          )
            throw new Error("App widgets need an app name.");
          if (
            section.path !== undefined &&
            (typeof section.path !== "string" ||
              section.path.startsWith("/") ||
              section.path.split(/[\\/]/).includes(".."))
          )
            throw new Error("Notes need a project-relative path.");
          return [
            {
              id: section.id,
              source,
              collections: Array.isArray(section.collections)
                ? section.collections.filter(
                    (name): name is string =>
                      typeof name === "string" &&
                      [
                        "chats",
                        "subsessions",
                        "activity",
                        "files",
                        "workflows",
                        "apps",
                        "git",
                        "prs",
                        "bookmarks",
                        "remote",
                        "tabs",
                      ].includes(name),
                  )
                : undefined,
              itemDefaults: isRecord(section.itemDefaults)
                ? sanitizePresentation(section.itemDefaults)
                : undefined,
              itemOverrides: isRecord(section.itemOverrides)
                ? Object.fromEntries(
                    Object.entries(section.itemOverrides).map(
                      ([key, value]) => {
                        if (!isRecord(value))
                          throw new Error(`Invalid item override: ${key}`);
                        return [key, sanitizePresentation(value)];
                      },
                    ),
                  )
                : undefined,
              contextMenu: sanitizeMenu(section.contextMenu),
              actions: sanitizeMenu(section.actions),
              headerActions: sanitizeMenu(section.headerActions),
              rowHeight:
                typeof section.rowHeight === "number"
                  ? Math.max(28, Math.min(160, section.rowHeight))
                  : undefined,
              type: section.type,
              title:
                typeof section.title === "string" ? section.title : undefined,
              app: typeof section.app === "string" ? section.app : undefined,
              path: typeof section.path === "string" ? section.path : undefined,
              height:
                typeof section.height === "number" &&
                Number.isFinite(section.height)
                  ? Math.max(120, Math.min(1200, section.height))
                  : undefined,
              collapsed: section.collapsed === true,
              hideEmpty:
                typeof section.hideEmpty === "boolean"
                  ? section.hideEmpty
                  : undefined,
              items: sanitizeItems(section.items),
              open: asOpenMode(section.open),
              menu: sanitizeMenu(section.menu),
              when,
            },
          ];
        },
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

function sanitize(raw: unknown): SidebarConfig {
  if (!isRecord(raw)) throw new Error("Export a sidebar configuration object.");
  const ids = new Set<string>();
  const sectionIds = new Set<string>();
  return {
    left: sanitizeTabs({ raw: raw.left, ids, sectionIds }),
    right: sanitizeTabs({ raw: raw.right, ids, sectionIds }),
  };
}

/** Evaluate a sidebar.js source in the isolated vm context. Throws. */
function evaluateSidebarModule(source: string, filename: string): unknown {
  const module = { exports: {} as unknown };
  const context = vm.createContext({ module, exports: module.exports });
  vm.runInContext(source, context, { filename, timeout: 250 });
  return module.exports;
}

/**
 * Load an entire layout atomically. Invalid edits retain the last valid
 * layout for this exact file; a first invalid load uses defaults and exposes
 * an error. Never silently fall through to a different configuration layer.
 */
const lastGood = new Map<string, SidebarConfig>();
const loadErrors = new Map<string, string>();
export function loadSidebarConfigFile(file: string): SidebarConfig {
  try {
    const config = sanitize(
      evaluateSidebarModule(fs.readFileSync(file, "utf-8"), file),
    );
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
    return lastGood.get(file) ?? DEFAULT_SIDEBAR_CONFIG;
  }
}

/** Which layer of the ADR-0043 resolution produced the config. */
export type SidebarLayer = "project-local" | "project" | "profile" | "default";

export interface ResolvedSidebarConfig {
  config: SidebarConfig;
  error?: string;
  layer: SidebarLayer;
  /** The winning layer's file (absent for the built-in default). */
  file?: string;
}

/** This user's local override for one project (layer 1). */
export function projectLocalSidebarFile(
  profileDir: string,
  projectId: string,
): string {
  return path.join(profileDir, "sidebar-projects", `${projectId}.js`);
}

/** The project's shared, git-tracked sidebar (layer 2). */
export function projectSidebarFile(projectRoot: string): string {
  return path.join(projectRoot, ".catamorphic", "sidebar.js");
}

/** The candidate files for a resolution, most specific first. */
export function sidebarLayerFiles(opts: {
  profileDir: string;
  projectId?: string;
  projectRoot?: string | null;
}): Array<{ layer: SidebarLayer; file: string }> {
  const layers: Array<{ layer: SidebarLayer; file: string }> = [];
  if (opts.projectId) {
    layers.push({
      layer: "project-local",
      file: projectLocalSidebarFile(opts.profileDir, opts.projectId),
    });
  }
  if (opts.projectRoot) {
    layers.push({
      layer: "project",
      file: projectSidebarFile(opts.projectRoot),
    });
  }
  layers.push({
    layer: "profile",
    file: path.join(opts.profileDir, "sidebar.js"),
  });
  return layers;
}

/**
 * Layered sidebar resolution (ADR 0043 era): the FIRST existing file wins —
 * this user's per-project override, then the project's shared
 * `.catamorphic/sidebar.js`, then the profile-global `sidebar.js`, then the
 * built-in default. A file that exists but fails to evaluate does NOT slide
 * to the next layer (that would silently reroute a typo); it retains that
 * file's last valid layout, or defaults if none has loaded. `layer` names
 * the file that won even in that case.
 */
export function resolveSidebarConfig(opts: {
  profileDir: string;
  projectId?: string;
  projectRoot?: string | null;
}): ResolvedSidebarConfig {
  for (const { layer, file } of sidebarLayerFiles(opts)) {
    if (!fs.existsSync(file)) continue;
    const config = loadSidebarConfigFile(file);
    return { config, layer, file, error: loadErrors.get(file) };
  }
  return { config: DEFAULT_SIDEBAR_CONFIG, layer: "default" };
}

/**
 * Watch one config-layer file for changes, tolerating the file — and its
 * containing directory — not existing yet (`.catamorphic/` is opt-in, and
 * a profile's `sidebar-projects/` appears on first override). Watches the
 * file's directory when it exists, and the parent otherwise so we notice
 * the directory being created. Returns a disposer.
 */
export function watchSidebarLayerFile(
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
      // The directory can vanish (project deleted, .catamorphic removed);
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
    dirWatcher?.close();
    parentWatcher?.close();
  };
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

  exists(): boolean {
    return fs.existsSync(this.file);
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
   * Does this source evaluate to a valid two-sided layout? Guards the
   * agent-edit path: silently writing a broken file would collapse the
   * user's sidebar to the defaults with no explanation.
   */
  isValidSource(source: string): boolean {
    try {
      const evaluated = evaluateSidebarModule(source, this.file);
      sanitize(evaluated);
      return true;
    } catch {
      return false;
    }
  }

  load(): SidebarConfig {
    return loadSidebarConfigFile(this.file);
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
