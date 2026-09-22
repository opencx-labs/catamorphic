import { z } from "zod";

/**
 * Per-site permissions and data, Chrome's "site settings" vocabulary
 * mapped onto Electron's session permission handlers (ADR 0149).
 *
 * A site is an origin (`https://chatgpt.com`). Each permission kind is one
 * of three states: `ask` (the site prompts, the default for anything that
 * reaches a device or the user), `allow`, or `block`. Only explicit
 * choices are stored; a missing entry means the kind's default.
 */

export const SITE_PERMISSION_KINDS = [
  "location",
  "camera",
  "microphone",
  "notifications",
  "clipboard",
  "screenShare",
  "fullscreen",
  "pointerLock",
  "midi",
  "externalApps",
] as const;
export type SitePermissionKind = (typeof SITE_PERMISSION_KINDS)[number];

export const SITE_PERMISSION_STATES = ["ask", "allow", "block"] as const;
export type SitePermissionState = (typeof SITE_PERMISSION_STATES)[number];

export interface SitePermissionDefinition {
  label: string;
  /** What the site gets when allowed, in the prompt's words. */
  ask: string;
  /** Row hint, shown where Chrome shows one. */
  description?: string;
  default: SitePermissionState;
  /** Kinds whose default is `allow` never prompt; `ask` ones can. */
  prompts: boolean;
}

export const SITE_PERMISSIONS: Record<
  SitePermissionKind,
  SitePermissionDefinition
> = {
  location: {
    label: "Location",
    ask: "know your location",
    default: "ask",
    prompts: true,
  },
  camera: {
    label: "Camera",
    ask: "use your camera",
    default: "ask",
    prompts: true,
  },
  microphone: {
    label: "Microphone",
    ask: "use your microphone",
    default: "ask",
    prompts: true,
  },
  notifications: {
    label: "Notifications",
    ask: "send you notifications",
    default: "ask",
    prompts: true,
  },
  clipboard: {
    label: "Clipboard",
    ask: "see text and images copied to the clipboard",
    description: "Reading what you copied. Sites can always copy to it.",
    default: "ask",
    prompts: true,
  },
  screenShare: {
    label: "Screen sharing",
    ask: "share your screen",
    default: "ask",
    prompts: true,
  },
  fullscreen: {
    label: "Fullscreen",
    ask: "go fullscreen",
    default: "allow",
    prompts: false,
  },
  pointerLock: {
    label: "Pointer lock",
    ask: "hide your cursor",
    description: "Games and 3D pages that take over the mouse.",
    default: "allow",
    prompts: false,
  },
  midi: {
    label: "MIDI devices",
    ask: "control and reprogram your MIDI devices",
    default: "ask",
    prompts: true,
  },
  externalApps: {
    label: "Open other apps",
    ask: "open links in another app",
    description: "Links such as zoommtg: or slack: that hand off to an app.",
    default: "ask",
    prompts: true,
  },
};

export const sitePermissionStateSchema = z.enum(SITE_PERMISSION_STATES);
export const sitePermissionKindSchema = z.enum(SITE_PERMISSION_KINDS);

/** Stored choices; kinds at their default are absent. */
export type SitePermissions = Partial<
  Record<SitePermissionKind, SitePermissionState>
>;
export const sitePermissionsSchema = z.record(
  sitePermissionKindSchema,
  sitePermissionStateSchema,
);

/** Stored data keeps what it can: unknown kinds and states are dropped. */
export function sanitizePermissions(value: unknown): SitePermissions {
  const out: SitePermissions = {};
  if (!value || typeof value !== "object") return out;
  for (const [kind, state] of Object.entries(value)) {
    const parsedKind = sitePermissionKindSchema.safeParse(kind);
    const parsedState = sitePermissionStateSchema.safeParse(state);
    if (parsedKind.success && parsedState.success)
      out[parsedKind.data] = parsedState.data;
  }
  return out;
}

export function effectivePermission(
  permissions: SitePermissions,
  kind: SitePermissionKind,
): SitePermissionState {
  return permissions[kind] ?? SITE_PERMISSIONS[kind].default;
}

/** Kinds set away from their default, in catalog order. */
export function customizedKinds(
  permissions: SitePermissions,
): SitePermissionKind[] {
  return SITE_PERMISSION_KINDS.filter(
    (kind) =>
      permissions[kind] !== undefined &&
      permissions[kind] !== SITE_PERMISSIONS[kind].default,
  );
}

/**
 * The site of a page URL: its origin for http(s), null for anything that
 * has no meaningful site (data:, about:, file:).
 */
