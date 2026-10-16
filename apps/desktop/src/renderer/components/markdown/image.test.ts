import { expect, it } from "vitest";
import { imageLocation } from "./image.js";

it("finds an image's source: web URLs as they are, files in the project", () => {
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
  // Beside the document, or from the project's root as a repository's
  // markdown means a leading slash.
  expect(at("assets/logo%20v2.png?raw=1#top")).toEqual({
    path: "docs/assets/logo v2.png",
  });
  expect(at("./a.png")).toEqual({ path: "docs/a.png" });
  expect(at("../a.png")).toEqual({ path: "a.png" });
  expect(at("/assets/a.png")).toEqual({ path: "assets/a.png" });
  expect(at("a.png", "notes.md")).toEqual({ path: "a.png" });
  // Never outside the project.
  expect(at("../../a.png")).toBeNull();
  expect(at("%2e%2e/%2e%2e/a.png")).toBeNull();
  expect(at("/../a.png")).toBeNull();
  expect(at("file:///Users/me/a.png")).toBeNull();
  expect(at("C:\\Users\\me\\a.png")).toBeNull();
  expect(at("a.png", "/Users/me/notes.md")).toBeNull();
  // Shown only when it is safe to load as it is.
  expect(at("http://example.com/a.png")).toBeNull();
  expect(at("javascript:alert(1)")).toBeNull();
  expect(at("data:text/html,hi")).toBeNull();
  expect(at("")).toBeNull();
  // No document to start from: web images only.
  expect(at("a.png", null)).toBeNull();
  expect(at("https://example.com/a.png", null)).toEqual({
    url: "https://example.com/a.png",
  });
});
