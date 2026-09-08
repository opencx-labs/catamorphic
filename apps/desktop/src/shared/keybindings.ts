export interface ShortcutEvent {
  key: string;
  code?: string;
  metaKey: boolean;
  ctrlKey: boolean;
  altKey: boolean;
  shiftKey: boolean;
}

const MODIFIERS = ["Cmd", "Ctrl", "Alt", "Shift"];
const NAMED_KEYS = new Set([
  "Enter",
  "Escape",
  "Tab",
  "Space",
  "Backspace",
  "Delete",
  "Insert",
  "Home",
  "End",
  "PageUp",
  "PageDown",
  "ArrowUp",
  "ArrowDown",
  "ArrowLeft",
  "ArrowRight",
  "Plus",
]);

export function parseBinding(binding: string) {
  if (!binding) return null;
  const parts = binding.endsWith("++")
    ? [...binding.slice(0, -2).split("+"), "Plus"]
    : binding.split("+");
  const key = parts.pop() ?? "";
  const modifiers = new Set(parts);
  if (
    modifiers.size !== parts.length ||
    parts.some((part) => !MODIFIERS.includes(part)) ||
    !(
      /^[^\s+]$/u.test(key) ||
      NAMED_KEYS.has(key) ||
      /^F([1-9]|1\d|2[0-4])$/.test(key)
    )
  )
    return null;
  return { key, modifiers };
}

/** An empty binding deliberately disables an action's shortcut. */
export function isValidBinding(value: unknown): value is string {
  return (
    typeof value === "string" && (value === "" || parseBinding(value) !== null)
  );
}

const CODE_KEYS: Record<string, string> = {
  BracketLeft: "[",
  BracketRight: "]",
  Backslash: "\\",
  Comma: ",",
  Period: ".",
  Slash: "/",
  Semicolon: ";",
  Quote: "'",
  Backquote: "`",
  Minus: "-",
  Equal: "=",
};

function physicalKey(code: string | undefined): string | undefined {
  if (!code) return undefined;
  if (/^Key[A-Z]$/.test(code)) return code.slice(3);
  if (/^Digit[0-9]$/.test(code)) return code.slice(5);
  return CODE_KEYS[code];
}

export function matchesShortcut({
  event,
  binding,
  mac,
}: {
  event: ShortcutEvent;
  binding: string;
  mac: boolean;
}): boolean {
  const parsed = parseBinding(binding);
  if (!parsed) return false;
  const { key, modifiers } = parsed;
  const command = modifiers.has("Cmd");
  if (event.metaKey !== (command && mac)) return false;
  if (event.ctrlKey !== (modifiers.has("Ctrl") || (command && !mac)))
    return false;
  if (event.altKey !== modifiers.has("Alt")) return false;
  if (event.shiftKey !== modifiers.has("Shift")) return false;
  const expected = key === "Space" ? " " : key === "Plus" ? "+" : key;
  if (event.key.toLowerCase() === expected.toLowerCase()) return true;
  // Option and Shift can change the character produced by a physical key.
  return Boolean(
    (event.metaKey || event.ctrlKey || event.altKey) &&
      physicalKey(event.code)?.toLowerCase() === expected.toLowerCase(),
  );
}

export function bindingFromEvent(event: ShortcutEvent): string | null {
  const key = event.altKey ? (physicalKey(event.code) ?? event.key) : event.key;
  const binding = [
    ...(event.metaKey ? ["Cmd"] : []),
    ...(event.ctrlKey ? ["Ctrl"] : []),
    ...(event.altKey ? ["Alt"] : []),
    ...(event.shiftKey ? ["Shift"] : []),
    key === " "
      ? "Space"
      : key === "+"
        ? "Plus"
        : key.length === 1
          ? key.toUpperCase()
          : key,
  ].join("+");
  return isValidBinding(binding) ? binding : null;
}
