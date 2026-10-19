import {
  type BrowserWindow,
  desktopCapturer,
  type NativeImage,
  screen,
  systemPreferences,
} from "electron";
import type { FrontPlace } from "./system-keys.js";

/** Pictures are kept, and given to agents, at most this wide. */
const PICTURE_WIDTH = 1600;
/** What the person saw is kept this long after they said it. */
const KEPT_MS = 30 * 60_000;
/** Chats whose last spoken message's sight is kept at once. */
const KEPT_CHATS = 16;

/**
 * What the person saw as they started saying something by voice (ADR
 * 0265): where they were, Work's screen as a turn describes it, and a
 * picture of it. Taken as their speech starts, since what is on screen
 * often changes while they talk and once they finish. Kept in memory only;
 * an agent sees the picture only when it asks for it.
 */
export interface Sight {
  /** When they started saying it (epoch ms). */
  at: number;
  /** The project in front of the Work window they were in. */
  projectId: string | null;
  /** The app in front, when it was not Work (ADR 0236). */
  app: Promise<FrontPlace | null>;
  /** Work's screen as a turn's workspace context describes it. */
  screen: Promise<string | null>;
  /** A picture of what they saw, when Work could take one. */
  picture: Promise<NativeImage | null>;
}

/** What the person saw as they started saying a message they sent. */
export interface SpokenSight extends Sight {
  said: string;
  /** When its words were heard and went to the chat (epoch ms). */
  heardAt: number;
  /**
   * The turns that read the message, once the chat took it: the one it
   * went to, and the one it runs as should that end without reading it.
   */
  turnIds?: string[];
}

/**
 * A picture of what the person sees: Work's window when Work is in front,
 * which needs no permission and shows no recording indicator; in another
 * app, the display they are on when they already allowed Work to record
 * the screen (macOS asks for screen sharing); else none, and the agent
 * hears only the app's name. Never asks for a permission itself.
 */
export async function takePicture(
  window: BrowserWindow | null,
  workInFront: boolean,
): Promise<NativeImage | null> {
  if (workInFront) {
    if (!window || window.isDestroyed()) return null;
    const image = await window.webContents.capturePage(undefined, {
      stayHidden: true,
      stayAwake: true,
    });
    if (image.isEmpty()) return null;
    return image.getSize().width > PICTURE_WIDTH
      ? image.resize({ width: PICTURE_WIDTH })
      : image;
  }
  if (
    process.platform === "darwin" &&
    systemPreferences.getMediaAccessStatus("screen") === "granted"
  ) {
    const display = screen.getDisplayNearestPoint(
      screen.getCursorScreenPoint(),
    );
    const { width, height } = display.size;
    const sources = await desktopCapturer.getSources({
      types: ["screen"],
      thumbnailSize: {
        width: PICTURE_WIDTH,
        height: Math.round((PICTURE_WIDTH * height) / Math.max(1, width)),
      },
    });
    const source =
      sources.find((each) => each.display_id === String(display.id)) ??
      sources[0];
    if (source && !source.thumbnail.isEmpty()) return source.thumbnail;
  }
  return null;
}

/**
 * The sight of each chat's latest spoken message, for its agent's turn
 * context and its screen_when_spoken tool, whether or not voice is still
 * on. A few chats at a time, for half an hour.
 */
export class SpokenSights {
  private readonly sights = new Map<string, SpokenSight>();
  private timer: ReturnType<typeof setTimeout> | undefined;

  constructor(private readonly now: () => number = Date.now) {}

  set(sessionId: string, sight: SpokenSight): void {
    this.sights.delete(sessionId);
    this.sights.set(sessionId, sight);
    for (const key of this.sights.keys()) {
      if (this.sights.size <= KEPT_CHATS) break;
      this.sights.delete(key);
    }
    this.prune();
  }

  /** Pictures go once they are old, whether or not anything reads them. */
  private prune(): void {
    clearTimeout(this.timer);
    this.timer = undefined;
    let oldest = Number.POSITIVE_INFINITY;
    for (const [key, kept] of this.sights)
      if (this.now() - kept.at > KEPT_MS) this.sights.delete(key);
      else oldest = Math.min(oldest, kept.at);
    if (oldest === Number.POSITIVE_INFINITY) return;
    this.timer = setTimeout(
      () => this.prune(),
      oldest + KEPT_MS - this.now() + 1,
    );
    this.timer.unref?.();
  }

  get(sessionId: string): SpokenSight | null {
    const sight = this.sights.get(sessionId);
    if (!sight) return null;
    if (this.now() - sight.at > KEPT_MS) {
      this.sights.delete(sessionId);
      return null;
    }
    return sight;
  }

  clear(): void {
    clearTimeout(this.timer);
    this.sights.clear();
  }
}

/**
 * The sight a stretch of speech was said with: the one taken as it
 * started, or as the hold it continues did. Older ones go.
 */
export function sightFor<T>(sights: Map<number, T>, segment: number): T | null {
  let found: T | null = null;
  let at = -1;
  for (const [taken, sight] of sights)
    if (taken <= segment && taken > at) {
      found = sight;
      at = taken;
    }
  for (const taken of [...sights.keys()])
    if (taken <= segment) sights.delete(taken);
  return found;
}
