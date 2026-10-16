import { Circle } from "lucide-react";
import { parseChatBookmarkUrl } from "../../shared/bookmark-target.js";
import { parseChatIcon } from "../../shared/chat-icons.js";
import { lucideIcon } from "../lib/lucide-icon.js";
import { ChatGlyph } from "./chat-icon.js";
import { SiteFavicon } from "./site-favicon.js";

const IMAGE = /^(https?:|data:image\/)/i;

/**
 * A row's icon, the same for Work's rows and a person's (ADR 0234): a Lucide
 * name, a chat glyph (`<name>:<color>`), or an image address. Without one,
 * the row's address picks it: a chat's glyph, a page's favicon.
 */
export function RowIcon({
  icon,
  url,
  tile = false,
}: {
  icon?: string;
  url?: string;
  tile?: boolean;
}) {
  const size = tile ? "size-4" : "size-3.5";
  if (icon && IMAGE.test(icon))
    return <SiteFavicon url={url ?? icon} faviconUrl={icon} className={size} />;
  if (icon && parseChatIcon(icon))
    return <ChatGlyph icon={icon} className={`${size} shrink-0`} />;
  const Named = lucideIcon(icon);
  if (Named)
    return (
      <Named className={`${size} shrink-0 text-fg-faint`} aria-hidden="true" />
    );
  if (url && parseChatBookmarkUrl(url))
    return <ChatGlyph className={`${size} shrink-0 text-fg-faint`} />;
  if (url && /^https?:/i.test(url))
    return <SiteFavicon url={url} className={size} />;
  return (
    <Circle className={`${size} shrink-0 text-fg-faint`} aria-hidden="true" />
  );
}
