import type { OpenMode } from "./open-mode.js";
import {
  HOST_ACTION_LOOKS,
  isHostAction,
  isSidebarTone,
  rowTargetAllowed,
  type SidebarActionInput,
  type SidebarBadge,
  type SidebarItemPresentation,
  type SidebarMenuEntry,
  type SidebarPreview,
  type SidebarPreviewMetadata,
  type SidebarSignal,
  type SidebarTrend,
  SOURCE_ACTION_PATTERN,
} from "./sidebar.js";
import type { SidebarSourceItem } from "./sidebar-source.js";

/**
 * What a row may hold (ADR 0234, 0239), checked wherever rows come from
 * code or data Work did not write: a layout and a module's pages in main,
 * the chips an agent keeps in its session's metadata in the window. A row
 * that passes is the same everywhere, so every list and chip draws it the
 * same way.
 */

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export const asOpenMode = (value: unknown): OpenMode | undefined =>
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

export function sanitizeMenu(raw: unknown): SidebarMenuEntry[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) throw new Error("Actions must be an array.");
  // An explicit [] means "no menu button"; keep it distinct from absent.
  return raw.map((entry): SidebarMenuEntry => {
    if (!isRecord(entry) || typeof entry.action !== "string")
      throw new Error("Actions need an action.");
    const looks = isHostAction(entry.action)
      ? HOST_ACTION_LOOKS[entry.action]
      : undefined;
    const label =
      typeof entry.label === "string" && entry.label
        ? entry.label
        : looks?.label;
    if (!label)
      throw new Error(
        `Action "${entry.action}" needs a label (only Work's verbs have their own).`,
      );
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
    const icon = typeof entry.icon === "string" ? entry.icon : looks?.icon;
    return {
      label,
      action: entry.action,
      ...(entry.danger === true ? { danger: true } : {}),
      ...(icon ? { icon } : {}),
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
                ...(isSidebarTone(badge.tone) ? { tone: badge.tone } : {}),
              },
            ]
          : [],
    )
    .slice(0, 4);
}

/** At most 60 readings, each clamped to 0 through 1. */
function sanitizeTrend(raw: unknown): SidebarTrend | undefined {
  if (!isRecord(raw) || !Array.isArray(raw.values)) return undefined;
  const values = raw.values
    .filter(
      (value): value is number =>
        typeof value === "number" && Number.isFinite(value),
    )
    .slice(-60)
    .map((value) => Math.max(0, Math.min(1, value)));
  if (values.length === 0) return undefined;
  return {
    values,
    ...(typeof raw.label === "string" ? { label: raw.label.slice(0, 16) } : {}),
    ...(isSidebarTone(raw.tone) ? { tone: raw.tone } : {}),
  };
}

const asSignal = (value: unknown): SidebarSignal | undefined =>
  value === "working" || value === "attention" || value === "unread"
    ? value
    : undefined;

export function sanitizePresentation(
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
    tone: isSidebarTone(record.tone) ? record.tone : undefined,
    wide: typeof record.wide === "boolean" ? record.wide : undefined,
    badges: sanitizeBadges(record.badges),
    progress:
      typeof record.progress === "number" && Number.isFinite(record.progress)
        ? Math.max(0, Math.min(1, record.progress))
        : undefined,
    trend: sanitizeTrend(record.trend),
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
