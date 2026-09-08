import { describe, expect, it } from "vitest";
import {
  type SidebarConfig,
  sidebarSections,
  visibleSidebarConfig,
} from "./sidebar.js";

describe("sidebar presentation", () => {
  it("filters tabs, sections and nested links consistently for every consumer", () => {
    const config: SidebarConfig = {
      left: [
        {
          id: "private",
          title: "Private",
          when: { permissions: ["brain:maintain"] },
          sections: [
            {
              id: "private-links",
              type: "custom",
              items: [{ label: "Hidden", url: "https://example.test/private" }],
            },
          ],
        },
      ],
      right: [
        {
          id: "work",
          title: "Work",
          sections: [
            { id: "git", type: "git" },
            {
              id: "links",
              type: "custom",
              items: [
                {
                  label: "Folder",
                  items: [
                    { label: "Public", url: "https://example.test" },
                    {
                      label: "Builder",
                      url: "https://example.test/builder",
                      when: { builder: true },
                    },
                  ],
                },
              ],
            },
          ],
        },
      ],
    };
    const visible = visibleSidebarConfig({
      config,
      context: { root: false, builder: false, permissions: [] },
    });
    expect(visible?.left).toEqual([]);
    expect(sidebarSections(visible).map((section) => section.id)).toEqual([
      "links",
    ]);
    expect(
      sidebarSections(visible)[0]?.items?.[0]?.items?.map((item) => item.label),
    ).toEqual(["Public"]);
    expect(config.right[0]?.sections).toHaveLength(2);
  });
});
