import { expect, it } from "vitest";
import {
  BROWSER_HISTORY_LIMIT,
  boundedBrowserHistory,
  browserHistorySource,
  browserWakeSource,
  historyFromSource,
  parseBrowserHistory,
  wakeFromSource,
} from "./browser-history.js";

const pages = (count: number) =>
  Array.from({ length: count }, (_, index) => ({
    url: `https://example.com/${index}`,
    title: `Page ${index}`,
  }));

it("keeps nothing when there is nowhere to go", () => {
  expect(boundedBrowserHistory({ entries: pages(1), index: 0 })).toBeNull();
  expect(boundedBrowserHistory({ entries: [], index: 0 })).toBeNull();
});

it("trims a long list around the current page, mostly behind it", () => {
  const trimmed = boundedBrowserHistory({ entries: pages(120), index: 100 });
  expect(trimmed?.entries).toHaveLength(BROWSER_HISTORY_LIMIT);
  expect(trimmed?.entries[trimmed.index]?.url).toBe("https://example.com/100");
  // Ten pages ahead are kept, the rest of the room goes to the way back.
  expect(trimmed?.entries.at(-1)?.url).toBe("https://example.com/110");
  const atEnd = boundedBrowserHistory({ entries: pages(80), index: 79 });
  expect(atEnd?.entries.at(-1)?.url).toBe("https://example.com/79");
  expect(atEnd?.index).toBe(BROWSER_HISTORY_LIMIT - 1);
  const atStart = boundedBrowserHistory({ entries: pages(80), index: 2 });
  expect(atStart?.entries[0]?.url).toBe("https://example.com/0");
  expect(atStart?.index).toBe(2);
});

it("accepts only a well-formed history from across the boundary", () => {
  expect(parseBrowserHistory({ entries: pages(3), index: 1 })).toEqual({
    entries: pages(3),
    index: 1,
  });
  expect(parseBrowserHistory({ entries: pages(3), index: 3 })).toBeNull();
  expect(parseBrowserHistory({ entries: [{ url: 1 }], index: 0 })).toBeNull();
  expect(parseBrowserHistory(null)).toBeNull();
  // Extra fields (a page state) do not travel.
  expect(
    parseBrowserHistory({
      entries: pages(2).map((page) => ({ ...page, pageState: "x" })),
      index: 0,
    }),
  ).toEqual({ entries: pages(2), index: 0 });
});

it("wakes a sleeping tab from its snapshot, with a fallback that still loads", () => {
  const history = { entries: pages(3), index: 1 };
  const fallback = browserHistorySource(history);
  const source = browserWakeSource("snap-1", fallback);
  expect(historyFromSource(source)).toBeUndefined();
  const wake = wakeFromSource(source);
  expect(wake?.snapshotId).toBe("snap-1");
  expect(wake && historyFromSource(wake.fallback)).toEqual(history);
  const plain = wakeFromSource(
    browserWakeSource("snap-2", "https://example.com/a#b?c"),
  );
  expect(plain?.fallback).toBe("https://example.com/a#b?c");
  expect(wakeFromSource("https://example.com/")).toBeUndefined();
});
