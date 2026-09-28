import { describe, expect, it } from "vitest";
import { SiteIcons } from "./site-icons.js";

const dark = "https://github.githubassets.com/favicons/favicon-dark.png";
const light = "https://github.githubassets.com/favicons/favicon.png";

describe("SiteIcons", () => {
  it("keeps the icon a sign-in page showed, for its site", () => {
    const icons = new SiteIcons();
    expect(
      icons.observe({
        profileId: "p",
        pageUrl: "https://github.com/login",
        iconUrl: dark,
        scheme: "dark",
      }),
    ).toBe("https://github.com");
    expect(icons.get("p", "https://github.com", "dark")).toBe(dark);
    // Nothing changed, nothing to announce.
    expect(
      icons.observe({
        profileId: "p",
        pageUrl: "https://github.com/settings",
        iconUrl: dark,
        scheme: "dark",
      }),
    ).toBeNull();
  });

  it("answers with the icon made for the scheme, else the other one", () => {
    const icons = new SiteIcons();
    icons.observe({
      profileId: "p",
      pageUrl: "https://github.com/",
      iconUrl: dark,
      scheme: "dark",
    });
    expect(icons.get("p", "https://github.com", "light")).toBe(dark);
    icons.observe({
      profileId: "p",
      pageUrl: "https://github.com/",
      iconUrl: light,
      scheme: "light",
    });
    expect(icons.get("p", "https://github.com", "light")).toBe(light);
    expect(icons.get("p", "https://github.com", "dark")).toBe(dark);
  });

  it("keeps profiles apart and forgets a removed one", () => {
    const icons = new SiteIcons();
    icons.observe({
      profileId: "p",
      pageUrl: "https://github.com/",
      iconUrl: dark,
      scheme: "dark",
    });
    expect(icons.get("q", "https://github.com", "dark")).toBeNull();
    icons.releaseProfile("p");
    expect(icons.get("p", "https://github.com", "dark")).toBeNull();
  });

  it("ignores icons it could not show and pages with no site", () => {
    const icons = new SiteIcons();
    for (const [pageUrl, iconUrl] of [
      ["about:blank", dark],
      ["https://github.com/", "javascript:alert(1)"],
      ["https://github.com/", `data:image/png;base64,${"A".repeat(70_000)}`],
    ] as const)
      expect(
        icons.observe({ profileId: "p", pageUrl, iconUrl, scheme: "dark" }),
      ).toBeNull();
    expect(
      icons.observe({
        profileId: "p",
        pageUrl: "https://example.com/",
        iconUrl: "data:image/png;base64,iVBORw0KGgo=",
        scheme: "dark",
      }),
    ).toBe("https://example.com");
  });
});
