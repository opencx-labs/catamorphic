import { isValidBinding, parseBinding } from "./keybindings.js";

/** User-authored launchers, stored in one profile. Saving never executes them. */
export interface TerminalMacro {
  id: string;
  name: string;
  command: string;
  shortcut: string;
}

export function normalizeTerminalMacros(raw: unknown): TerminalMacro[] {
  if (!Array.isArray(raw)) return [];
  const ids = new Set<string>();
  return raw.flatMap((item: unknown) => {
    if (
      typeof item !== "object" ||
      item === null ||
      !("id" in item) ||
      typeof item.id !== "string" ||
      !item.id.trim() ||
      !("name" in item) ||
      typeof item.name !== "string" ||
      !item.name.trim() ||
      !("command" in item) ||
      typeof item.command !== "string" ||
      !item.command.trim() ||
      ids.has(item.id)
    )
      return [];
    ids.add(item.id);
    const shortcut =
      "shortcut" in item && isValidBinding(item.shortcut) ? item.shortcut : "";
    // Bare typing keys belong to the focused page or shell.
    const parsed = parseBinding(shortcut);
    return [
      {
        id: item.id,
        name: item.name.trim(),
        command: item.command.trim(),
        shortcut:
          parsed && (parsed.modifiers.size > 0 || /^F\d+$/.test(parsed.key))
            ? shortcut
            : "",
      },
    ];
  });
}
