import { expect, it } from "vitest";
import { imageLocation } from "./image.js";

it("finds an image's source: web URLs as they are, files beside the document", () => {
  const at = (src: string, documentPath: string | null = "docs/notes.md") =>
    imageLocation(src, documentPath);
  expect(at("https://example.com/a.png")).toEqual({
    url: "https://example.com/a.png",
  });
  expect(at("//example.com/a.png")).toEqual({
    url: "https://example.com/a.png",
  });
  expect(at("data:image/png;base64,AAAA")).toEqual({
    url: "data:image/png;base64,AAAA",
  });
  expect(at("assets/logo%20v2.png?raw=1#top")).toEqual({
    path: "docs/assets/logo v2.png",
  });
  expect(at("./a.png")).toEqual({ path: "docs/a.png" });
  expect(at("../a.png")).toEqual({ path: "a.png" });
  expect(at("../../a.png")).toEqual({ path: "../a.png" });
  // From the project's root, as a repository's markdown means it.
  expect(at("/assets/a.png")).toEqual({ path: "assets/a.png" });
  expect(at("/assets/a.png", "/Users/me/notes.md")).toEqual({
    path: "/assets/a.png",
  });
  expect(at("a.png", "/Users/me/notes.md")).toEqual({
    path: "/Users/me/a.png",
  });
  expect(at("file:///Users/me/a%20b.png")).toEqual({
    path: "/Users/me/a b.png",
  });
  expect(at("a.png", "notes.md")).toEqual({ path: "a.png" });
  // Shown only when it is safe to load as it is.
  expect(at("http://example.com/a.png")).toBeNull();
  expect(at("javascript:alert(1)")).toBeNull();
  expect(at("data:text/html,hi")).toBeNull();
  expect(at("")).toBeNull();
  // No document to be relative to: web images only.
  expect(at("a.png", null)).toBeNull();
  expect(at("https://example.com/a.png", null)).toEqual({
    url: "https://example.com/a.png",
  });
});
