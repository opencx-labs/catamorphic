/**
 * A browser tab's back and forward list, as Chromium keeps it. The tab's
 * workspace entry holds it, so a tab reopened with Cmd+Shift+T, or
 * restored with its window, can still go back.
 */
export interface BrowserHistory {
  entries: { url: string; title: string }[];
  /** The page the tab shows. */
  index: number;
}

/** A working stretch of browsing, not an archive; most of it behind. */
export const BROWSER_HISTORY_LIMIT = 50;
const KEPT_AHEAD = 10;

/**
 * The list trimmed to the limit around the current page, keeping mostly
 * the pages behind it; null when there is nothing to go back or forward to.
 */
export function boundedBrowserHistory(
  history: BrowserHistory,
): BrowserHistory | null {
  const { entries } = history;
  if (entries.length < 2) return null;
  const index = Math.min(Math.max(history.index, 0), entries.length - 1);
  const start = Math.min(
    Math.max(0, index + KEPT_AHEAD + 1 - BROWSER_HISTORY_LIMIT),
    Math.max(0, entries.length - BROWSER_HISTORY_LIMIT),
  );
  return {
    entries: entries.slice(start, start + BROWSER_HISTORY_LIMIT),
    index: index - start,
  };
}

const isEntry = (entry: unknown): entry is BrowserHistory["entries"][number] =>
  typeof entry === "object" &&
  entry !== null &&
  "url" in entry &&
  typeof entry.url === "string" &&
  "title" in entry &&
  typeof entry.title === "string";

/** A history from across the process boundary, or null if malformed. */
export function parseBrowserHistory(value: unknown): BrowserHistory | null {
  if (
    typeof value !== "object" ||
    value === null ||
    !("entries" in value) ||
    !("index" in value)
  )
    return null;
  const { entries, index } = value;
  if (
    !Array.isArray(entries) ||
    !entries.every(isEntry) ||
    typeof index !== "number" ||
    !Number.isInteger(index) ||
    index < 0 ||
    index >= entries.length
  )
    return null;
  return boundedBrowserHistory({
    entries: entries.map(({ url, title }) => ({ url, title })),
    index,
  });
}

/**
 * A reopened tab's webview takes its history in place of a URL: main
 * recognizes this source before the guest loads anything, restores the
 * history into it, and never navigates to the source itself.
 */
const HISTORY_SOURCE = "work-history:";

export const browserHistorySource = (history: BrowserHistory): string =>
  `${HISTORY_SOURCE}${encodeURIComponent(JSON.stringify(history))}`;

/** The history a webview source carries; undefined for an ordinary URL. */
export function historyFromSource(
  source: string,
): BrowserHistory | null | undefined {
  if (!source.startsWith(HISTORY_SOURCE)) return undefined;
  try {
    return parseBrowserHistory(
      JSON.parse(decodeURIComponent(source.slice(HISTORY_SOURCE.length))),
    );
  } catch {
    return null;
  }
}

/**
 * A sleeping tab's webview wakes from the page state main kept when it
 * slept (scroll position and form values, as Chrome restores a discarded
 * tab). The fallback, a URL or a history source, loads instead when main
 * no longer holds that state.
 */
const WAKE_SOURCE = "work-wake:";

export const browserWakeSource = (snapshotId: string, fallback: string) =>
  `${WAKE_SOURCE}${snapshotId}#${encodeURIComponent(fallback)}`;

/** The snapshot and fallback a wake source names; undefined otherwise. */
export function wakeFromSource(
  source: string,
): { snapshotId: string; fallback: string } | undefined {
  if (!source.startsWith(WAKE_SOURCE)) return undefined;
  const hash = source.indexOf("#");
  if (hash < 0) return undefined;
  try {
    return {
      snapshotId: source.slice(WAKE_SOURCE.length, hash),
      fallback: decodeURIComponent(source.slice(hash + 1)),
    };
  } catch {
    return undefined;
  }
}

/**
 * What keeps a hidden tab's page awake: sound playing or just played, the
 * camera, microphone or a screen share in use, the page being shown
 * elsewhere (a tab share), its DevTools open, an extension driving it or
 * showing its side panel beside it, or text typed into a field and not yet
 * sent.
 */
export type BrowserSleepBlocker =
  | "audio"
  | "media"
  | "shared"
  | "devtools"
  | "extension"
  | "typing";
