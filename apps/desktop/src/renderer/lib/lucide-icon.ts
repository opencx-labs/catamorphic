import * as lucide from "lucide-react";

const ICONS: ReadonlySet<unknown> = new Set(Object.values(lucide.icons));

/**
 * Every name that resolves to a Lucide icon: the canonical table plus the
 * package's alias exports (`MessageCircleQuestion` for
 * `MessageCircleQuestionMark`, `Icon`-suffixed forms). Aliases point at the
 * same component, so membership in the table is the test; non-icon exports
 * such as the generic `Icon` never qualify.
 */
const BY_NAME: ReadonlyMap<string, lucide.LucideIcon> = new Map(
  Object.entries(lucide).filter((entry): entry is [string, lucide.LucideIcon] =>
    ICONS.has(entry[1]),
  ),
);

/**
 * A Lucide icon by the name an agent wrote (sidebar.js, a command, a tab).
 * Unknown names resolve to nothing so callers fall back to their own default
 * glyph — a name must never reach the screen as text, and a name must never
 * render something that is not an icon.
 */
export function lucideIcon(name?: string): lucide.LucideIcon | undefined {
  return name ? BY_NAME.get(name) : undefined;
}
