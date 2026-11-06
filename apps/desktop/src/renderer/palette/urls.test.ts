import { describe, expect, it } from "vitest";
import { bareUrl, hostOf, rememberedOrigins } from "./urls.js";

describe("palette URLs", () => {
  const pages = [
    { url: "http://localhost:3000/inbox", visitCount: 101 },
    { url: "http://localhost:3000/", visitCount: 79 },
    { url: "http://localhost:5174/", visitCount: 1 },
    { url: "http://127.0.0.1:4174/", visitCount: 15 },
    { url: "https://www.github.com/pulls", visitCount: 4 },
  ];

  it("opens a typed bare host where it was visited, port included, most visited first", () => {
    expect(rememberedOrigins("localhost", pages)).toEqual([
      "http://localhost:3000",
      "http://localhost:5174",
    ]);
    expect(rememberedOrigins("github.com", pages)).toEqual([
      "https://www.github.com",
    ]);
    expect(rememberedOrigins("127.0.0.1", pages)).toEqual([
      "http://127.0.0.1:4174",
    ]);
  });

  it("keeps whatever is already specific, and what it has never seen", () => {
    expect(rememberedOrigins("localhost:5174", pages)).toEqual([]);
    expect(rememberedOrigins("localhost/inbox", pages)).toEqual([]);
    expect(rememberedOrigins("http://localhost", pages)).toEqual([]);
    expect(rememberedOrigins("example.com", pages)).toEqual([]);
  });

  it("names hosts and URLs as people type them", () => {
    expect(hostOf("https://www.github.com/pulls")).toBe("github.com");
    expect(hostOf("http://localhost:3000/inbox")).toBe("localhost:3000");
    expect(bareUrl("http://localhost:3000")).toBe("localhost:3000");
  });
});
