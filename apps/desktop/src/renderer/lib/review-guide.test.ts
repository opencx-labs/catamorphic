import { parsePatchFiles } from "@pierre/diffs";
import { describe, expect, it } from "vitest";
import { pullRequestPatch, reviewLocations } from "./review-guide.js";

describe("review navigation", () => {
  it("links deleted hunks to their original lines and additions to their new lines", () => {
    expect(
      reviewLocations(
        "@@ -9,3 +12,4 @@ function searchFiles()\n-old\n+new\n@@ -20,2 +25,0 @@\n-gone\n-gone too",
      ),
    ).toEqual([
      { label: "function searchFiles()", line: 12, side: "additions" },
      { label: "Line 20", line: 20, side: "deletions" },
    ]);
  });
  it("preserves rename paths without inventing a file mode", () => {
    const patch = pullRequestPatch({
      path: "new name.ts",
      previousPath: "old name.ts",
      status: "renamed",
      patch: "@@ -1 +1 @@\n-before\n+after\n",
    });
    const file = parsePatchFiles(patch, undefined, true)[0]?.files[0];
    expect(patch).toContain("rename from old name.ts");
    expect(patch).toContain("rename to new name.ts");
    expect(file?.name).toBe("new name.ts");
    expect(file?.mode).toBeUndefined();
  });
});
