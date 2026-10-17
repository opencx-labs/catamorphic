import type { OpenMode } from "../../shared/open-mode.js";
import type { SidebarSourceEffect } from "../../shared/sidebar.js";
import type { Chip } from "./chips.js";

/**
 * What a chat publishes as Work's chips (`work:chips`, ADR 0239): its rows,
 * and how it carries out their own actions (a ✕ forgets a pull request or
 * closes a tab). Published by the chat where it is shown, so the chips and
 * a module reading them run in the window that shows the chat.
 */
export interface ChatChips {
  rows: readonly Chip[];
  act: (request: {
    itemId: string;
    action: string;
    values?: Record<string, string>;
  }) => Promise<SidebarSourceEffect | undefined>;
  /** Open a chip's address as the chat opens its links. */
  open: (url: string, mode: OpenMode) => void;
}

const chats = new Map<
  string,
  { owner: object; chips: ChatChips; signature: string }
>();
const listeners = new Map<string, Set<() => void>>();

const notify = (sessionId: string) => {
  for (const listener of listeners.get(sessionId) ?? []) listener();
};

/** Each chat's chips in this window, by session id. */
export const chipBoard = {
  /**
   * A chat's chips now, from the dock that shows it (`owner`); readers
   * hear only when its rows changed.
   */
  publish({
    sessionId,
    owner,
    chips,
  }: {
    sessionId: string;
    owner: object;
    chips: ChatChips;
  }) {
    const signature = JSON.stringify(chips.rows);
    const before = chats.get(sessionId);
    chats.set(sessionId, { owner, chips, signature });
    if (before?.signature !== signature) notify(sessionId);
  },
  /** The dock let the chat go; another may publish it next. */
  retract({ sessionId, owner }: { sessionId: string; owner: object }) {
    if (chats.get(sessionId)?.owner !== owner) return;
    chats.delete(sessionId);
    notify(sessionId);
  },
  read(sessionId: string): ChatChips | undefined {
    return chats.get(sessionId)?.chips;
  },
  subscribe({
    sessionId,
    listener,
  }: {
    sessionId: string;
    listener: () => void;
  }): () => void {
    const set = listeners.get(sessionId) ?? new Set();
    set.add(listener);
    listeners.set(sessionId, set);
    return () => {
      set.delete(listener);
      if (set.size === 0) listeners.delete(sessionId);
    };
  },
};
