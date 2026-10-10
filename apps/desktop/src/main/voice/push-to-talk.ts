import {
  app,
  type Event as ElectronEvent,
  type Input,
  type WebContents,
  webContents,
} from "electron";
import { matchesShortcut, parseBinding } from "../../shared/keybindings.js";

/**
 * Push to talk's keys (ADR 0215), read in `before-input-event` of every
 * window and web page, so holding them talks wherever focus is. They are
 * never cancelled there: Chromium would then drop the key's release too.
 * The window's shortcuts and a page's preload swallow them instead, only
 * while push to talk is on.
 */
export function listenForPushToTalk(deps: {
  /**
   * The keys of the profile a window or page belongs to, while push to
   * talk is on for it.
   */
  keysFor(contents: WebContents): { profileId: string; binding: string } | null;
  down(profileId: string): void;
  up(): void;
}): () => void {
  const mac = process.platform === "darwin";
  let held: string | null = null;
  const release = () => {
    if (held === null) return;
    held = null;
    deps.up();
  };
  const onInput =
    (contents: WebContents) => (_event: ElectronEvent, input: Input) => {
      if (input.type === "keyUp") {
        if (held !== null && endsHold(held, input)) release();
        return;
      }
      if (input.type !== "keyDown" || input.isAutoRepeat || held !== null)
        return;
      const keys = deps.keysFor(contents.hostWebContents ?? contents);
      if (
        !keys ||
        !matchesShortcut({
          event: shortcutOf(input),
          binding: keys.binding,
          mac,
        })
      )
        return;
      held = keys.binding;
      deps.down(keys.profileId);
    };
  const listening = new Map<WebContents, ReturnType<typeof onInput>>();
  const listen = (contents: WebContents) => {
    if (listening.has(contents)) return;
    const listener = onInput(contents);
    listening.set(contents, listener);
    contents.on("before-input-event", listener);
    contents.once("destroyed", () => listening.delete(contents));
  };
  for (const contents of webContents.getAllWebContents()) listen(contents);
  const onCreated = (_event: unknown, contents: WebContents) =>
    listen(contents);
  app.on("web-contents-created", onCreated);
  // A key that comes up in another app never reaches Work.
  app.on("browser-window-blur", release);
  return () => {
    app.off("web-contents-created", onCreated);
    app.off("browser-window-blur", release);
    for (const [contents, listener] of listening)
      if (!contents.isDestroyed()) contents.off("before-input-event", listener);
    listening.clear();
  };
}

/** An Electron key event as the keybinding matcher reads it. */
function shortcutOf(input: Input) {
  return {
    key: input.key,
    code: input.code,
    metaKey: input.meta,
    ctrlKey: input.control,
    altKey: input.alt,
    shiftKey: input.shift,
  };
}

/** Whether a key coming up ends a hold: the binding's key, or a modifier of it. */
export function endsHold(
  binding: string,
  input: Pick<Input, "key" | "code">,
): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return true;
  const modifierKeys: Record<string, string[]> = {
    Cmd: ["Meta", "Control"],
    Ctrl: ["Control"],
    Alt: ["Alt"],
    Shift: ["Shift"],
  };
  if (
    [...parsed.modifiers].some((modifier) =>
      modifierKeys[modifier]?.includes(input.key),
    )
  )
    return true;
  const key = parsed.key === "Space" ? " " : parsed.key.toLowerCase();
  const code = parsed.key === "Space" ? "space" : `key${key}`;
  return input.key.toLowerCase() === key || input.code.toLowerCase() === code;
}
