import { type ChildProcess, spawn } from "node:child_process";
import { parseBinding } from "../../shared/keybindings.js";

/**
 * macOS virtual key codes (Carbon's `kVK_*`) of the keys a binding can
 * name: a key's place on the keyboard, as Chromium's `code` reads it.
 */
const KEY_CODES: Record<string, number> = {
  A: 0,
  S: 1,
  D: 2,
  F: 3,
  H: 4,
  G: 5,
  Z: 6,
  X: 7,
  C: 8,
  V: 9,
  B: 11,
  Q: 12,
  W: 13,
  E: 14,
  R: 15,
  Y: 16,
  T: 17,
  "1": 18,
  "2": 19,
  "3": 20,
  "4": 21,
  "6": 22,
  "5": 23,
  "=": 24,
  "9": 25,
  "7": 26,
  "-": 27,
  "8": 28,
  "0": 29,
  "]": 30,
  O: 31,
  U: 32,
  "[": 33,
  I: 34,
  P: 35,
  Enter: 36,
  L: 37,
  J: 38,
  "'": 39,
  K: 40,
  ";": 41,
  "\\": 42,
  ",": 43,
  "/": 44,
  N: 45,
  M: 46,
  ".": 47,
  Tab: 48,
  Space: 49,
  "`": 50,
  Backspace: 51,
  Escape: 53,
  F1: 122,
  F2: 120,
  F3: 99,
  F4: 118,
  F5: 96,
  F6: 97,
  F7: 98,
  F8: 100,
  F9: 101,
  F10: 109,
  F11: 103,
  F12: 111,
  F13: 105,
  F14: 107,
  F15: 113,
  F16: 106,
  F17: 64,
  F18: 79,
  F19: 80,
  F20: 90,
  Home: 115,
  End: 119,
  PageUp: 116,
  PageDown: 121,
  Delete: 117,
  ArrowLeft: 123,
  ArrowRight: 124,
  ArrowDown: 125,
  ArrowUp: 126,
};

const MODIFIER_BITS: Record<string, number> = {
  Cmd: 1,
  Ctrl: 2,
  Alt: 4,
  Shift: 8,
};

/** A binding as the helper takes it: a key code and modifier bits. */
export function systemKeysOf(
  binding: string,
): { keyCode: number; modifiers: number } | null {
  const parsed = parseBinding(binding);
  if (!parsed) return null;
  const keyCode =
    KEY_CODES[parsed.key.length === 1 ? parsed.key.toUpperCase() : parsed.key];
  if (keyCode === undefined) return null;
  let modifiers = 0;
  for (const modifier of parsed.modifiers)
    modifiers |= MODIFIER_BITS[modifier] ?? 0;
  return { keyCode, modifiers };
}

/** The app in front and its focused window's title. */
export interface FrontPlace {
  app: string;
  window: string | null;
}

function frontPlaceOf(base64: string): FrontPlace | null {
  try {
    const parsed: unknown = JSON.parse(
      Buffer.from(base64, "base64").toString("utf8"),
    );
    if (typeof parsed !== "object" || parsed === null) return null;
    const app = "app" in parsed ? parsed.app : undefined;
    const window = "window" in parsed ? parsed.window : undefined;
    return typeof app === "string" && app
      ? { app, window: typeof window === "string" && window ? window : null }
      : null;
  } catch {
    return null;
  }
}

/** What the helper says: a shortcut down or up, a send, by name. */
export type SystemKeysEvent =
  | { type: "down"; name: string }
  | { type: "up"; name: string }
  | { type: "send" };

/**
 * Voice's shortcuts in every app, and dictation typed into the app in
 * front (ADR 0236): the `voice-keys` helper (`native/voice-keys`) on an
 * event tap, which needs the app trusted for Accessibility. One helper at
 * a time; it exits when its stdin closes, so it never outlives Work.
 */
export class SystemKeys {
  private child: ChildProcess | null = null;
  /** Each shortcut the helper watches, by name, as it was told. */
  private bound = new Map<string, string>();
  /** Who waits on the helper's answer to `front`, oldest first. */
  private fronts: ((place: FrontPlace | null) => void)[] = [];

