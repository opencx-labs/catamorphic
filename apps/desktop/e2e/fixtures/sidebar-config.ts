import fs from "node:fs/promises";
import { DEFAULT_SIDEBAR_CONFIG } from "../../src/main/sidebar-config.js";
import type { SidebarConfig } from "../../src/shared/sidebar.js";
import type { AppHandle } from "../harness.js";

/** Opt-in widgets for suites that exercise populated sidebar behavior. */
export const REVIEW_SIDEBAR_CONFIG: SidebarConfig = {
  ...DEFAULT_SIDEBAR_CONFIG,
  right: [
    {
      id: "companion",
      title: "Activity",
      icon: "Activity",
      sections: [
        { id: "activity", type: "activity" },
        {
          id: "subsessions",
          type: "subsessions",
          title: "Subsessions",
          when: { surface: ["chat"], session: true },
          hideEmpty: true,
        },
        { id: "changes", type: "git", hideEmpty: true },
      ],
    },
    {
      id: "reviews",
      title: "Proposals",
      icon: "GitPullRequest",
      sections: [{ id: "prs", type: "prs" }],
    },
  ],
};

export async function configureReviewSidebar(app: AppHandle): Promise<void> {
  const file = await app.eval<string>(
    "window.catamorphicDesktop.sidebarConfigFile()",
  );
  await fs.writeFile(
    file,
    `module.exports = ${JSON.stringify(REVIEW_SIDEBAR_CONFIG)};\n`,
  );
}
