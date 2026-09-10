import { expect, it } from "vitest";
import {
  extractGuide,
  guideFileTarget,
  guidePrompt,
} from "./review-guide-document.js";

const files = [
  {
    path: "src/a b.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1 +1 @@\n-old\n+new",
  },
];

it("does not publish partial agent output as a completed guide", () => {
  expect(
    extractGuide("<!-- catamorphic-review-guide -->\n## Behavior\nUnfinished"),
  ).toBeUndefined();
  expect(
    extractGuide(
      "Prose\n<!-- catamorphic-review-guide -->\n## Behavior\nExplanation\n<!-- /catamorphic-review-guide -->\nOther text",
    ),
  ).toBe("## Behavior\nExplanation");
});

it("only opens file references present in the current pull request", () => {
  expect(guideFileTarget("#file=src%2Fa%20b.ts", files)?.path).toBe(
    "src/a b.ts",
  );
  expect(guideFileTarget("#file=..%2Fsecret", files)).toBeUndefined();
  expect(guideFileTarget("#file=%broken", files)).toBeUndefined();
  expect(guideFileTarget("https://example.com", files)).toBeUndefined();
});

it("bounds large patches without starving later files of evidence", () => {
  const prompt = guidePrompt({
    title: "Change",
    body: "Description",
    files: [
      {
        ...files[0],
        path: "large.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "x".repeat(200000),
      },
      {
        ...files[0],
        path: "second.ts",
        status: "modified",
        additions: 1,
        deletions: 0,
        patch: "small",
      },
    ],
  });
  const data = JSON.parse(prompt.split("Evidence: ")[1] ?? "[]");
  expect(data[0].patch).toHaveLength(16000);
  expect(data[0].incomplete).toBe(true);
  expect(data[1].patch).toBe("small");
  expect(data[1].incomplete).toBe(false);
});
