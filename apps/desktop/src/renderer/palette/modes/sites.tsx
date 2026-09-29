import { Globe, SlidersHorizontal } from "lucide-react";
import { useCallback, useMemo } from "react";
import { BUILTIN_PALETTE_TRIGGERS } from "../../../shared/palette.js";
import { SiteFavicon } from "../../components/site-favicon.js";
import { desktopApi } from "../../lib/desktop-api.js";
import { summarizePermissions } from "../../lib/site-settings.js";
import { usePaletteHost } from "../host.js";
import type { PaletteItem, PaletteMode } from "../types.js";

/**
 * Every site this profile has settings or history for; Enter opens its
 * permissions and data. The focused tab's site leads.
 */
export function useSitesMode(): PaletteMode {
  const {
    profileId,
    focusedSite = null,
    onOpenSiteSettings,
  } = usePaletteHost();
  const loadSites = useCallback(async () => {
    const sites = await desktopApi.siteSettingsList();
    const focused = focusedSite?.origin;
    return {
      items: [...sites]
        .sort(
          (a, b) =>
            Number(b.origin === focused) - Number(a.origin === focused) ||
            (b.lastVisitAt ?? 0) - (a.lastVisitAt ?? 0),
        )
        .map(
          (site): PaletteItem => ({
            id: `site:${site.origin}`,
            icon: Globe,
            iconNode: (
              <SiteFavicon
                url={site.origin}
                faviconUrl={site.faviconUrl}
                className="size-4"
              />
            ),
            label: site.host,
            detail:
              summarizePermissions(site.permissions).join(" · ") ||
              (site.cookies
                ? `${site.cookies} cookie${site.cookies === 1 ? "" : "s"}`
                : "Default settings"),
            keywords: [site.origin],
            kind: "action",
            usage: `site:${site.origin}`,
            run: () => onOpenSiteSettings?.(site.origin),
          }),
        ),
    };
  }, [focusedSite?.origin, onOpenSiteSettings]);

  return useMemo(
    () => ({
      id: "sites",
      chip: "Sites",
      icon: SlidersHorizontal,
      label: "Search sites",
      description: "Open a site's permissions and data",
      placeholder: "Search sites…",
      names: profileId ? BUILTIN_PALETTE_TRIGGERS.sites : undefined,
      rows: {
        kind: "load",
        key: `sites:${profileId}`,
        filtered: false,
        empty: "No sites yet",
        load: loadSites,
      },
    }),
    [profileId, loadSites],
  );
}
