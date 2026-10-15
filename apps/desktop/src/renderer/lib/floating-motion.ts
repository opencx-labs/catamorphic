import { useCallback, useEffect, useRef, useState } from "react";
import { motionMs } from "./motion.js";
import { chatTabKey } from "./workspace-state.js";

/** A chat's growth from floating to its tab (chat-dock's duration-250). */
export const CHAT_EXPAND_MS = 250;

interface FrontView {
  identity: string | undefined;
  activeTabKey: string | null | undefined;
  /** Each chat's mode, by local id: "id=mode id=mode". */
  modes: string;
}

/** Chats by what compares across renders: a default workspace is rebuilt. */
function chatModes(
  chats: ReadonlyArray<{ localId: string; mode: string }>,
): string {
  return chats.map((chat) => `${chat.localId}=${chat.mode}`).join(" ");
}

function modesById(modes: string): Map<string, string> {
  return new Map(
    modes.split(" ").map((pair): [string, string] => {
      const [localId = "", mode = ""] = pair.split("=");
      return [localId, mode];
    }),
  );
}

/** What was in front, when `now` is a floating chat grown into its tab. */
function grownOver(was: FrontView, now: FrontView): string | null {
  const front = was.activeTabKey;
  if (was.identity !== now.identity || !front || front === now.activeTabKey)
    return null;
  const before = modesById(was.modes);
  const grew = [...modesById(now.modes)].some(
    ([localId, mode]) =>
      mode === "tab" &&
      chatTabKey(localId) === now.activeTabKey &&
      before.get(localId) === "partial",
  );
  return grew && motionMs(CHAT_EXPAND_MS) > 0 ? front : null;
}

/**
 * A floating chat that becomes a tab grows over what was in front. That
 * surface stays painted, and mounted, beneath it until the chat covers it,
 * instead of vanishing in the frame the chat starts to grow and leaving
 * the bare backdrop around it. Returns its key while it recedes.
 */
export function useRecedingSurface({
  identity,
  activeTabKey,
  chats,
}: {
  /** The workspace (project) it belongs to; a switch drops what recedes. */
  identity: string | undefined;
  activeTabKey: string | null | undefined;
  chats: ReadonlyArray<{ localId: string; mode: string }>;
}): string | null {
  const view: FrontView = { identity, activeTabKey, modes: chatModes(chats) };
  const [seen, setSeen] = useState(view);
  const [receding, setReceding] = useState<string | null>(null);
  // Adjusted in the render that changes what is in front, so the surface
  // is never unmounted, or left unpainted, for a frame first.
  if (
    seen.identity !== view.identity ||
    seen.activeTabKey !== view.activeTabKey ||
    seen.modes !== view.modes
  ) {
    setSeen(view);
    const front = grownOver(seen, view);
    if (front || seen.identity !== view.identity) setReceding(front);
  }
  useEffect(() => {
    if (!receding) return;
    const timer = setTimeout(() => setReceding(null), CHAT_EXPAND_MS);
    return () => clearTimeout(timer);
  }, [receding]);
  return receding;
}

/** Keep the live surface mounted until its paired exit finishes. */
export function useFloatingMotion(identity: string | undefined) {
  const [closing, setClosing] = useState(false);
  const timerRef = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);
  const identityRef = useRef(identity);
  identityRef.current = identity;
  useEffect(() => {
    identityRef.current = identity;
    setClosing(false);
    clearTimeout(timerRef.current);
    timerRef.current = undefined;
    return () => clearTimeout(timerRef.current);
  }, [identity]);
  const dismiss = useCallback((finish: () => void) => {
    if (!identityRef.current) {
      finish();
      return;
    }
    if (timerRef.current !== undefined) return;
    const target = identityRef.current;
    setClosing(true);
    const duration = matchMedia("(prefers-reduced-motion: reduce)").matches
      ? 0
      : 200;
    timerRef.current = setTimeout(() => {
      timerRef.current = undefined;
      if (identityRef.current !== target) return;
      finish();
      setClosing(false);
    }, duration);
  }, []);
  return { closing, dismiss };
}
