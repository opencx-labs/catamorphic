import type { ChatEvent, DockData } from "../../shared/desktop-workspace.js";

/** Synchronous local presentation; main arbitrates identity and remote windows. */
interface Presentations {
  chats: DockData[];
  pendingActivation?: string;
}
let snapshot: Presentations = { chats: [] };
const listeners = new Set<() => void>();
const handlers = new Map<string, (event: ChatEvent) => void>();
const emit = () => {
  for (const listener of listeners) listener();
};
export const localPresentations = {
  getSnapshot: () => snapshot,
  subscribe: (listener: () => void) => {
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  },
  publish(data: DockData) {
    const previous = snapshot.chats.find(
      (chat) => chat.entry.localId === data.entry.localId,
    );
    const activate =
      data.entry.mode === "partial" &&
      (previous?.entry.mode !== "partial" ||
        (data.selected && !previous?.selected));
    snapshot = {
      chats: previous
        ? snapshot.chats.map((chat) =>
            chat.entry.localId === data.entry.localId
              ? { ...data, local: true }
              : chat,
          )
        : [...snapshot.chats, { ...data, local: true }],
      pendingActivation: activate
        ? data.entry.localId
        : data.entry.mode === "min" &&
            snapshot.pendingActivation === data.entry.localId
          ? undefined
          : snapshot.pendingActivation,
    };
    emit();
  },
  remove(localId: string) {
    snapshot = {
      chats: snapshot.chats.filter((chat) => chat.entry.localId !== localId),
      pendingActivation:
        snapshot.pendingActivation === localId
          ? undefined
          : snapshot.pendingActivation,
    };
    handlers.delete(localId);
    emit();
  },
  acknowledge(localId?: string) {
    if (!snapshot.pendingActivation || snapshot.pendingActivation !== localId)
      return;
    snapshot = { ...snapshot, pendingActivation: undefined };
    emit();
  },
  handle(localId: string, handler: (event: ChatEvent) => void) {
    handlers.set(localId, handler);
  },
  invoke(localId: string, event: ChatEvent) {
    const handler = handlers.get(localId);
    if (!handler) return false;
    handler(event);
    return true;
  },
};
