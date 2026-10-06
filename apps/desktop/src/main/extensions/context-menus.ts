import { matchesAny } from "./url-policy.js";

/**
 * `chrome.contextMenus` items (ADR 0203), kept per extension in main while
 * the extension stays loaded, and the menu entries a right-click shows.
 */

export type MenuItemType = "normal" | "checkbox" | "radio" | "separator";

export interface MenuItem {
  id: string;
  parentId: string | null;
  title: string;
  type: MenuItemType;
  contexts: string[];
  documentUrlPatterns: string[] | null;
  targetUrlPatterns: string[] | null;
  enabled: boolean;
  visible: boolean;
  checked: boolean;
}

/** Where a right-click happened, in Chrome's context names. */
export interface MenuTarget {
  contexts: Set<string>;
  pageUrl: string;
  frameUrl: string | null;
  frameId: number;
  linkUrl: string | null;
  srcUrl: string | null;
  mediaType: string | null;
  selectionText: string | null;
  editable: boolean;
}

export interface MenuEntry {
  item: MenuItem;
  label: string;
  children: MenuEntry[];
}

const ITEM_TYPES = new Set<MenuItemType>([
  "normal",
  "checkbox",
  "radio",
  "separator",
]);
const MAX_ITEMS_PER_EXTENSION = 1000;
const MAX_TITLE = 300;

const asStrings = (value: unknown): string[] | null =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : null;

export class ContextMenuStore {
  private readonly items = new Map<string, MenuItem[]>();

  private key(profileId: string, extensionId: string) {
    return `${profileId}:${extensionId}`;
  }

  private list(profileId: string, extensionId: string): MenuItem[] {
    const key = this.key(profileId, extensionId);
    let list = this.items.get(key);
    if (!list) {
      list = [];
      this.items.set(key, list);
    }
    return list;
  }

  private apply(item: MenuItem, props: Record<string, unknown>): void {
    if (typeof props.title === "string")
      item.title = props.title.slice(0, MAX_TITLE);
    if (typeof props.type === "string") {
      if (!ITEM_TYPES.has(props.type as MenuItemType))
        throw new Error(`Invalid menu item type: ${props.type}`);
      item.type = props.type as MenuItemType;
    }
    const contexts = asStrings(props.contexts);
    if (contexts) item.contexts = contexts.length > 0 ? contexts : ["page"];
    if ("documentUrlPatterns" in props)
      item.documentUrlPatterns = asStrings(props.documentUrlPatterns);
    if ("targetUrlPatterns" in props)
      item.targetUrlPatterns = asStrings(props.targetUrlPatterns);
    if (typeof props.enabled === "boolean") item.enabled = props.enabled;
    if (typeof props.visible === "boolean") item.visible = props.visible;
    if (typeof props.checked === "boolean") item.checked = props.checked;
  }

  create(
    profileId: string,
    extensionId: string,
    props: Record<string, unknown>,
  ): void {
    const list = this.list(profileId, extensionId);
    const id = String(props.id ?? "");
    if (!id)
      throw new Error(
        "Extensions using event pages or service workers must pass an id parameter to chrome.contextMenus.create",
      );
    if (list.some((item) => item.id === id))
      throw new Error(`Cannot create item with duplicate id ${id}`);
    if (list.length >= MAX_ITEMS_PER_EXTENSION)
      throw new Error("Too many context menu items.");
    const parentId =
      props.parentId === undefined || props.parentId === null
        ? null
        : String(props.parentId);
    if (parentId !== null && !list.some((item) => item.id === parentId))
      throw new Error(`Cannot find menu item with id ${parentId}`);
    const item: MenuItem = {
      id,
      parentId,
      title: "",
      type: "normal",
      contexts: ["page"],
      documentUrlPatterns: null,
      targetUrlPatterns: null,
      enabled: true,
      visible: true,
      checked: false,
    };
    this.apply(item, props);
    if (item.type !== "separator" && !item.title)
      throw new Error("A menu item needs a title.");
    list.push(item);
  }

  update(
    profileId: string,
    extensionId: string,
    id: string,
    props: Record<string, unknown>,
  ): void {
    const item = this.list(profileId, extensionId).find(
      (entry) => entry.id === id,
    );
    if (!item) throw new Error(`Cannot find menu item with id ${id}`);
    if ("parentId" in props) {
      const parentId =
        props.parentId === undefined || props.parentId === null
          ? null
          : String(props.parentId);
      if (parentId === id)
        throw new Error("A menu item cannot be its own parent.");
      item.parentId = parentId;
    }
    this.apply(item, props);
  }

