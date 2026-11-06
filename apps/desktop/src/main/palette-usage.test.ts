import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, expect, it } from "vitest";
import type { HistoryEntry } from "../shared/history.js";
import {
  frecency,
  paletteCountsVisit,
  webUsageKey,
} from "../shared/palette.js";
import { PaletteUsageStore } from "./palette-usage.js";

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 8, 29);
const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});
function store() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "palette-usage-"));
  dirs.push(dir);
  return { dir, usage: new PaletteUsageStore(dir) };
}
const page = (
  url: string,
  visitCount: number,
  lastVisitAt: number,
): HistoryEntry => ({
  id: webUsageKey(url),
  target: { kind: "web", url },
  title: url,
  visitCount,
  lastVisitAt,
});

it("weights frequent recent use above old use", () => {
  expect(frecency({ count: 1, visits: [NOW], now: NOW })).toBe(1);
  expect(
    frecency({ count: 10, visits: [NOW, NOW - DAY], now: NOW }),
  ).toBeGreaterThan(
    frecency({ count: 10, visits: [NOW - 200 * DAY], now: NOW }),
  );
  expect(frecency({ count: 0, visits: [NOW], now: NOW })).toBe(0);
});

it("counts visits and learns picks per typed query", () => {
  const { usage } = store();
  for (let day = 2; day >= 0; day--)
    usage.record({
      profileId: "p",
      use: {
        key: "surface:settings",
        visit: true,
        query: "Se",
        projectId: "a",
      },
      now: NOW - day * DAY,
    });
  usage.record({
    profileId: "p",
    use: { key: webUsageKey("https://example.com"), visit: false, query: "se" },
    now: NOW,
  });
  const signals = usage.signals({ profileId: "p", history: [], now: NOW });
  expect(signals.usage["surface:settings"]).toEqual({
    frecency: 3,
    projectId: "a",
  });
  // A pick without a visit teaches the query but adds no count.
  expect(signals.usage[webUsageKey("https://example.com")]).toBeUndefined();
  expect(Object.keys(signals.picks.se ?? {})).toEqual([
    "surface:settings",
    webUsageKey("https://example.com"),
  ]);
  expect(signals.picks.se?.["surface:settings"]).toBeGreaterThan(
    signals.picks.se?.[webUsageKey("https://example.com")] ?? 0,
  );
});

it("merges the most frecent history and orders frequent pages", () => {
  const { usage } = store();
  const busy = page("https://busy.test/", 40, NOW - DAY);
  const stale = page("https://stale.test/", 40, NOW - 300 * DAY);
  const fresh = page("https://fresh.test/", 2, NOW);
  const signals = usage.signals({
    profileId: "p",
    history: [stale, fresh, busy],
    now: NOW,
  });
  expect(signals.frequentHistory.map((entry) => entry.id)).toEqual([
    busy.id,
    stale.id,
    fresh.id,
  ]);
  expect(signals.usage[busy.id]?.frecency).toBe(40);
});

it("persists, forgets removed destinations and clears with history", () => {
  const { dir, usage } = store();
  usage.record({
    profileId: "p",
    use: { key: "action:new-tab", visit: true, query: "new" },
    now: NOW,
  });
  usage.record({
    profileId: "p",
    use: { key: "setting:theme", visit: true, query: "new" },
    now: NOW,
  });
  usage.dispose();
  const reopened = new PaletteUsageStore(dir);
  let signals = reopened.signals({ profileId: "p", history: [], now: NOW });
  expect(Object.keys(signals.usage)).toEqual([
    "action:new-tab",
    "setting:theme",
  ]);
  reopened.forget("p", "action:new-tab");
  signals = reopened.signals({ profileId: "p", history: [], now: NOW });
  expect(Object.keys(signals.usage)).toEqual(["setting:theme"]);
  expect(Object.keys(signals.picks.new ?? {})).toEqual(["setting:theme"]);
  reopened.clear("p");
  signals = reopened.signals({ profileId: "p", history: [], now: NOW });
  expect(signals.usage).toEqual({});
  expect(signals.picks).toEqual({});
  reopened.dispose();
  expect(
    JSON.parse(
      fs.readFileSync(path.join(dir, "p", "palette-usage.json"), "utf8"),
    ),
  ).toEqual({ items: {}, picks: {} });
});

it("bounds learned queries and picks per query", () => {
  const { usage } = store();
  for (let index = 0; index < 520; index++)
    usage.record({
      profileId: "p",
      use: { key: `action:${index % 12}`, visit: false, query: `q${index}` },
      now: NOW + index,
    });
  for (let index = 0; index < 12; index++)
    usage.record({
      profileId: "p",
      use: { key: `action:${index}`, visit: false, query: "same" },
      now: NOW + index,
    });
  const { picks } = usage.signals({ profileId: "p", history: [], now: NOW });
  expect(Object.keys(picks)).toHaveLength(500);
  expect(picks.q0).toBeUndefined();
  expect(Object.keys(picks.same ?? {})).toHaveLength(8);
  expect(picks.same?.["action:11"]).toBeDefined();
  expect(picks.same?.["action:0"]).toBeUndefined();
});

it("counts visits only where nothing else counts them", () => {
  expect(paletteCountsVisit("action:new-tab")).toBe(true);
  expect(paletteCountsVisit("setting:theme")).toBe(true);
  expect(paletteCountsVisit("surface:settings")).toBe(false);
  expect(paletteCountsVisit(webUsageKey("https://example.com"))).toBe(false);
  expect(webUsageKey("https://example.com")).toBe(
    webUsageKey("https://example.com/"),
  );
});
