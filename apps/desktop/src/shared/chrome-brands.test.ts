import { describe, expect, it } from "vitest";
import { chromeBrandHeaders, chromeBrandLists } from "./chrome-brands.js";

describe("Chrome's client-hint brands", () => {
  it("are what Chrome 156 sends, placeholder first", () => {
    expect(chromeBrandHeaders({ fullVersion: "156.0.8078.12" })).toEqual({
      brands:
        '"Not:A-Brand";v="8", "Chromium";v="156", "Google Chrome";v="156"',
      fullVersionList:
        '"Not:A-Brand";v="8.0.0.0", "Chromium";v="156.0.8078.12", "Google Chrome";v="156.0.8078.12"',
    });
  });

  it("change placeholder, version and order with the major, as Chrome's do", () => {
    // Values real Chrome releases sent.
    const brands = (fullVersion: string) =>
      chromeBrandHeaders({ fullVersion }).brands;
    expect(brands("116.0.5845.96")).toBe(
      '"Chromium";v="116", "Not)A;Brand";v="24", "Google Chrome";v="116"',
    );
    expect(brands("120.0.6099.71")).toBe(
      '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"',
    );
    expect(brands("124.0.6367.60")).toBe(
      '"Chromium";v="124", "Google Chrome";v="124", "Not-A.Brand";v="99"',
    );
  });

  it("keep the lists for navigator.userAgentData in the same order", () => {
    const { brands, fullVersionList } = chromeBrandLists({
      fullVersion: "156.0.8078.12",
    });
    expect(brands.map((entry) => entry.brand)).toEqual(
      fullVersionList.map((entry) => entry.brand),
    );
    expect(fullVersionList.at(-1)).toEqual({
      brand: "Google Chrome",
      version: "156.0.8078.12",
    });
  });
});
