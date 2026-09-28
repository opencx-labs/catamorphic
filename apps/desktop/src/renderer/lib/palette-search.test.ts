import { expect, it } from "vitest";
import { SETTINGS_CATALOG } from "../../shared/settings-catalog.js";
import { createPaletteIndex, PALETTE_RESULT_LIMIT } from "./palette-search.js";

it("finds individual settings without reading preference values", () => {
  const search = createPaletteIndex(
    SETTINGS_CATALOG.map(({ id, label, keywords }) => ({
      id,
      label,
      keywords,
      category: "setting" as const,
    })),
  );
  expect(search("framed content")[0]?.id).toBe("contentFrame");
  expect(search("monospace font")[0]?.id).toBe("theme.fonts.mono");
  expect(search("accent color")[0]?.id).toBe("theme.overrides.accent");
  expect(search("frmdc").some((item) => item.id === "contentFrame")).toBe(true);
  expect(new Set(SETTINGS_CATALOG.map((item) => item.id)).size).toBe(
    SETTINGS_CATALOG.length,
  );
});
it("bounds results on large indexes, preserves exact matches and refuses pasted prose", () => {
  const items = Array.from({ length: 10000 }, (_, index) => ({
    id: String(index),
    label: `Project resource ${index}`,
    keywords: ["project", "resource"],
  }));
  const search = createPaletteIndex(items);
  expect(search("resource")).toHaveLength(PALETTE_RESULT_LIMIT);
  expect(search("Project resource 9999")[0]?.id).toBe("9999");
  expect(search("a".repeat(10000))).toEqual([]);
  expect(search("line one\nline two")).toEqual([]);
});

type Row = {
  id: string;
  label: string;
  keywords: string[];
  detail?: string;
  category?: import("./palette-search.js").PaletteCategory;
  usage?: string;
  disabled?: boolean;
};
const row = (id: string, label: string, extra: Partial<Row> = {}): Row => ({
  id,
  label,
  keywords: [],
  usage: id,
  ...extra,
});
const signals = (
  usage: Record<string, number>,
  picks: Record<string, Record<string, number>> = {},
) => ({
  usage: Object.fromEntries(
    Object.entries(usage).map(([key, frecency]) => [key, { frecency }]),
  ),
  picks,
  frequentHistory: [],
});

it("ranks a system command above a page with a similar match", () => {
  const search = createPaletteIndex([
    row("page", "New tab ideas - Blog", { category: "page" }),
    row("action", "New terminal tab", { category: "command" }),
  ]);
  expect(search("new t").map((item) => item.id)).toEqual(["action", "page"]);
});

it("lets a much better match or heavy use lift a page", () => {
  const search = createPaletteIndex([
    row("action", "Toggle pull request panel", {
      category: "command",
      keywords: ["pulls"],
    }),
    row("page", "Pulls · catamorphic", { category: "page" }),
  ]);
  // A page title starting with the query still yields to a command's keyword.
  expect(search("pulls")[0]?.id).toBe("action");
  expect(search("pulls", { signals: signals({ page: 50 }) })[0]?.id).toBe(
    "page",
  );
  // A label match on the page beats a command matched only in its detail.
  const detail = createPaletteIndex([
    row("action", "Site settings", { detail: "github.com" }),
    row("page", "GitHub", { category: "page" }),
  ]);
  expect(detail("github")[0]?.id).toBe("page");
});

it("matches labels above keywords and keywords above details", () => {
  const search = createPaletteIndex([
    row("detail", "Site settings", {
      detail: "github.com",
      keywords: ["site", "permissions"],
    }),
    row("keyword", "Repositories", { keywords: ["github"] }),
    row("label", "GitHub notifications"),
  ]);
  expect(search("github").map((item) => item.id)).toEqual([
    "label",
    "keyword",
    "detail",
  ]);
});

it("boosts frequently used rows and learns picks for related queries", () => {
  const rows = [
    row("surface:settings", "Settings", { category: "surface" }),
    row("action:set-default", "Set default agent", { category: "command" }),
    row("setting:theme", "Reset layout", { category: "setting" }),
  ];
  const search = createPaletteIndex(rows);
  expect(search("set")[0]?.id).toBe("surface:settings");
  const frequent = signals({ "action:set-default": 50 });
  expect(search("set", { signals: frequent })[0]?.id).toBe(
    "action:set-default",
  );
  // Picking Reset layout after typing "set" also teaches "se".
  const learned = signals({}, { set: { "setting:theme": 1 } });
  expect(search("set", { signals: learned })[0]?.id).toBe("setting:theme");
  expect(search("se", { signals: learned })[0]?.id).toBe("setting:theme");
  // Longer queries learn less, and a strong label match still leads.
  expect(search("sett", { signals: learned })[0]?.id).toBe("surface:settings");
  expect(search("x", { signals: learned })).toEqual([]);
});

it("admits a fuzzy match the user picked before despite literal matches", () => {
  const rows = [
    ...Array.from({ length: 10 }, (_, index) =>
      row(`literal-${index}`, `Settings ${index}`),
    ),
    row("fuzzy", "Sidebar editor tools"),
  ];
  const search = createPaletteIndex(rows);
  expect(search("set").some((item) => item.id === "fuzzy")).toBe(false);
  expect(
    search("set", { signals: signals({}, { set: { fuzzy: 3 } }) }).some(
      (item) => item.id === "fuzzy",
    ),
  ).toBe(true);
});

it("boosts use inside the current project", () => {
  const search = createPaletteIndex([
    row("a", "Report A"),
    row("b", "Report B"),
  ]);
  const used = {
    usage: {
      a: { frecency: 5, projectId: "one" },
      b: { frecency: 5, projectId: "two" },
    },
    picks: {},
    frequentHistory: [],
  };
  expect(search("report", { signals: used, projectId: "two" })[0]?.id).toBe(
    "b",
  );
});

it("orders frequent rows by use, once each, with pages capped", async () => {
  const { frequentItems } = await import("./palette-search.js");
  const rows = [
    row("p1", "Page 1", { category: "page" }),
    row("p2", "Page 2", { category: "page" }),
    row("p3", "Page 3", { category: "bookmark" }),
    row("p4", "Page 4", { category: "page" }),
    row("c1", "Command", { category: "command" }),
    row("dup", "Duplicate A", { usage: "shared" }),
    row("dup-b", "Duplicate B", { usage: "shared" }),
    row("off", "Disabled", { disabled: true }),
    row("unused", "Unused"),
  ];
  const used = signals({
    p1: 90,
    p2: 80,
    p3: 70,
    p4: 60,
    c1: 1,
    shared: 5,
    off: 100,
  });
  expect(frequentItems(rows, { signals: used }).map((item) => item.id)).toEqual(
    ["p1", "p2", "p3", "dup", "c1"],
  );
});
