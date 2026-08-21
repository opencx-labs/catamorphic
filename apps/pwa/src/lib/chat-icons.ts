/**
 * The curated conversation-icon vocabulary (Linear's team-icon model):
 * abstract, simple glyphs plus a small palette that sits well on every
 * theme. Agents pick from exactly this set via the `set_chat_icon`
 * workspace tool; the value is stored on the session as "<name>:<color>".
 *
 * Plain data, no React/lucide imports — main (tool schema) and the
 * renderer (glyph lookup) both consume it. The renderer maps names to
 * lucide components in components/chat-icon.tsx; adding a name here
 * means adding it to that map too.
 */
export const CHAT_ICON_NAMES = [
  "sparkles",
  "zap",
  "rocket",
  "flame",
  "bug",
  "wrench",
  "flask",
  "book",
  "globe",
  "terminal",
  "database",
  "chart",
  "palette",
  "shield",
  "key",
  "bell",
  "calendar",
  "mail",
  "layers",
  "box",
  "star",
  "lightbulb",
  "target",
  "compass",
  "map",
  "cloud",
  "code",
  "branch",
  "search",
  "heart",
] as const;

export type ChatIconName = (typeof CHAT_ICON_NAMES)[number];

/**
 * Color ids → CSS values. Semantic tokens where one fits (they follow
 * the user's theme); the rest are fixed mid-tone hues legible on dark
 * and light backgrounds.
 */
export const CHAT_ICON_COLORS = {
  gray: "var(--color-fg-muted)",
  orange: "var(--color-accent)",
  blue: "var(--color-info)",
  green: "var(--color-success)",
  red: "var(--color-danger)",
  purple: "#9d87cf",
  teal: "#63b3ab",
  yellow: "#c9b458",
} as const;

export type ChatIconColor = keyof typeof CHAT_ICON_COLORS;

export const CHAT_ICON_COLOR_IDS = Object.keys(
  CHAT_ICON_COLORS,
) as ChatIconColor[];

export interface ChatIcon {
  name: ChatIconName;
  color: ChatIconColor;
}

/** Parse a stored "<name>:<color>"; unknown parts → null (default glyph). */
export function parseChatIcon(
  value: string | null | undefined,
): ChatIcon | null {
  if (!value) return null;
  const [name, color] = value.split(":", 2);
  if (!CHAT_ICON_NAMES.includes(name as ChatIconName)) return null;
  const resolvedColor = CHAT_ICON_COLOR_IDS.includes(color as ChatIconColor)
    ? (color as ChatIconColor)
    : "gray";
  return { name: name as ChatIconName, color: resolvedColor };
}
