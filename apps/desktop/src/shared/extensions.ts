import { z } from "zod";

/**
 * Chrome extensions in Work's browser (ADR 0203): what the renderer shows
 * of a profile's extensions, their toolbar buttons, side panels and the
 * dialogs that ask the person before an extension gets new access.
 */

export const EXTENSION_ID_PATTERN = /^[a-p]{32}$/;
export const extensionIdSchema = z.string().regex(EXTENSION_ID_PATTERN);

/** The store's home for browsing extensions, in a browser tab. */
export const CHROME_WEB_STORE_URL =
  "https://chromewebstore.google.com/category/extensions";

export function chromeWebStoreDetailUrl(id: string): string {
  return `https://chromewebstore.google.com/detail/${id}`;
}

export type ExtensionSource = "webstore" | "unpacked";

/** Why an installed extension is not running. */
export type ExtensionDisabledReason = "user" | "permissions" | "error";

export interface ExtensionSummary {
  id: string;
  name: string;
  version: string;
  description: string;
  /** A data: URL, so the app (outside the profile session) can show it. */
  iconUrl: string | null;
  enabled: boolean;
  disabledReason: ExtensionDisabledReason | null;
  /** The load or update failure, when there was one. */
  error: string | null;
  source: ExtensionSource;
  /** The folder an unpacked extension loads from. */
  path: string | null;
  manifestVersion: 2 | 3;
  pinned: boolean;
  hasAction: boolean;
  hasOptions: boolean;
  hasSidePanel: boolean;
  /** What it can do, in Chrome's install-prompt words. */
  warnings: string[];
  /** Keyboard shortcuts from its manifest, with the keys Work assigned. */
  commands: ExtensionCommandSummary[];
  /** A newer version that waits for the person to accept new access. */
  pendingUpdate: { version: string; warnings: string[] } | null;
  installedAt: number;
}

export interface ExtensionCommandSummary {
  name: string;
  description: string;
  /** Display form ("⌥⇧D"), or null when unassigned or taken by Work. */
  shortcut: string | null;
}

export interface ExtensionsState {
  profileId: string;
  developerMode: boolean;
  extensions: ExtensionSummary[];
  /** An update check is running. */
  checking: boolean;
  /**
   * Renderers run sandboxed, as extensions' service workers need to reach
   * Work's APIs; false when Work was started with `--no-sandbox`.
   */
  sandboxed: boolean;
}

/** One extension's toolbar button, for a given tab. */
export interface ExtensionActionState {
  extensionId: string;
  name: string;
  title: string;
  iconUrl: string | null;
  badgeText: string;
  /** CSS color. */
  badgeBackground: string;
  badgeTextColor: string | null;
  enabled: boolean;
  hasPopup: boolean;
  pinned: boolean;
}

export interface ExtensionActionsChange {
  profileId: string;
}

/**
 * A question for the person before an extension gains access: adding it,
 * an optional permission it asks for, an update that needs more, or a
 * removal it requested.
 */
export interface ExtensionPrompt {
  id: string;
  kind: "install" | "permissions" | "update" | "remove";
  extensionId: string;
  name: string;
  iconUrl: string | null;
  warnings: string[];
}

export const extensionPromptAnswerSchema = z.object({
  id: z.string().min(1).max(100),
  accept: z.boolean(),
});
export type ExtensionPromptAnswer = z.infer<typeof extensionPromptAnswerSchema>;

/** Shown once an install finishes, anchored to the extensions menu. */
export interface ExtensionInstalled {
  extensionId: string;
  name: string;
  iconUrl: string | null;
  hasAction: boolean;
}

/** An extension page in the browser's side panel, for one tab. */
export interface ExtensionSidePanel {
  guestId: number;
  extensionId: string;
  name: string;
  iconUrl: string | null;
  url: string;
}

/** A tab an extension controls through the page debugger. */
export interface ExtensionDebugging {
  guestId: number;
  extensions: { id: string; name: string }[];
}

/**
 * One project's browser tabs in a window. A window keeps a project mounted
 * for each one opened in it; their reports together are its tabs, and the
 * project in front names the active one.
 */
export const extensionTabsReportSchema = z.object({
  reporter: z.string().min(1).max(100),
  visible: z.boolean(),
  guestIds: z.array(z.number().int().positive()).max(5000),
  activeGuestId: z.number().int().positive().nullable(),
});
export type ExtensionTabsReport = z.infer<typeof extensionTabsReportSchema>;

/** What main asks a window to do for an extension. */
export type ExtensionWindowRequest =
  | { kind: "create-tab"; url: string; active: boolean }
  | { kind: "select-tab"; guestId: number }
  | { kind: "close-tab"; guestId: number }
  | {
      kind: "open-popup";
      extensionId: string;
      guestId: number | null;
      url: string;
    }
  | { kind: "open-extensions" };

export interface ExtensionWindowRequestEnvelope {
  id: number;
  request: ExtensionWindowRequest;
}

export const extensionWindowResponseSchema = z.object({
  id: z.number().int(),
  result: z
    .object({ guestId: z.number().int().positive().optional() })
    .nullable(),
});

/** A view of an extension page the window shows (popup or side panel). */
export const extensionViewSchema = z.object({
  guestId: z.number().int().positive(),
  extensionId: extensionIdSchema,
  kind: z.enum(["popup", "side-panel"]),
  /** The browser tab the view belongs to. */
  tabGuestId: z.number().int().positive().nullable(),
});
export type ExtensionView = z.infer<typeof extensionViewSchema>;

/** The popup a toolbar click opens, or null when the click was handled. */
export interface ExtensionActionResult {
  popupUrl: string | null;
}

export {
  EXTENSION_CHANNELS,
  type ExtensionCallAnswer,
  WEBSTORE_METHODS,
  type WebStoreMethod,
} from "./extension-channels.js";
