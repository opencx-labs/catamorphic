import fs from "node:fs";
import { DEFAULT_WORKSPACE_CONFIG } from "../src/main/workspace-config.js";
import type { SidebarSectionConfig } from "../src/shared/sidebar.js";
import type { AppHandle } from "./harness.js";

/**
 * Chats as a sidebar list (ADR 0234). The default layout leaves them to
 * tabs and the palette; suites about the list add it.
 */
export const CHATS_SECTION: SidebarSectionConfig = {
  id: "chats",
  source: "work:chats",
  headerActions: [
    {
      label: "New chat",
      action: "open",
      icon: "Plus",
      url: "command:new-floating-chat",
    },
  ],
};

/**
 * The profile's layout: Work's default with `sections` added to the left
 * sidebar's first tab (or replacing ones with the same id), applied live.
 */
export async function writeSidebarSections(
  app: AppHandle,
  sections: SidebarSectionConfig[],
) {
  const file = await app.eval<string>(
    "window.catamorphicDesktop.workspaceConfigFile()",
  );
  const config = structuredClone(DEFAULT_WORKSPACE_CONFIG);
  const first = config.sidebars.left[0];
  if (!first) throw new Error("The default layout has no left tab");
  const ids = new Set(sections.map((section) => section.id));
  first.sections = [
    ...first.sections.filter((section) => !ids.has(section.id)),
    ...sections,
  ];
  fs.writeFileSync(file, `module.exports = ${JSON.stringify(config)};\n`);
}

/** As writeSidebarSections, waiting until each is mounted in the project. */
export async function addSidebarSections(
  app: AppHandle,
  sections: SidebarSectionConfig[],
) {
  await writeSidebarSections(app, sections);
  for (const section of sections)
    await app.waitFor(
      `!!document.querySelector('[data-workspace-visible="true"] [data-sidebar-widget="${section.id}"]')`,
    );
}
