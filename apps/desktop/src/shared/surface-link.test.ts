import { describe, expect, it } from "vitest";
import {
  isBrowserFile,
  localFileUrl,
  parseSurfaceLink,
  resolveProjectFileLocation,
} from "./surface-link.js";

describe("workspace links", () => {
  it.each([
    ["main.ts:7", { kind: "file", path: "main.ts", line: 7 }],
    [
      "/project/src/main.ts:42:3",
      { kind: "file", path: "/project/src/main.ts", line: 42, column: 3 },
    ],
    ["src/main.ts#L12-L20", { kind: "file", path: "src/main.ts", line: 12 }],
    ["README.md", { kind: "file", path: "README.md" }],
    [
      "file:///project/My%20Report.pdf",
      { kind: "file", path: "/project/My Report.pdf" },
    ],
    ["file:store/notes.md", { kind: "file", path: "store/notes.md" }],
    ["workflow:sendDigest", { kind: "workflow", name: "sendDigest" }],
    ["app:weekly%20report", { kind: "app", name: "weekly report" }],
    ["terminal:abc", { kind: "tab", key: "terminal:abc" }],
    [
      "https://example.com/report.pdf",
      { kind: "browser", url: "https://example.com/report.pdf" },
    ],
  ])("resolves %s", (link, target) =>
    expect(parseSurfaceLink(link)).toEqual(target),
  );
  it.each([
    "javascript:alert(1)",
    "data:text/html,test",
    "file://remote/private",
    "app://remote",
    "#heading",
    "//remote/file",
    "file:%ZZ",
    "",
  ])("rejects unsafe or malformed target %s", (link) =>
    expect(parseSurfaceLink(link)).toBeNull(),
  );
  it("keeps absolute external artifacts distinct from project files", () => {
    expect(
      resolveProjectFileLocation("/work/repo", "/work/repo-copy/a.ts")
        .relativePath,
    ).toBe("/work/repo-copy/a.ts");
    expect(
      resolveProjectFileLocation("/work/repo", "docs/../README.md")
        .relativePath,
    ).toBe("README.md");
    expect(localFileUrl("/work/My #report.pdf")).toBe(
      "file:///work/My%20%23report.pdf",
    );
    expect(isBrowserFile("report.PDF")).toBe(true);
    expect(isBrowserFile("notes.md")).toBe(false);
  });
});
