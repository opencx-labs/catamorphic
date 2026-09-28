import { siteOrigin } from "../shared/site-settings.js";

export type ColorScheme = "light" | "dark";

/** Icons pages declare can be inline images; anything larger is not kept. */
const MAX_ICON_URL_LENGTH = 64 * 1024;

/**
 * The icon each site's tabs show, per color scheme the page saw. Sites
 * declare a dark and a light icon (GitHub's `/favicon.ico` is a dark mark
 * that vanishes on a dark surface), and Chromium hands the tab the one for
 * the current scheme. History keeps one icon per page and skips sign-in
 * pages entirely, so the site's own surfaces (site settings, the Sites
 * page, the share picker) would otherwise fall back to an icon made for
 * the other scheme. Kept in memory only: it records nothing history does
 * not already keep.
 */
export class SiteIcons {
  private readonly icons = new Map<
    string,
    Map<string, Partial<Record<ColorScheme, string>>>
  >();

  /** The site whose icon for this scheme changed, if one did. */
  observe(input: {
    profileId: string;
    pageUrl: string;
    iconUrl: string;
    scheme: ColorScheme;
  }): string | null {
    const origin = siteOrigin(input.pageUrl);
    if (!origin || !usableIcon(input.iconUrl)) return null;
    const sites = this.icons.get(input.profileId) ?? new Map();
    this.icons.set(input.profileId, sites);
    const icons = sites.get(origin) ?? {};
    if (icons[input.scheme] === input.iconUrl) return null;
    sites.set(origin, { ...icons, [input.scheme]: input.iconUrl });
    return origin;
  }

  /** The icon for the scheme, else the site's icon for the other one. */
  get(profileId: string, origin: string, scheme: ColorScheme): string | null {
    const icons = this.icons.get(profileId)?.get(origin);
    if (!icons) return null;
    return icons[scheme] ?? icons[scheme === "dark" ? "light" : "dark"] ?? null;
  }

  releaseProfile(profileId: string): void {
    this.icons.delete(profileId);
  }
}

function usableIcon(url: string): boolean {
  if (url.length > MAX_ICON_URL_LENGTH) return false;
  if (url.startsWith("data:image/")) return true;
  return siteOrigin(url) !== null;
}
