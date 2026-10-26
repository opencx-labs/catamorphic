import { describe, expect, it } from "vitest";
import { WindowImages } from "./window-images.js";

const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47]);

function gate(icons: Record<string, string[]> = {}, seen: string[] = []) {
  const fetched: string[] = [];
  const images = new WindowImages({
    siteIcons: (_profileId, origin) => icons[origin] ?? [],
    seenIcon: (_profileId, icon) => seen.includes(icon),
    fetch: async (url) => {
      fetched.push(url);
      return new Response(PNG, { headers: { "content-type": "image/png" } });
    },
  });
  return { images, fetched };
}

describe("WindowImages", () => {
  it("serves a site's icon only when the profile saw the site show it", async () => {
    const icon = "https://github.githubassets.com/favicons/favicon.png";
    const { images, fetched } = gate({ "https://github.com": [icon] });
    expect(
      await images.image("p", { site: { page: "https://github.com/pulls" } }),
    ).toBe("data:image/png;base64,iVBORw==");
    expect(fetched).toEqual([icon]);
    // A site nobody visited: nothing is contacted.
    expect(
      await images.image("p", {
        site: { page: "https://secret.attacker.example/" },
      }),
    ).toBeNull();
    expect(fetched).toEqual([icon]);
  });

  it("refuses an icon a page never showed, even for a visited site", async () => {
    const icon = "https://github.githubassets.com/favicons/favicon.png";
    const { images, fetched } = gate({ "https://github.com": [icon] });
    await images.image("p", {
      site: {
        page: "https://github.com/",
        icon: "https://attacker.example/p.png?d=secret",
      },
    });
    // The site's own icon stands in; the named one is never fetched.
    expect(fetched).toEqual([icon]);
  });

  it("serves a bare icon a tab reported only once a page showed it", async () => {
    const icon = "https://example.com/favicon.ico";
    expect(await gate().images.image("p", { site: { icon } })).toBeNull();
    expect(
      await gate({}, [icon]).images.image("p", { site: { icon } }),
    ).toMatch(/^data:image\//);
  });

  it("serves an address only when a catalog Work fetched named it", async () => {
    const { images, fetched } = gate();
    const url = "https://attacker.example/p.png?d=secret";
    expect(await images.image("p", { url })).toBeNull();
    expect(fetched).toEqual([]);
    images.list("https://registry.example/icon.png");
    expect(
      await images.image("p", { url: "https://registry.example/icon.png" }),
    ).toMatch(/^data:image\/png/);
    expect(fetched).toEqual(["https://registry.example/icon.png"]);
  });

  it("passes inline images through and refuses other schemes", async () => {
    const { images, fetched } = gate();
    expect(await images.image("p", { url: "data:image/png;base64,AA==" })).toBe(
      "data:image/png;base64,AA==",
    );
    images.list("file:///etc/passwd");
    expect(await images.image("p", { url: "file:///etc/passwd" })).toBeNull();
    expect(fetched).toEqual([]);
  });

  it("refuses an answer that is too large or is a page", async () => {
    const large = new WindowImages({
      siteIcons: () => [],
      seenIcon: () => false,
      fetch: async () =>
        new Response(new Uint8Array(5 * 1024 * 1024), {
          headers: { "content-type": "image/png" },
        }),
    });
    large.list("https://x.example/a.png");
    expect(
      await large.image("p", { url: "https://x.example/a.png" }),
    ).toBeNull();
    const page = new WindowImages({
      siteIcons: () => [],
      seenIcon: () => false,
      fetch: async () =>
        new Response("<html></html>", {
          headers: { "content-type": "text/html" },
        }),
    });
    page.list("https://x.example/a.png");
    expect(
      await page.image("p", { url: "https://x.example/a.png" }),
    ).toBeNull();
  });
});
