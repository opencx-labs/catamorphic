import { describe, expect, it } from "vitest";
import {
  detectedTag,
  detectorKnows,
  modelLanguage,
  translationRoute,
} from "./languages.js";

const pairs = new Set([
  "nl-en",
  "en-nl",
  "en-fr",
  "fr-en",
  "en-zh-Hant",
  "zh-Hans-en",
]);

describe("modelLanguage", () => {
  it("reads the language a page's tag names", () => {
    expect(modelLanguage("nl")).toBe("nl");
    expect(modelLanguage("EN-us")).toBe("en");
    expect(modelLanguage("pt-BR")).toBe("pt");
    expect(modelLanguage("iw")).toBe("he");
  });

  it("splits Chinese by script, as the models do", () => {
    expect(modelLanguage("zh")).toBe("zh-Hans");
    expect(modelLanguage("zh-CN")).toBe("zh-Hans");
    expect(modelLanguage("zh-TW")).toBe("zh-Hant");
    expect(modelLanguage("zh-HK")).toBe("zh-Hant");
    expect(modelLanguage("zh-Hant")).toBe("zh-Hant");
  });

  it("names Norwegian and Filipino as the models do", () => {
    expect(modelLanguage("no")).toBe("nb");
    expect(modelLanguage("fil")).toBe("tl");
  });

  it("refuses what is not a language tag", () => {
    expect(modelLanguage("en_US!")).toBeNull();
  });
});

describe("translationRoute", () => {
  it("uses a direct model", () => {
    expect(translationRoute("nl", "en-GB", pairs)).toEqual(["nl-en"]);
  });

  it("goes through English when no direct model exists", () => {
    expect(translationRoute("nl", "fr", pairs)).toEqual(["nl-en", "en-fr"]);
    expect(translationRoute("zh-CN", "zh-TW", pairs)).toEqual([
      "zh-Hans-en",
      "en-zh-Hant",
    ]);
  });

  it("has no route for a language without models, or to itself", () => {
    expect(translationRoute("nl", "ja", pairs)).toBeNull();
    expect(translationRoute("en", "en-US", pairs)).toBeNull();
    expect(translationRoute("bad tag!", "en", pairs)).toBeNull();
  });
});

describe("detection tags", () => {
  it("knows the detector's languages, by any tag", () => {
    expect(detectorKnows("nl-BE")).toBe(true);
    expect(detectorKnows("iw")).toBe(true);
    expect(detectorKnows("tlh")).toBe(false);
  });

  it("reports CLD3's Hebrew as BCP 47 does", () => {
    expect(detectedTag("iw")).toBe("he");
    expect(detectedTag("nl")).toBe("nl");
  });
});
