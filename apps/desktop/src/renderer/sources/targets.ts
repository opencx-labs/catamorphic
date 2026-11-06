import { parseChatBookmarkUrl } from "../../shared/bookmark-target.js";
import type { SidebarSurface } from "../../shared/sidebar.js";
import { parseSurfaceLink } from "../../shared/surface-link.js";
import type { TabDragPayload } from "../lib/tab-drag.js";

/**
 * One key per place a target opens (ADR 0234), so a row is active when its
 * address is what is in front, whoever wrote the row: a chat by session, a
 * file by path, a workflow or app by name, a tab by key, a page by address.
 */
export function targetKey(url: string | undefined): string | undefined {
  if (!url) return undefined;
  const chat = parseChatBookmarkUrl(url);
  if (chat) return `chat:${chat.sessionId}`;
  if (url.startsWith("session:"))
    return `chat:${decodeURIComponent(url.slice("session:".length))}`;
  const link = parseSurfaceLink(url);
  if (!link) return url;
  switch (link.kind) {
    case "browser":
      return `web:${link.url}`;
    case "file":
      return `file:${link.path}`;
    case "tab":
      return `tab:${link.key}`;
    default:
      return `${link.kind}:${link.name}`;
  }
}

/** The keys of what is in front: its chat, its file, its tab, its resource. */
export function frontKeys(surface: SidebarSurface): ReadonlySet<string> {
  const keys = new Set<string>();
  if (surface.sessionId) keys.add(`chat:${surface.sessionId}`);
  if (surface.path) keys.add(`file:${surface.path}`);
  if (surface.key) {
    keys.add(`tab:${surface.key}`);
    const key = targetKey(surface.key);
    if (key) keys.add(key);
  }
  return keys;
}

/** The chat a target names, in any project. */
export function chatTarget(url: string | undefined) {
  if (!url) return null;
  return parseChatBookmarkUrl(url);
}

/**
 * What a row offers when dragged out of its section: a chat as a chat, an
 * open tab as itself, a page or file as a link to keep.
 */
export function rowDragPayload({
  sectionId,
  id,
  label,
  url,
  openTab,
}: {
  sectionId: string;
  id: string;
  label: string;
  url: string | undefined;
  /** The open tab this address is, if it is one, as the strip drags it. */
  openTab?: TabDragPayload;
}): TabDragPayload | undefined {
  if (!url) return undefined;
  const chat = parseChatBookmarkUrl(url);
  if (chat)
    return {
      key: `session:${chat.sessionId}`,
      kind: "chat",
      title: label,
      bookmarkUrl: url,
    };
  if (openTab) return openTab;
  return {
    key: `${sectionId}:${id}`,
    kind: "bookmark",
    title: label,
    bookmarkUrl: url,
  };
}
