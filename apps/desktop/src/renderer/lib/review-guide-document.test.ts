import { expect, it } from "vitest";
import { guidePrompt } from "./review-guide-document.js";

const files = [
  {
    path: "src/a b.ts",
    status: "modified",
    additions: 1,
    deletions: 0,
    patch: "@@ -1 +1 @@\n-old\n+new",
  },
];

it("produces an ordinary session app with immutable evidence and a shared review kit", () => {
  const prompt = guidePrompt({
    projectId: "project",
    number: 12,
    title: "Change",
    body: "Body",
    revision: "abc123",
    files,
    artifactId: "existing",
  });
  expect(prompt).toContain("read and update artifact existing");
  expect(prompt).toContain("components.read");
  expect(prompt).toContain("code-review");
  expect(prompt).toContain("temporary app files");
  expect(prompt).toContain("Do not publish or edit the user's checkout");
  expect(prompt).toContain('"evidenceFingerprint":"abc123"');
  expect(prompt).not.toContain("catamorphic-review-guide");
});

it("bounds large patches without starving later files of evidence", () => {
  const prompt = guidePrompt({
    projectId: "project",
    number: 12,
    revision: "abc123",
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
