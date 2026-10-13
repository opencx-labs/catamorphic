import { z } from "zod";
import {
  PAGE_DIALOG_MESSAGE_LIMIT,
  SCRIPT_DIALOG_KINDS,
  type ScriptDialogKind,
} from "./script-dialogs.js";

/**
 * What a page in a browser tab asks through Work's own dialogs (ADR 0226):
 * the page's `alert`, `confirm` and `prompt`, "Leave site?" when its
 * `beforeunload` holds a navigation, and an HTTP sign-in. Each belongs to
 * its tab and waits there, over the page, until it is answered.
 */
export type PageDialogKind =
  | "alert"
  | "confirm"
  | "prompt"
  | "beforeunload"
  | "auth";

export function isScriptDialog(kind: PageDialogKind): kind is ScriptDialogKind {
  return kind === "alert" || kind === "confirm" || kind === "prompt";
}

/** The longest username or password a sign-in takes. */
export const PAGE_DIALOG_CREDENTIAL_LIMIT = 4096;

/** What leaving the page would do, for "Leave site?" and its answer. */
export type UnloadIntent =
  | { kind: "reload" | "reload-hard" | "back" | "forward" }
  | { kind: "navigate"; url: string };

export const unloadIntentSchema = z.union([
  z.object({ kind: z.enum(["reload", "reload-hard", "back", "forward"]) }),
  z.object({ kind: z.literal("navigate"), url: z.string().max(32_768) }),
]);

export interface PageDialogAuth {
  /** The server's realm, the site's own words; empty when it gave none. */
  realm: string;
  /** The scheme it asked for (basic, digest). */
  scheme: string;
  /** A proxy asks, not the site. */
  proxy: boolean;
  /** The sign-in travels without TLS. */
  insecure: boolean;
  /** The server refused the last sign-in and asks again. */
  retry: boolean;
  /** The username tried last time, on a retry. */
  username: string;
  /** Saved sign-ins for this site in the profile's vault, without secrets. */
  saved: { id: string; username: string }[];
}

export interface PageDialog {
  id: string;
  /** The page (webview guest) of the tab it belongs to. */
  guestId: number;
  kind: PageDialogKind;
  /**
   * Who asks: the asking frame's origin, or the site or proxy a sign-in is
   * for. Empty when there is no origin to name (a sandboxed or data: page).
   */
  origin: string;
  /** An embedded frame of another origin than the page asks. */
  embedded: boolean;
  /** The page's text (alert, confirm, prompt): plain text, never markup. */
  message: string;
  /** prompt: the page's suggested answer. */
  defaultValue: string;
  /** beforeunload: the page would reload rather than go. */
  reload: boolean;
  /** Offer "Don't let this page show more dialogs" (a repeated dialog). */
  canSuppress: boolean;
  auth?: PageDialogAuth;
}

export const pageDialogAnswerSchema = z.object({
  id: z.string().min(1),
  /** OK, Leave, Sign in; false is Cancel (and Escape). */
  accept: z.boolean(),
  /** prompt: the answer typed. */
  text: z.string().max(PAGE_DIALOG_MESSAGE_LIMIT).optional(),
  /** "Don't let this page show more dialogs" was checked. */
  suppress: z.boolean().optional(),
  /** auth: what the person typed. */
  username: z.string().max(PAGE_DIALOG_CREDENTIAL_LIMIT).optional(),
  password: z.string().max(PAGE_DIALOG_CREDENTIAL_LIMIT).optional(),
  /** auth: sign in with this saved login instead; main reads its secret. */
  credentialId: z.string().max(256).optional(),
});
export type PageDialogAnswer = z.infer<typeof pageDialogAnswerSchema>;

/**
 * A script dialog as the page's preload asks for it (ScriptDialogRequest),
 * its text already cut there.
 */
export const scriptDialogRequestSchema = z.object({
  kind: z.enum(SCRIPT_DIALOG_KINDS),
  message: z.string().max(PAGE_DIALOG_MESSAGE_LIMIT),
  defaultValue: z.string().max(PAGE_DIALOG_MESSAGE_LIMIT),
});

/** "127.0.0.1:8080" from "http://127.0.0.1:8080"; empty for none. */
export function originHost(origin: string): string {
  try {
    const url = new URL(origin);
    return url.host || "";
  } catch {
    return "";
  }
}

/**
 * Who the dialog names as asking, so a page can never pass its text off as
 * Work's: the site's host, Chrome's wording for an embedded page of
 * another site, or "This page" when there is no origin to show.
 */
export function pageDialogAsker(dialog: {
  origin: string;
  embedded: boolean;
}): string {
  const host = originHost(dialog.origin);
  if (!host)
    return dialog.embedded ? "An embedded page says" : "This page says";
  return dialog.embedded ? `An embedded page at ${host} says` : `${host} says`;
}
