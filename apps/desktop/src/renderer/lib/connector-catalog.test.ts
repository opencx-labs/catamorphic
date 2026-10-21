import { describe, expect, it } from "vitest";
import {
  brandPage,
  groupByCategory,
  OTHER_CATEGORY,
  type PluginEntry,
  pluginTitle,
  registryPublisher,
  repeatedNames,
  searchCatalog,
} from "./connector-catalog";

const plugin = (
  name: string,
  extra: Partial<PluginEntry> = {},
): PluginEntry => ({
  name,
  description: "",
  marketplace: "acme/plugins",
  installed: false,
  official: false,
  ...extra,
});

describe("pluginTitle", () => {
  it("prefers the catalog's display name", () => {
    expect(
      pluginTitle({ name: "hubspot-sales", displayName: "HubSpot Sales" }),
    ).toBe("HubSpot Sales");
  });

  it("spells a slug in words, keeping known capitals", () => {
    expect(pluginTitle({ name: "agent-sdk-dev" })).toBe("Agent SDK Dev");
    expect(pluginTitle({ name: "pr-review-toolkit" })).toBe(
      "PR Review Toolkit",
    );
    expect(pluginTitle({ name: "typescript-lsp" })).toBe("TypeScript LSP");
    expect(pluginTitle({ name: "42crunch-api-security-testing" })).toBe(
      "42crunch API Security Testing",
    );
  });
});

describe("groupByCategory", () => {
  it("orders known categories first, the rest alphabetically, uncategorized last", () => {
    const groups = groupByCategory([
      plugin("a", { category: "zebra" }),
      plugin("b"),
      plugin("c", { category: "development" }),
      plugin("d", { category: "productivity" }),
      plugin("e", { category: "alpha" }),
    ]);
    expect(groups.map((group) => group.category)).toEqual([
      "productivity",
      "development",
      "alpha",
      "zebra",
      OTHER_CATEGORY,
    ]);
    expect(groups.at(-1)?.label).toBe("More plugins");
  });

  it("puts named, signed entries first and otherwise keeps catalog order", () => {
    const [group] = groupByCategory([
      plugin("plain-one", { category: "design" }),
      plugin("signed", { category: "design", author: "Acme" }),
      plugin("plain-two", { category: "design" }),
      plugin("named", {
        category: "design",
        displayName: "Named",
        author: "Acme",
      }),
    ]);
    expect(group?.label).toBe("Design");
    expect(group?.entries.map((entry) => entry.name)).toEqual([
      "named",
      "signed",
      "plain-one",
      "plain-two",
    ]);
  });
});

describe("searchCatalog", () => {
  const catalog = [
    plugin("notes", { description: "Linear issues in your notes" }),
    plugin("issue-tracker", { author: "Linear" }),
    plugin("linear-sync"),
    plugin("my-linear"),
  ];

  it("ranks name prefixes, then names, then publishers, then descriptions", () => {
    expect(
      searchCatalog(catalog, " Linear ").map((entry) => entry.name),
    ).toEqual(["linear-sync", "my-linear", "issue-tracker", "notes"]);
  });

  it("keeps the whole catalog for an empty query", () => {
    expect(searchCatalog(catalog, "  ")).toBe(catalog);
  });
});

describe("repeatedNames", () => {
  it("finds names a list holds more than once", () => {
    const titles = [
      plugin("slack"),
      plugin("slack-by-salesforce", { displayName: "Slack" }),
      plugin("linear"),
    ].map(pluginTitle);
    expect([...repeatedNames(titles)]).toEqual(["Slack"]);
  });
});

describe("registryPublisher", () => {
  it("reads the namespace as the domain it reverses", () => {
    expect(registryPublisher("com.pulsemcp/slack")).toBe("pulsemcp.com");
    expect(registryPublisher("io.github.crunchtools/slack")).toBe(
      "crunchtools.github.io",
    );
    expect(registryPublisher("slack")).toBe("slack");
  });
});

describe("brandPage", () => {
  it("keeps vendor pages and drops code hosts and plain http", () => {
    expect(brandPage("https://www.hubspot.com/products")).toBe(
      "https://www.hubspot.com/products",
    );
    expect(brandPage("https://github.com/acme/plugin")).toBeUndefined();
    expect(brandPage("https://gitlab.com/acme/plugin")).toBeUndefined();
    expect(brandPage("http://acme.dev")).toBeUndefined();
    expect(brandPage("not a url")).toBeUndefined();
  });
});
