import { z } from "zod";

/**
 * Screen sharing (ADR 0149): a page's `getDisplayMedia` call opens the
 * app's own picker, Chrome-style, with three kinds of source: one of this
 * window's browser tabs, an application window, or an entire screen.
 */

export type ScreenShareKind = "tab" | "window" | "screen";

export interface ScreenShareRequest {
  id: string;
  /** The requesting guest's webContents id (the tab asking to share). */
  guestId: number;
  origin: string;
  /** The page asked for audio too (tab audio is the only kind we can give). */
  audioRequested: boolean;
}

export interface ScreenShareSource {
  /** Desktop capturer id (`screen:…`, `window:…`) or `tab:<webContentsId>`. */
  id: string;
  kind: ScreenShareKind;
  name: string;
  /** PNG data URL, absent when the OS refuses to render it. */
  thumbnail: string | null;
  /** Window sources: the owning app's icon. Tabs: the page's favicon. */
  icon: string | null;
  /** Tabs: the page URL (for the favicon fallback) and whether it is the asker. */
  url?: string;
  current?: boolean;
}

/** OS gate on screen capture (macOS Screen Recording). */
export type SystemScreenAccess = "granted" | "denied" | "not-determined" | null;

export interface ScreenShareSources {
  tabs: ScreenShareSource[];
  windows: ScreenShareSource[];
  screens: ScreenShareSource[];
  system: SystemScreenAccess;
}

export const screenShareChoiceSchema = z.object({
  id: z.string().min(1),
  kind: z.enum(["tab", "window", "screen"]),
  name: z.string().max(4096),
  /** Share the tab's audio along with its picture. */
  audio: z.boolean(),
});
export type ScreenShareChoice = z.infer<typeof screenShareChoiceSchema>;

export const screenShareAnswerSchema = z.object({
  requestId: z.string().min(1),
  /** `null` cancels: the page's request fails with NotAllowedError. */
  choice: screenShareChoiceSchema.nullable(),
});
export type ScreenShareAnswer = z.infer<typeof screenShareAnswerSchema>;

/** `tab:<webContentsId>` → the id, or null for other sources. */
export function tabSourceWebContentsId(sourceId: string): number | null {
  const match = /^tab:(\d+)$/.exec(sourceId);
  return match ? Number(match[1]) : null;
}