  remove(profileId: string, extensionId: string, id: string): void {
    const list = this.list(profileId, extensionId);
    if (!list.some((item) => item.id === id))
      throw new Error(`Cannot find menu item with id ${id}`);
    const doomed = new Set([id]);
    let grew = true;
    while (grew) {
      grew = false;
      for (const item of list)
        if (
          item.parentId &&
          doomed.has(item.parentId) &&
          !doomed.has(item.id)
        ) {
          doomed.add(item.id);
          grew = true;
        }
    }
    this.items.set(
      this.key(profileId, extensionId),
      list.filter((item) => !doomed.has(item.id)),
    );
  }

  removeAll(profileId: string, extensionId: string): void {
    this.items.delete(this.key(profileId, extensionId));
  }

  forget(profileId: string, extensionId: string): void {
    this.removeAll(profileId, extensionId);
  }

  item(profileId: string, extensionId: string, id: string): MenuItem | null {
    return (
      this.items
        .get(this.key(profileId, extensionId))
        ?.find((item) => item.id === id) ?? null
    );
  }

  /** Toggle a checkbox, or select a radio in its group, after a click. */
  click(profileId: string, extensionId: string, id: string): boolean {
    const list = this.items.get(this.key(profileId, extensionId)) ?? [];
    const item = list.find((entry) => entry.id === id);
    if (!item) return false;
    const was = item.checked;
    if (item.type === "checkbox") item.checked = !item.checked;
    if (item.type === "radio") {
      const siblings = list.filter((entry) => entry.parentId === item.parentId);
      const at = siblings.indexOf(item);
      // A radio group is a run of radio items among siblings.
      let start = at;
      while (start > 0 && siblings[start - 1]?.type === "radio") start--;
      let end = at;
      while (end < siblings.length - 1 && siblings[end + 1]?.type === "radio")
        end++;
      for (const sibling of siblings.slice(start, end + 1))
        sibling.checked = sibling === item;
    }
    return was;
  }

  /** The entries one extension contributes at a right-click target. */
  entries(
    profileId: string,
    extensionId: string,
    target: MenuTarget,
  ): MenuEntry[] {
    const list = this.items.get(this.key(profileId, extensionId)) ?? [];
    const shows = (item: MenuItem) => {
      if (!item.visible) return false;
      const contexts = new Set(item.contexts);
      if (
        !contexts.has("all") &&
        !item.contexts.some((context) => target.contexts.has(context))
      )
        return false;
      const documentUrl = target.frameUrl ?? target.pageUrl;
      if (
        item.documentUrlPatterns &&
        !matchesAny(item.documentUrlPatterns, documentUrl)
      )
        return false;
      const targetUrl = target.linkUrl ?? target.srcUrl;
      if (
        item.targetUrlPatterns &&
        targetUrl &&
        !matchesAny(item.targetUrlPatterns, targetUrl)
      )
        return false;
      return true;
    };
    const label = (item: MenuItem) =>
      item.title.replaceAll(
        "%s",
        (target.selectionText ?? "").replace(/\s+/g, " ").slice(0, 64),
      );
    const build = (parentId: string | null): MenuEntry[] =>
      list
        .filter((item) => item.parentId === parentId && shows(item))
        .map((item) => ({
          item,
          label: label(item),
          children: build(item.id),
        }));
    return build(null);
  }
}

/** Chrome's contexts for a right-click on a page (Electron's params). */
export function pageMenuTarget(params: {
  pageURL: string;
  frameURL: string;
  linkURL: string;
  srcURL: string;
  mediaType: string;
  selectionText: string;
  isEditable: boolean;
  frameId: number;
}): MenuTarget {
  const contexts = new Set<string>(["all"]);
  const linkUrl = params.linkURL || null;
  const srcUrl = params.srcURL || null;
  const media =
    params.mediaType === "image" ||
    params.mediaType === "video" ||
    params.mediaType === "audio"
      ? params.mediaType
      : null;
  if (params.selectionText) contexts.add("selection");
  if (linkUrl) contexts.add("link");
  if (params.isEditable) contexts.add("editable");
  if (media) contexts.add(media);
  const inFrame =
    Boolean(params.frameURL) && params.frameURL !== params.pageURL;
  if (inFrame) contexts.add("frame");
  if (contexts.size === 1 || (contexts.size === 2 && inFrame))
    contexts.add("page");
  return {
    contexts,
    pageUrl: params.pageURL,
    frameUrl: inFrame ? params.frameURL : null,
    frameId: inFrame ? params.frameId : 0,
    linkUrl,
    srcUrl,
    mediaType: media,
    selectionText: params.selectionText || null,
    editable: params.isEditable,
  };
}
