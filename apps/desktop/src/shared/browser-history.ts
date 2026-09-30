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
