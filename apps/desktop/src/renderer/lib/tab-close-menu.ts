import type { ContextMenuEntry } from "../components/menu.js";
import type { TabCloseScope } from "./workspace-state.js";
import { tabKey, type WorkspaceTab } from "./workspace-types.js";

interface TabGroupShape {
  parentKey: string;
  memberKeys: readonly string[];
  collapsed?: boolean;
}

const groupOf = (key: string, groups: readonly TabGroupShape[]) =>
  groups.find(
    (group) => group.parentKey === key || group.memberKeys.includes(key),
  );

/**
 * Pinning from a tab's menu, wherever the tab is listed (ADR 0318). A tab an
 * agent holds under its chat says why it cannot be pinned.
 */
export function tabPinEntries({
  key,
  pinned,
  blocker,
}: {
  key: string;
  pinned: boolean;
  /** Why the tab cannot be pinned, from `pinBlocker`. */
  blocker?: string;
}): ContextMenuEntry[] {
  // A New Tab closes once left: there is nothing to keep.
  if (key.startsWith("palette:") && !pinned) return [];
  const noun = key.startsWith("chat:") ? "chat" : "tab";
  return [
    pinned
      ? { label: `Unpin ${noun}`, action: "unpin-tab" }
      : {
          label: `Pin ${noun}`,
          action: "pin-tab",
          ...(blocker ? { disabledReason: blocker } : {}),
        },
  ];
}

/** Whether a picked entry pins (true) or unpins (false); undefined otherwise. */
export const tabPinRequest = (action: string): boolean | undefined =>
  action === "pin-tab" ? true : action === "unpin-tab" ? false : undefined;

/**
 * The ways to close from a tab's menu, wherever the tab is listed. A chat
 * and each tab under it offer the group's. A folded chat has no "Close chat":
 * its close takes what is folded behind it, as "Close chat and its tabs" says.
 * With tabs pinned, closing everything leaves them, and says so.
 */
export function tabCloseEntries({
  key,
  tabs,
  groups,
}: {
  key: string;
  /** The tabs listed beside this one, itself included. */
  tabs: readonly WorkspaceTab[];
  groups: readonly TabGroupShape[];
}): ContextMenuEntry[] {
  const group = groupOf(key, groups);
  const isChat = key.startsWith("chat:");
  const pinned = tabs.filter((tab) => tab.pinned);
  const unpinned = tabs.length - pinned.length;
  const closesOthers = pinned.some((tab) => tabKey(tab) === key)
    ? unpinned > 0
    : unpinned > 1 || Boolean(group);
  return [
    ...(isChat && group?.collapsed
      ? []
      : [{ label: isChat ? "Close chat" : "Close tab", action: "close" }]),
    ...(group
      ? [
          { label: "Close tabs under chat", action: "close-chat-tabs" },
          { label: "Close chat and its tabs", action: "close-chat-and-tabs" },
        ]
      : []),
    ...(closesOthers
      ? [
          {
            label: pinned.length > 0 ? "Close unpinned tabs" : "Close all tabs",
            action: "close-all-tabs",
          },
        ]
      : []),
  ];
}

/** What a picked entry closes; undefined for an action that is not a close. */
export function tabCloseRequest({
  action,
  key,
  groups,
}: {
  action: string;
  key: string;
  groups: readonly TabGroupShape[];
}): { key: string; scope?: TabCloseScope } | undefined {
  if (action === "close") return { key };
  if (action === "close-all-tabs") return { key, scope: "all" };
  const parentKey = groupOf(key, groups)?.parentKey;
  if (!parentKey) return undefined;
  if (action === "close-chat-tabs")
    return { key: parentKey, scope: "chat-tabs" };
  if (action === "close-chat-and-tabs")
    return { key: parentKey, scope: "chat-and-tabs" };
  return undefined;
}