  constructor(
    private readonly options: {
      helperPath: string;
      onEvent: (event: SystemKeysEvent) => void;
      /** The helper could not watch the keys: Accessibility is not allowed. */
      onUntrusted: () => void;
      /** The helper stopped on its own: the keys are Work's windows' again. */
      onGone?: () => void;
      spawnImpl?: typeof spawn;
    },
  ) {}

  get running(): boolean {
    return this.child !== null;
  }

  /**
   * Watches these shortcuts in every app, by name; a name left out stops
   * being watched, and none at all stops the helper.
   */
  watch(shortcuts: Record<string, string>): void {
    const wanted = new Map(
      Object.entries(shortcuts).filter(([, binding]) => systemKeysOf(binding)),
    );
    if (wanted.size === 0) {
      this.stop();
      return;
    }
    if (!this.child) {
      this.child = this.launch();
      this.bound = new Map();
    }
    for (const name of this.bound.keys())
      if (!wanted.has(name)) this.write(`bind ${name} -1 0`);
    for (const [name, binding] of wanted) {
      const keys = systemKeysOf(binding);
      if (!keys || this.bound.get(name) === binding) continue;
      this.write(`bind ${name} ${keys.keyCode} ${keys.modifiers}`);
    }
    this.bound = wanted;
  }

  /**
   * A stretch of dictation's words so far, typed where the cursor is in
   * the app in front: each update retypes only the end that changed, and
   * stops once the person types or moves elsewhere.
   */
  dictate(stretch: number, text: string, final: boolean): void {
    this.write(
      `dictate ${stretch} ${final ? 1 : 0} ${Buffer.from(text, "utf8").toString("base64")}`,
    );
  }

  /**
   * The app in front and its window's title, as macOS names them; null
   * when the helper is not running or does not answer in time.
   */
  front(): Promise<FrontPlace | null> {
    if (!this.child) return Promise.resolve(null);
    return new Promise((resolve) => {
      const answer = (place: FrontPlace | null) => {
        clearTimeout(timer);
        resolve(place);
      };
      const timer = setTimeout(() => {
        // The helper still answers, in order: its late answer goes nowhere.
        this.fronts = this.fronts.map((waiting) =>
          waiting === answer ? () => {} : waiting,
        );
        resolve(null);
      }, 500);
      this.fronts.push(answer);
      this.write("front");
    });
  }

  /** Whether Return, pressed alone in the app in front, says `send`. */
  watchSend(on: boolean): void {
    this.write(`send-watch ${on ? 1 : 0}`);
  }

  stop(): void {
    const child = this.child;
    this.child = null;
    this.bound = new Map();
    // A helper started again answers only what it is asked from then on.
    for (const answer of this.fronts.splice(0)) answer(null);
    child?.stdin?.end();
    child?.kill();
  }

  private write(line: string): void {
    if (this.child?.stdin?.writable) this.child.stdin.write(`${line}\n`);
  }

  private launch(): ChildProcess {
    const child = (this.options.spawnImpl ?? spawn)(
      this.options.helperPath,
      [],
      {
        stdio: ["pipe", "pipe", "ignore"],
      },
    );
    let buffered = "";
    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      buffered += chunk;
      let newline = buffered.indexOf("\n");
      while (newline >= 0) {
        const [type, name = ""] = buffered.slice(0, newline).trim().split(" ");
        buffered = buffered.slice(newline + 1);
        if ((type === "down" || type === "up") && name)
          this.options.onEvent({ type, name });
        else if (type === "send") this.options.onEvent({ type });
        else if (type === "front") this.fronts.shift()?.(frontPlaceOf(name));
        else if (type === "untrusted") this.options.onUntrusted();
        newline = buffered.indexOf("\n");
      }
    });
    const gone = () => {
      if (this.child !== child) return;
      this.child = null;
      this.bound = new Map();
      for (const answer of this.fronts.splice(0)) answer(null);
      this.options.onGone?.();
    };
    child.once("exit", gone);
    child.once("error", gone);
    // A write to a helper that just exited must not take Work down.
    child.stdin?.on("error", () => {});
    return child;
  }
}
