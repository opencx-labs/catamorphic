import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  addedWarnings,
  bestIcon,
  defaultRulesets,
  localizer,
  ManifestError,
  manifestAction,
  parseManifest,
  permissionWarnings,
  requiredPermissions,
  searchProvider,
  stripJsonComments,
} from "./manifest.js";

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), "extension-manifest-"));
});
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true });
});

const base = { manifest_version: 3, name: "Test", version: "1.2.3" };

describe("parseManifest", () => {
  it("reads manifests with comments, as Chrome does", () => {
    const manifest = parseManifest(`{
      // the name
      "manifest_version": 3, "name": "A // not a comment", /* x */ "version": "1.0"
    }`);
    expect(manifest.name).toBe("A // not a comment");
    expect(stripJsonComments('"a\\"//b"')).toBe('"a\\"//b"');
  });

  it("refuses manifests Chrome would refuse", () => {
    expect(() => parseManifest("{")).toThrow(ManifestError);
    expect(() =>
      parseManifest(JSON.stringify({ ...base, manifest_version: 1 })),
    ).toThrow("manifest_version");
    expect(() =>
      parseManifest(JSON.stringify({ ...base, version: "1.0-beta" })),
    ).toThrow("version");
    expect(() => parseManifest(JSON.stringify({ ...base, name: "" }))).toThrow(
      "name",
    );
  });
});

describe("localizer", () => {
  it("resolves messages from the UI locale, then the default", () => {
    for (const [locale, messages] of Object.entries({
      en: { extName: { message: "Reader" }, desc: { message: "Dark" } },
      fr: { extName: { message: "Lecteur" } },
    })) {
      fs.mkdirSync(path.join(dir, "_locales", locale), { recursive: true });
      fs.writeFileSync(
        path.join(dir, "_locales", locale, "messages.json"),
        JSON.stringify(messages),
      );
    }
    const manifest = { ...base, default_locale: "en" };
    expect(localizer(dir, manifest, "fr-FR")("__MSG_extName__")).toBe(
      "Lecteur",
    );
    expect(localizer(dir, manifest, "fr-FR")("__MSG_DESC__")).toBe("Dark");
    expect(localizer(dir, manifest, "de")("__MSG_extName__")).toBe("Reader");
    expect(localizer(dir, manifest, "de")("__MSG_missing__")).toBe(
      "__MSG_missing__",
    );
  });
});

describe("manifest parts", () => {
  it("finds the action under any manifest version's key", () => {
    expect(
      manifestAction({
        ...base,
        action: { default_popup: "popup.html", default_icon: { 16: "i.png" } },
      }),
    ).toEqual({
      key: "action",
      popup: "popup.html",
      title: null,
      icon: { 16: "i.png" },
    });
    expect(
      manifestAction({
        ...base,
        manifest_version: 2,
        browser_action: { default_title: "T", default_icon: "a.png" },
      })?.key,
    ).toBe("browser_action");
    expect(manifestAction(base)).toBeNull();
  });

  it("picks the smallest icon at least as large as asked", () => {
    const icons = { 16: "16.png", 48: "48.png", 128: "128.png" };
    expect(bestIcon(icons, 32)).toBe("48.png");
    expect(bestIcon(icons, 256)).toBe("128.png");
    expect(bestIcon("one.png", 32)).toBe("one.png");
    expect(bestIcon(null, 32)).toBeNull();
  });

  it("lists rulesets enabled by default", () => {
    expect(
      defaultRulesets({
        ...base,
        declarative_net_request: {
          rule_resources: [
            { id: "easylist", enabled: true, path: "a.json" },
            { id: "annoyances", enabled: false, path: "b.json" },
          ],
        },
      }),
    ).toEqual(["easylist"]);
  });

  it("splits MV2 host permissions out of permissions", () => {
    expect(
      requiredPermissions({
        ...base,
        manifest_version: 2,
        permissions: ["tabs", "<all_urls>", "https://a.test/*"],
      }),
    ).toEqual({
      permissions: ["tabs"],
      origins: ["<all_urls>", "https://a.test/*"],
    });
  });

  it("reads a search provider only over https", () => {
    expect(
      searchProvider({
        ...base,
        chrome_settings_overrides: {
          search_provider: {
            name: "ChatGPT",
            keyword: "chatgpt.com",
            search_url: "https://chatgpt.com/?q={searchTerms}",
          },
        },
      }),
    ).toMatchObject({ name: "ChatGPT", keyword: "chatgpt.com" });
    expect(
      searchProvider({
        ...base,
        chrome_settings_overrides: {
          search_provider: {
            name: "x",
            search_url: "http://x.test/?q={searchTerms}",
          },
        },
      }),
    ).toBeNull();
  });
});

describe("permissionWarnings", () => {
  it("words an ad blocker the way Chrome does", () => {
    expect(
      permissionWarnings({
        ...base,
        permissions: ["declarativeNetRequest", "storage", "scripting"],
        host_permissions: ["<all_urls>"],
      }),
    ).toEqual([
      "Read and change all your data on all websites",
      "Block content on any page",
    ]);
  });

  it("counts content script sites as host access", () => {
    expect(
      permissionWarnings({
        ...base,
        content_scripts: [{ matches: ["https://*.example.com/*"], js: ["a"] }],
        permissions: ["tabs"],
      }),
    ).toEqual([
      "Read and change your data on example.com",
      "Read your browsing history",
    ]);
  });

  it("warns about the debugger and native apps", () => {
    const warnings = permissionWarnings({
      ...base,
      permissions: ["debugger", "nativeMessaging", "tabGroups", "downloads"],
    });
    expect(warnings[0]).toBe("Read and change all your data on all websites");
    expect(warnings).toContain("Access the page debugger backend");
    expect(warnings).toContain(
      "Communicate with cooperating native applications",
    );
    expect(warnings).toContain("View and manage your tab groups");
    expect(warnings).toContain("Manage your downloads");
  });

  it("reports only the warnings an update adds", () => {
    expect(
      addedWarnings(
        ["Read and change all your data on all websites"],
        [
          "Read and change all your data on all websites",
          "Manage your downloads",
        ],
      ),
    ).toEqual(["Manage your downloads"]);
  });
});
