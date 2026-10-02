import { useCallback, useEffect, useRef, useState } from "react";
import {
  BROWSER_TAB_SLEEP_MINUTES,
  type BrowserTabSleep,
} from "../../shared/app-prefs.js";
import type { BrowserSleepBlocker } from "../../shared/browser-history.js";
import { desktopApi } from "./desktop-api.js";

/** A browser tab as tab sleep sees it. */
export interface SleepCandidate {
  localId: string;
  /** The tab has a page (a fresh New Tab has nothing to unload). */
  hasPage: boolean;
  /** On screen, or being worked by an agent: never asleep. */
  awake: boolean;
  /** An agent drives this page; it stays loaded between its steps. */
  agentControlled: boolean;
}

let minuteMs: Promise<number> | null = null;
const sleepMinute = () => {
  minuteMs ??= desktopApi.browserSleepMinute().catch(() => 60_000);
  return minuteMs;
};

/**
 * Sleeping tabs (ADR 0194), Chrome's Memory Saver: a browser tab out of
 * sight for the profile's chosen time unloads its page, unless the page
 * says something keeps it awake, and loads again when it is shown. Tabs a
 * workspace mounts with (restored at launch, or the project opened again)
 * start asleep, so only the tabs on screen load.
 */
export function useTabSleep({
  mountKey,
  startAsleep,
  candidates,
  setting,
  blockerFor,
}: {
  /** The mounted workspace; null until it is restored. */
  mountKey: string | null;
  /** The workspace's hidden tabs start asleep when it mounts. */
  startAsleep: boolean;
  candidates: readonly SleepCandidate[];
  setting: BrowserTabSleep | undefined;
  /** What keeps the tab's page awake, or null when it may sleep. */
  blockerFor: (localId: string) => Promise<BrowserSleepBlocker | null>;
}): { asleep: (localId: string) => boolean; wake: (localId: string) => void } {
  const [sleeping, setSleeping] = useState<{
    key: string | null;
    ids: ReadonlySet<string>;
  }>({ key: null, ids: new Set() });
  const sleepsAtAll = setting !== "never";
  // Adjusted during render, so a mounting workspace's hidden tabs never
  // start loading only to be unloaded a frame later.
  let ids = sleeping.ids;
  if (mountKey !== null && sleeping.key !== mountKey) {
    ids = new Set(
      sleepsAtAll && startAsleep
        ? candidates
            .filter((tab) => tab.hasPage && !tab.awake && !tab.agentControlled)
            .map((tab) => tab.localId)
        : [],
    );
    setSleeping({ key: mountKey, ids });
  }

  const awakeKey = candidates
    .filter((tab) => tab.awake)
    .map((tab) => tab.localId)
    .join(" ");
  const presentKey = candidates.map((tab) => tab.localId).join(" ");
  // A shown tab wakes for good: it sleeps again only after its time out
  // of sight. Choosing Never wakes every tab; a closed tab is forgotten.
  useEffect(() => {
    const awake = new Set(awakeKey.split(" "));
    const present = new Set(presentKey.split(" "));
    setSleeping((current) => {
      const next = [...current.ids].filter(
        (id) => sleepsAtAll && present.has(id) && !awake.has(id),
      );
      return next.length === current.ids.size
        ? current
        : { ...current, ids: new Set(next) };
    });
  }, [awakeKey, presentKey, sleepsAtAll]);

  // When each hidden tab left the screen.
  const hiddenSince = useRef(new Map<string, number>());
  const candidatesRef = useRef(candidates);
  candidatesRef.current = candidates;
  const sleepingRef = useRef(ids);
  sleepingRef.current = ids;
  const blockerForRef = useRef(blockerFor);
  blockerForRef.current = blockerFor;
  useEffect(() => {
    const now = Date.now();
    const present = new Set<string>();
    for (const tab of candidatesRef.current) {
      present.add(tab.localId);
      if (tab.awake) hiddenSince.current.delete(tab.localId);
      else if (!hiddenSince.current.has(tab.localId))
        hiddenSince.current.set(tab.localId, now);
    }
    for (const id of hiddenSince.current.keys())
      if (!present.has(id)) hiddenSince.current.delete(id);
  });

  const minutes = setting ? BROWSER_TAB_SLEEP_MINUTES[setting] : 60;
  useEffect(() => {
    if (minutes === null || mountKey === null) return;
    let stopped = false;
    let timer: number | undefined;
    const sweep = async (limit: number) => {
      const now = Date.now();
      for (const tab of candidatesRef.current) {
        const since = hiddenSince.current.get(tab.localId);
        if (
          stopped ||
          tab.awake ||
          !tab.hasPage ||
          tab.agentControlled ||
          sleepingRef.current.has(tab.localId) ||
          since === undefined ||
          now - since < limit
        )
          continue;
        const blocker = await blockerForRef.current(tab.localId);
        // Shown again, or asleep already, while the page answered.
        if (
          stopped ||
          blocker ||
          !hiddenSince.current.has(tab.localId) ||
          sleepingRef.current.has(tab.localId)
        )
          continue;
        setSleeping((current) => ({
          ...current,
          ids: new Set([...current.ids, tab.localId]),
        }));
      }
    };
    void sleepMinute().then((minute) => {
      if (stopped) return;
      const limit = minutes * minute;
      // Checked a few times per period, at most every 30 seconds.
      const every = Math.min(30_000, Math.max(250, limit / 4));
      const tick = () => {
        void sweep(limit).finally(() => {
          if (!stopped) timer = window.setTimeout(tick, every);
        });
      };
      timer = window.setTimeout(tick, every);
    });
    return () => {
      stopped = true;
      window.clearTimeout(timer);
    };
  }, [minutes, mountKey]);

  const asleep = useCallback(
    (localId: string) =>
      ids.has(localId) &&
      !candidates.some((tab) => tab.localId === localId && tab.awake),
    [ids, candidates],
  );
  const wake = useCallback((localId: string) => {
    hiddenSince.current.delete(localId);
    setSleeping((current) => {
      if (!current.ids.has(localId)) return current;
      const next = new Set(current.ids);
      next.delete(localId);
      return { ...current, ids: next };
    });
  }, []);
  return { asleep, wake };
}
