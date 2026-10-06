import { randomUUID } from "node:crypto";
import { app, ipcMain, type Session, type WebContents } from "electron";
import type { BrowserSleepBlocker } from "../shared/browser-history.js";

/**
 * Sleeping tabs (ADR 0194), the main-process half. The renderer decides
 * when a tab has been out of sight long enough; main says what keeps its
 * page awake, and keeps a slept page's state (scroll position, form
 * values) until the tab wakes, as Chrome restores a discarded tab.
 */

/** A slept page's back and forward list, with Chromium's page state. */
export interface PageSnapshot {
  entries: Electron.NavigationEntry[];
  index: number;
}

/**
 * Guests that opened the camera, microphone or a screen share since their
 * page loaded. Electron reports grants, not when a stream stops, so a page
 * stays awake until it navigates: a call never drops because it went quiet.
 */
const capturing = new Set<number>();

export function noteCapture(contents: WebContents): void {
  if (contents.isDestroyed() || contents.getType() !== "webview") return;
  const id = contents.id;
  if (capturing.has(id)) return;
  capturing.add(id);
  const clear = () => {
    capturing.delete(id);
    if (contents.isDestroyed()) return;
    contents.off("did-navigate", clear);
    contents.off("destroyed", clear);
  };
  contents.on("did-navigate", clear);
  contents.once("destroyed", clear);
}

/**
 * Snapshots wait here between sleep and wake, bound to the window and
 * session they came from. A tab closed while asleep releases its own; the
 * oldest give way past the limit, and a wake that finds none loads the
 * tab's saved history instead.
 */
const SNAPSHOT_LIMIT = 64;
const snapshots = new Map<
  string,
  PageSnapshot & { hostId: number; session: Session }
>();

/** The snapshot a webview attaching in `host` with `session` wakes into. */
export function claimSnapshot({
  id,
  host,
  session,
}: {
  id: string;
  host: WebContents;
  session: Session;
}): PageSnapshot | undefined {
  const snapshot = snapshots.get(id);
  snapshots.delete(id);
  if (!snapshot || snapshot.hostId !== host.id || snapshot.session !== session)
    return undefined;
  return { entries: snapshot.entries, index: snapshot.index };
}

function keepSnapshot(guest: WebContents): string | null {
  const host = guest.hostWebContents;
  const entries = guest.navigationHistory.getAllEntries();
  const index = guest.navigationHistory.getActiveIndex();
  if (!host || !entries[index]) return null;
  const id = randomUUID();
  snapshots.set(id, {
    entries,
    index,
    hostId: host.id,
    session: guest.session,
  });
  for (const oldest of snapshots.keys()) {
    if (snapshots.size <= SNAPSHOT_LIMIT) break;
    snapshots.delete(oldest);
  }
  return id;
}

/**
 * A page that went quiet a moment ago is still playing: a call nobody is
 * speaking in, a playlist between tracks. Chrome keeps such tabs too.
 */
const RECENTLY_AUDIBLE_MS = 2 * 60_000;
/** Typed text is assumed when a page cannot answer in time. */
const PROBE_TIMEOUT_MS = 1000;

export function registerBrowserSleep({
  hostedGuest,
  keepsAwake,
}: {
  /** The guest with this id, if the asking window hosts it. */
  hostedGuest: (host: WebContents, guestId: unknown) => WebContents | null;
  /** An extension is driving the page or showing its side panel. */
  keepsAwake: (guestId: number) => boolean;
}): () => void {
  const quietSince = new Map<number, number>();
  const trackAudio = (_event: Electron.Event, contents: WebContents) => {
    if (contents.getType() !== "webview") return;
    const id = contents.id;
    contents.on("audio-state-changed", ({ audible }) => {
      if (audible) quietSince.delete(id);
      else quietSince.set(id, Date.now());
    });
    contents.once("destroyed", () => quietSince.delete(id));
  };
  app.on("web-contents-created", trackAudio);

  let nextProbe = 0;
  const probes = new Map<
    number,
    { guestId: number; resolve: (typing: boolean) => void }
  >();
  const onProbeResult = (
    event: Electron.IpcMainEvent,
    payload: { probe?: unknown; typing?: unknown },
  ) => {
    const probe = typeof payload?.probe === "number" ? payload.probe : -1;
    const pending = probes.get(probe);
    if (!pending || pending.guestId !== event.sender.id) return;
    probes.delete(probe);
    pending.resolve(payload.typing === true);
  };
  ipcMain.on("catamorphic:browser-sleep-probe", onProbeResult);

  // Text typed into a field and not yet sent, read from the guest preload.
  // A page too busy to answer may be holding some; the next check retries.
  const typing = (guest: WebContents) =>
    new Promise<boolean>((resolve) => {
      const probe = ++nextProbe;
      const timer = setTimeout(() => {
        probes.delete(probe);
        resolve(true);
      }, PROBE_TIMEOUT_MS);
      probes.set(probe, {
        guestId: guest.id,
        resolve: (value) => {
          clearTimeout(timer);
          resolve(value);
        },
      });
      guest.send("catamorphic:browser-sleep-probe", probe);
    });

  ipcMain.handle(
    "catamorphic:browser-sleep-blocker",
    async (
      event,
      input: { guestId?: unknown },
    ): Promise<BrowserSleepBlocker | null> => {
      const guest = hostedGuest(event.sender, input?.guestId);
      // A crashed page has nothing left to keep.
      if (!guest || guest.isCrashed()) return null;
      const quiet = quietSince.get(guest.id);
      if (
        guest.isCurrentlyAudible() ||
        (quiet !== undefined && Date.now() - quiet < RECENTLY_AUDIBLE_MS)
      )
        return "audio";
      if (capturing.has(guest.id)) return "media";
      // Another tab, or a call, is showing this page.
      if (guest.isBeingCaptured()) return "shared";
      if (guest.isDevToolsOpened()) return "devtools";
      if (keepsAwake(guest.id)) return "extension";
      if (await typing(guest)) return "typing";
      return null;
    },
  );
  // Test runs shorten the minute so a tab sleeps within the test.
  const minuteMs =
    process.env.CATAMORPHIC_E2E_DATA_DIR &&
    Number(process.env.CATAMORPHIC_E2E_TAB_SLEEP_MINUTE_MS) > 0
      ? Number(process.env.CATAMORPHIC_E2E_TAB_SLEEP_MINUTE_MS)
      : 60_000;
  ipcMain.handle("catamorphic:browser-sleep-minute", () => minuteMs);
  ipcMain.handle(
    "catamorphic:browser-sleep",
    (event, input: { guestId?: unknown }) => {
      const guest = hostedGuest(event.sender, input?.guestId);
      return guest ? keepSnapshot(guest) : null;
    },
  );
  // A tab closed, or a sleep abandoned, before its snapshot was used.
  ipcMain.handle(
    "catamorphic:browser-sleep-release",
    (event, input: { snapshotId?: unknown }) => {
      const id = input?.snapshotId;
      if (
        typeof id === "string" &&
        snapshots.get(id)?.hostId === event.sender.id
      )
        snapshots.delete(id);
    },
  );
  return () => {
    app.off("web-contents-created", trackAudio);
    ipcMain.off("catamorphic:browser-sleep-probe", onProbeResult);
    ipcMain.removeHandler("catamorphic:browser-sleep-blocker");
    ipcMain.removeHandler("catamorphic:browser-sleep");
    ipcMain.removeHandler("catamorphic:browser-sleep-minute");
    ipcMain.removeHandler("catamorphic:browser-sleep-release");
    for (const pending of probes.values()) pending.resolve(false);
    probes.clear();
  };
}
