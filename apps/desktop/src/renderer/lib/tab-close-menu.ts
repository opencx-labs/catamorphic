import type { ContextMenuEntry } from "../components/menu.js";
import type { TabCloseScope } from "./workspace-state.js";

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
 * The ways to close from a tab's menu, wherever the tab is listed. A chat
 * and each tab under it offer the group's. A folded chat has no "Close chat":
 * its close takes what is folded behind it, as "Close chat and its tabs" says.
 */
export function tabCloseEntries({
  key,
  tabCount,
  groups,
}: {
  key: string;
  /** The tabs listed beside this one, itself included. */
  tabCount: number;
  groups: readonly TabGroupShape[];
}): ContextMenuEntry[] {
  const group = groupOf(key, groups);
  const isChat = key.startsWith("chat:");
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
    ...(tabCount > 1 || group
      ? [{ label: "Close all tabs", action: "close-all-tabs" }]
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
