import { isValidBinding } from "../../shared/keybindings.js";
import type { Manifest } from "./manifest.js";

/**
 * Extension keyboard commands (ADR 0203). A manifest suggests keys per
 * platform in Chrome's accelerator form; Work turns them into its own
 * binding form (`Cmd` is Command on macOS and Ctrl elsewhere, as Chrome's
 * `Ctrl` is) and assigns one only when no Work shortcut or earlier
 * extension already has it.
 */

export interface ManifestCommand {
  name: string;
  description: string;
  /** The suggested key in Work's binding form, or null. */
  binding: string | null;
}

const KEY_NAMES: Record<string, string> = {
  Comma: ",",
  Period: ".",
  Space: "Space",
  Home: "Home",
  End: "End",
  PageUp: "PageUp",
  PageDown: "PageDown",
  Insert: "Insert",
  Delete: "Delete",
  Up: "ArrowUp",
  Down: "ArrowDown",
  Left: "ArrowLeft",
  Right: "ArrowRight",
};

/** Chrome accelerator ("Ctrl+Shift+Period") → Work binding ("Cmd+Shift+."). */
export function bindingFromAccelerator(
  accelerator: string,
  mac: boolean,
): string | null {
  const parts = accelerator.split("+").map((part) => part.trim());
  const key = parts.pop() ?? "";
  const modifiers = new Set<string>();
  for (const part of parts) {
    if (part === "Ctrl" || (part === "Command" && mac)) modifiers.add("Cmd");
    else if (part === "MacCtrl" && mac) modifiers.add("Ctrl");
    else if (part === "Alt") modifiers.add("Alt");
    else if (part === "Shift") modifiers.add("Shift");
    else return null;
  }
  // Chrome requires Ctrl or Alt in an extension shortcut.
  if (!modifiers.has("Cmd") && !modifiers.has("Ctrl") && !modifiers.has("Alt"))
    return null;
  let name: string | null = null;
  if (/^[A-Z0-9]$/.test(key)) name = key;
  else if (/^F([1-9]|1[0-2])$/.test(key)) name = key;
  else name = KEY_NAMES[key] ?? null;
  if (!name) return null;
  const binding = [
    ...["Cmd", "Ctrl", "Alt", "Shift"].filter((modifier) =>
      modifiers.has(modifier),
    ),
    name,
  ].join("+");
  return isValidBinding(binding) ? binding : null;
}

export function manifestCommands(
  manifest: Manifest,
  platform: NodeJS.Platform,
  localize: (text: string) => string,
): ManifestCommand[] {
  const commands = manifest.commands;
  if (!commands || typeof commands !== "object" || Array.isArray(commands))
    return [];
  const platformKey =
    platform === "darwin" ? "mac" : platform === "win32" ? "windows" : "linux";
  const out: ManifestCommand[] = [];
  for (const [name, value] of Object.entries(commands)) {
    if (!value || typeof value !== "object") continue;
    const command = value as Record<string, unknown>;
    const suggested = command.suggested_key;
    let accelerator: string | null = null;
    if (typeof suggested === "string") accelerator = suggested;
    else if (suggested && typeof suggested === "object") {
      const keys = suggested as Record<string, unknown>;
      const pick = keys[platformKey] ?? keys.default;
      accelerator = typeof pick === "string" ? pick : null;
    }
    const description =
      typeof command.description === "string"
        ? localize(command.description)
        : name === "_execute_action" ||
            name === "_execute_browser_action" ||
            name === "_execute_page_action"
          ? "Activate the extension"
          : name;
    out.push({
      name,
      description,
      binding: accelerator
        ? bindingFromAccelerator(accelerator, platform === "darwin")
        : null,
    });
  }
  return out;
}

/** Commands that run the extension's toolbar action. */
export function isActionCommand(name: string): boolean {
  return (
    name === "_execute_action" ||
    name === "_execute_browser_action" ||
    name === "_execute_page_action"
  );
}
