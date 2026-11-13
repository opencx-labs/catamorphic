import { z } from "zod";

/**
 * Screen sharing (ADRs 0150, 0315): a page's `getDisplayMedia` call opens
 * the app's own picker, Chrome-style, with three kinds of source: one of
 * this window's browser tabs, an application window, or an entire screen.
 */

export type ScreenShareKind = "tab" | "window" | "screen";

export interface ScreenShareRequest {
  id: string;
  /** The requesting guest's webContents id (the tab asking to share). */
  guestId: number;
  origin: string;
  /**
   * The page asked for sound with the picture, so the picker offers it:
   * a tab's own audio, or the system's with an entire screen.
   */
  audio: boolean;
}

/** An application window or a screen the OS can capture. */
export interface ScreenShareSource {
  /** Desktop capturer id (`screen:…`, `window:…`). */
  id: string;
  kind: "window" | "screen";
  name: string;
  /** PNG data URL, absent when the OS refuses to render it. */
  thumbnail: string | null;
  /** Window sources: the owning app's icon. */
  icon: string | null;
}

/** OS gate on screen capture (macOS Screen Recording). */
export type SystemScreenAccess = "granted" | "denied" | null;

export interface ScreenShareCaptureSources {
  windows: ScreenShareSource[];
  screens: ScreenShareSource[];
  /**
   * The OS did not answer in time, so the list may be short (screens fall
   * back to the displays Work knows about).
   */
  timedOut: boolean;
  system: SystemScreenAccess;
  /** The system's audio can go along with an entire screen on this OS. */
  systemAudio: boolean;
}

/** What was picked, and whether its sound goes along. */
export const screenShareChoiceSchema = z.object({
  /** A capturer id, or `tab:<webContentsId>` for a browser tab. */
  id: z.string().min(1),
  kind: z.enum(["tab", "window", "screen"]),
  name: z.string().max(4096),
  /** Share the tab's (or, with a screen, the system's) audio. */
  audio: z.boolean(),
});
export type ScreenShareChoice = z.infer<typeof screenShareChoiceSchema>;

export const screenShareAnswerSchema = z.object({
  requestId: z.string().min(1),
  /** `null` cancels: the page's request fails with NotAllowedError. */
  choice: screenShareChoiceSchema.nullable(),
});
export type ScreenShareAnswer = z.infer<typeof screenShareAnswerSchema>;

/**
 * A browser tab Work handed to a page's share: `sharing` once its capture
 * runs, `ended` when it stops (or never started). The window keeps the
 * tab laid out and awake in between.
 */
export interface ScreenShareTabState {
  guestId: number;
  state: "sharing" | "ended";
  /** The site the tab is shared with. */
  origin: string;
}

/** `tab:<webContentsId>` → the id, or null for other sources. */
export function tabSourceWebContentsId(sourceId: string): number | null {
  const match = /^tab:(\d+)$/.exec(sourceId);
  return match ? Number(match[1]) : null;
}

/**
 * The streams a pick turns into, for the session's display-media handler.
 * Sound goes along only when the page asked for it and the person left it
 * on: a tab's own audio (still playing locally, as in Chrome), or the
 * system's with an entire screen where the OS can capture it. A window
 * has no sound of its own to give.
 */
export function shareStreams<Frame>(input: {
  choice: Pick<ScreenShareChoice, "id" | "kind" | "name" | "audio">;
  /** The shared tab's main frame, for a tab pick. */
  tabFrame: Frame | null;
  audioRequested: boolean;
  systemAudio: boolean;
}):
  | { video: Frame; audio?: Frame; enableLocalEcho?: boolean }
  | { video: { id: string; name: string }; audio?: "loopback" }
  | null {
  const { choice, tabFrame } = input;
  const audio = input.audioRequested && choice.audio;
  if (choice.kind === "tab") {
    if (!tabFrame) return null;
    return audio
      ? { video: tabFrame, audio: tabFrame, enableLocalEcho: true }
      : { video: tabFrame };
  }
  const video = { id: choice.id, name: choice.name };
  return choice.kind === "screen" && audio && input.systemAudio
    ? { video, audio: "loopback" }
    : { video };
}

/**
 * Whether the OS can mix its own sound into a screen share: Windows, and
 * macOS 14.2 or later (Chromium's CoreAudio tap) when the app declares why
 * it records system audio. Linux has no loopback in Electron.
 */
export function systemAudioSupported(input: {
  platform: string;
  /** `process.getSystemVersion()`: "14.2.1", "26.0". */
  osVersion: string;
  /** The app bundle has `NSAudioCaptureUsageDescription`. */
  declaresAudioCapture: boolean;
}): boolean {
  if (input.platform === "win32") return true;
  if (input.platform !== "darwin" || !input.declaresAudioCapture) return false;
  const [major = 0, minor = 0] = input.osVersion
    .split(".")
    .map((part) => Number.parseInt(part, 10) || 0);
  return major > 14 || (major === 14 && minor >= 2);
}
