import type { LucideIcon } from "lucide-react";
import {
  Bell,
  Camera,
  Clipboard,
  ExternalLink,
  MapPin,
  Maximize,
  Mic,
  MousePointer2,
  Music,
  ScreenShare,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  customizedKinds,
  SITE_PERMISSIONS,
  type SiteDetails,
  type SitePermissionKind,
  type SitePermissionState,
  type SitePermissions,
  type SiteSummary,
} from "../../shared/site-settings.js";
import { desktopApi } from "./desktop-api.js";

export const SITE_PERMISSION_ICONS: Record<SitePermissionKind, LucideIcon> = {
  location: MapPin,
  camera: Camera,
  microphone: Mic,
  notifications: Bell,
  clipboard: Clipboard,
  screenShare: ScreenShare,
  fullscreen: Maximize,
  pointerLock: MousePointer2,
  midi: Music,
  externalApps: ExternalLink,
};

export const STATE_LABELS: Record<SitePermissionState, string> = {
  ask: "Ask",
  allow: "Allow",
  block: "Block",
};

/** "Camera allowed · Microphone blocked" for a site row. */
export function summarizePermissions(permissions: SitePermissions): string[] {
  return customizedKinds(permissions).map(
    (kind) =>
      `${SITE_PERMISSIONS[kind].label} ${
        permissions[kind] === "allow" ? "allowed" : "blocked"
      }`,
  );
}

/**
 * One site's details, kept current: any change to the site (from this
 * modal, another window, or a prompt answered elsewhere) reloads it.
 */
export function useSiteDetails(origin: string | null): {
  details: SiteDetails | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [details, setDetails] = useState<SiteDetails | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    if (!origin) return;
    try {
      const next = await desktopApi.siteSettingsGet({ origin });
      setDetails(next);
      setError(null);
    } catch {
      setError("Could not read this site's settings.");
    }
  }, [origin]);
  useEffect(() => {
    setDetails(null);
    setError(null);
    if (!origin) return;
    void refresh();
    return desktopApi.onSiteSettingsChanged((change) => {
      if (change.origin === null || change.origin === origin) void refresh();
    });
  }, [origin, refresh]);
  return { details, error, refresh };
}

/** Every site the profile knows, kept current the same way. */
export function useSites(enabled: boolean): {
  sites: SiteSummary[] | null;
  error: string | null;
  refresh: () => Promise<void>;
} {
  const [sites, setSites] = useState<SiteSummary[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const refresh = useCallback(async () => {
    try {
      setSites(await desktopApi.siteSettingsList());
      setError(null);
    } catch {
      setError("Could not list sites.");
    }
  }, []);
  useEffect(() => {
    if (!enabled) return;
    void refresh();
    return desktopApi.onSiteSettingsChanged(() => void refresh());
  }, [enabled, refresh]);
  return { sites, error, refresh };
}
