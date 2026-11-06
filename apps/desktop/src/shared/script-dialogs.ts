/**
 * What a frame's `alert`, `confirm` and `prompt` send to main and get back
 * (ADR 0227). Shared by the tab preload, which runs sandboxed and loads no
 * dependency, and main, which checks the request (shared/page-dialogs.ts).
 */

/** The page's own dialogs, which it asks from script and waits on. */
export const SCRIPT_DIALOG_KINDS = ["alert", "confirm", "prompt"] as const;
export type ScriptDialogKind = (typeof SCRIPT_DIALOG_KINDS)[number];

/** A message longer than this is cut; nobody reads further in a dialog. */
export const PAGE_DIALOG_MESSAGE_LIMIT = 20_000;

/**
 * A frame refused for now asks main again only after this long, so a page
 * that keeps calling `alert` costs main nothing meanwhile.
 */
export const SCRIPT_DIALOG_QUIET_MS = 1_000;

export interface ScriptDialogRequest {
  kind: ScriptDialogKind;
  message: string;
  defaultValue: string;
}

/**
 * Main's reply: the answer the page's call returns, or a refusal without
 * asking anyone. A refused "document" never asks again while it lives (an
 * opaque frame, a page told to show no more dialogs, a page that has gone);
 * a "busy" one may, after `SCRIPT_DIALOG_QUIET_MS` (its page waits on too
 * many dialogs, or no window shows it just now).
 */
export type ScriptDialogReply =
  | { answer: boolean | string | null }
  | { refused: "document" | "busy" };
