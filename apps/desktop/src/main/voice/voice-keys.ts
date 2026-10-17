import {
  app,
  type Event as ElectronEvent,
  type Input,
  type WebContents,
  webContents,
} from "electron";
import { matchesShortcut, parseBinding } from "../../shared/keybindings.js";
import { VOICE_ACTIONS, type VoiceAction } from "../../shared/voice.js";

/**
 * Voice's shortcuts in Work's own windows and pages (ADR 0216, 0236), read
 * in `before-input-event` of every web contents, so they work wherever
 * focus is in Work. They are never cancelled there: Chromium would then
 * drop the key's release too. The window's shortcut dispatcher and a page's
 * preload swallow them instead. Elsewhere, the `voice-keys` helper reads
 * them (`system-keys.ts`).
 */
export function listenForVoiceKeys(deps: {
  /** The profile a window or page belongs to, and its voice shortcuts. */
  keysFor(contents: WebContents): {
    profileId: string;
    shortcuts: Partial<Record<VoiceAction, string>>;
  };
  down(profileId: string, action: VoiceAction, contents: WebContents): void;
  up(action: VoiceAction): void;
}): () => void {
  const mac = process.platform === "darwin";
  let held: { action: VoiceAction; binding: string } | null = null;
  const release = () => {
    if (!held) return;
    const { action } = held;
    held = null;
    deps.up(action);
  };
  const onInput =
    (contents: WebContents) => (_event: ElectronEvent, input: Input) => {
      if (input.type === "keyUp") {
        if (held && endsHold(held.binding, input)) release();
        return;
      }
      if (input.type !== "keyDown" || input.isAutoRepeat || held) return;
      const { profileId, shortcuts } = deps.keysFor(
        contents.hostWebContents ?? contents,
      );
      for (const action of VOICE_ACTIONS) {
        const binding = shortcuts[action];
        if (
          !binding ||
          !matchesShortcut({ event: shortcutOf(input), binding, mac })
        )
          continue;
        held = { action, binding };
        deps.down(profileId, action, contents.hostWebContents ?? contents);
        return;
      }
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
