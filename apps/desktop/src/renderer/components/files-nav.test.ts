// @vitest-environment jsdom

import { describe, expect, it } from "vitest";
import { buildTree, isVisibleProjectFile } from "./files-nav.js";

describe("buildTree", () => {
  it("groups files into stable folder-first navigation", () => {
    expect(
      buildTree([
        "README.md",
        "store/customers/acme/qbr.md",
        "store/customers/acme/notes.md",
        "apps/demo/index.tsx",
      ]),
    ).toEqual([
      {
        name: "apps",
        path: "apps",
        children: [
          {
            name: "demo",
            path: "apps/demo",
            children: [{ name: "index.tsx", path: "apps/demo/index.tsx" }],
          },
        ],
      },
      {
        name: "store",
        path: "store",
        children: [
          {
            name: "customers",
            path: "store/customers",
            children: [
              {
                name: "acme",
                path: "store/customers/acme",
                children: [
                  { name: "notes.md", path: "store/customers/acme/notes.md" },
                  { name: "qbr.md", path: "store/customers/acme/qbr.md" },
                ],
              },
            ],
          },
        ],
      },
      { name: "README.md", path: "README.md" },
    ]);
  });
});

describe("isVisibleProjectFile", () => {
  it("shows downloaded work without internal setup files", () => {
    expect(isVisibleProjectFile("store/customers/acme/qbr.md", true)).toBe(
      true,
    );
    expect(isVisibleProjectFile("playbooks/customer-checkin.md", true)).toBe(
      true,
    );
    expect(isVisibleProjectFile(".agents/skills/setup/SKILL.md", true)).toBe(
      false,
    );
    expect(isVisibleProjectFile("apps/demo/index.tsx", false)).toBe(true);
  });
});