export function siteOrigin(url: string): string | null {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:"
      ? parsed.origin
      : null;
  } catch {
    return null;
  }
}

/** "https://chatgpt.com" → "chatgpt.com"; keeps a non-default port. */
export function siteHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * Which site permission an Electron permission request is about. `media`
 * covers camera and microphone at once, so one request can map to two
 * kinds; unknown permissions map to none (and are denied).
 */
export function permissionKindsFor(
  permission: string,
  details?: { mediaTypes?: readonly string[] },
): SitePermissionKind[] {
  switch (permission) {
    case "geolocation":
      return ["location"];
    case "media": {
      const kinds: SitePermissionKind[] = [];
      const types = details?.mediaTypes ?? [];
      if (types.includes("audio")) kinds.push("microphone");
      if (types.includes("video")) kinds.push("camera");
      // A media request with no declared types is a device-list check;
      // treat it as both so a block on either holds.
      return kinds.length > 0 ? kinds : ["microphone", "camera"];
    }
    case "mediaKeySystem":
      // DRM playback (Widevine). No user-facing switch, always fine.
      return [];
    case "notifications":
      return ["notifications"];
    case "clipboard-read":
      return ["clipboard"];
    case "clipboard-sanitized-write":
      return [];
    case "display-capture":
      return ["screenShare"];
    case "fullscreen":
      return ["fullscreen"];
    case "pointerLock":
      return ["pointerLock"];
    case "midi":
    case "midiSysex":
      return ["midi"];
    case "openExternal":
      return ["externalApps"];
    default:
      return [];
  }
}

/** Electron permissions that need no choice and are always granted. */
export const ALWAYS_GRANTED_PERMISSIONS: ReadonlySet<string> = new Set([
  "clipboard-sanitized-write",
  "mediaKeySystem",
  "background-sync",
]);

export type SitePermissionDecision =
  | { outcome: "allow" }
  | { outcome: "block" }
  /** Every kind must be asked; the prompt lists them in this order. */
  | { outcome: "ask"; kinds: SitePermissionKind[] };

/**
 * What a request resolves to without a prompt: blocked if any kind the
 * request needs is blocked, allowed only when all are allowed, otherwise
 * ask for the ones still at `ask`.
 */
export function decideSitePermission(
  permissions: SitePermissions,
  permission: string,
  details?: { mediaTypes?: readonly string[] },
): SitePermissionDecision {
  if (ALWAYS_GRANTED_PERMISSIONS.has(permission)) return { outcome: "allow" };
  const kinds = permissionKindsFor(permission, details);
  if (kinds.length === 0) return { outcome: "block" };
  const states = kinds.map((kind) => effectivePermission(permissions, kind));
  if (states.includes("block")) return { outcome: "block" };
  const pending = kinds.filter(
    (kind) => effectivePermission(permissions, kind) === "ask",
  );
  return pending.length === 0
    ? { outcome: "allow" }
    : { outcome: "ask", kinds: pending };
}

/** "use your microphone and camera" */
export function describeRequest(kinds: readonly SitePermissionKind[]): string {
  const parts = kinds.map((kind) => SITE_PERMISSIONS[kind].ask);
  if (parts.length <= 1) return parts[0] ?? "";
  // Camera + microphone share a verb: "use your microphone and camera".
  if (
    kinds.length === 2 &&
    kinds.includes("camera") &&
    kinds.includes("microphone")
  )
    return "use your microphone and camera";
  return `${parts.slice(0, -1).join(", ")} and ${parts.at(-1)}`;
}

/** One site as the Sites page and the modal see it. */
export interface SiteSummary {
  origin: string;
  host: string;
  permissions: SitePermissions;
  /** Cookies whose domain covers this site's host. */
  cookies: number;
  /** Last page visit in this profile's history, if any. */
  lastVisitAt: number | null;
  faviconUrl: string | null;
}

/** OS-level access the app itself has, where the OS gates it (macOS). */
export type SystemMediaAccess = "granted" | "denied" | "not-determined" | null;

export interface SiteDetails extends SiteSummary {
  system: { camera: SystemMediaAccess; microphone: SystemMediaAccess };
}

export interface SitePermissionRequest {
  id: string;
  /** The requesting guest's webContents id (the tab it belongs to). */
  guestId: number;
  origin: string;
  kinds: SitePermissionKind[];
}

export const sitePermissionAnswerSchema = z.object({
  id: z.string().min(1),
  decision: z.enum(["allow", "block"]),
  /** Persist the choice for the site (Chrome's default) or apply it once. */
  remember: z.boolean(),
});
export type SitePermissionAnswer = z.infer<typeof sitePermissionAnswerSchema>;
