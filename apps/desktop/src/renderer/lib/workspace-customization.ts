import { PROJECT_WORKSPACE_CONFIG_PATH } from "@catamorphic/workflow/project-layout";
import type { PendingChatMessage } from "../../shared/chat.js";
import type { WorkspaceConfig } from "../../shared/workspace-config.js";
import type { WorkspaceLayer } from "./desktop-api.js";

/**
 * The "Customize sidebar" chat's first message. The user sees one sentence
 * and two pills. The file path and the layout contract are agent context,
 * never prose in the message: a path pill carries only its reference, so
 * the contract and the current layout travel as a pasted block the
 * harness fences.
 */
export function workspaceCustomizationMessage({
  side,
  file,
  layer,
  config,
}: {
  side: "left" | "right";
  /** The winning layer's file, or the profile file for the built-in default. */
  file: string;
  layer: WorkspaceLayer;
  config: WorkspaceConfig;
}): PendingChatMessage {
  return {
    text: `Help me customize my ${side} sidebar. Walk me through the available tabs and widgets, then make the changes I ask for.`,
    attachments: [
      {
        kind: "text",
        name: file.slice(file.lastIndexOf("/") + 1),
        source: { type: "path", path: file },
        text: file,
      },
      {
        kind: "text",
        name: "Workspace configuration",
        source: { type: "paste" },
        text: [
          `The live workspace configuration file on this machine is ${JSON.stringify(file)}. Read it first, or create it from the current layout below if it does not exist. Edits apply live.`,
          "The file exports module.exports = { sidebars: { left: [...], right: [...] }, palette: { modes: [...] } }. Each tab has a stable id, title, Lucide icon and sections. Each section has a stable id and type (bookmarks, tabs, workflows, apps, chats, files, remote, git, prs, activity, note, custom or app). palette is optional. Preserve existing ids, the other sidebar and any palette modes. Profile selection and Settings are fixed in the left footer. A single tab hides its icon strip. Load the configuring-catamorphic-desktop skill for the full contract.",
          layer === "project"
            ? `This is the project's shared file (${PROJECT_WORKSPACE_CONFIG_PATH}): changes reach everyone in the project once committed.`
            : "This is a local file: do not commit it.",
          `Current layout: ${JSON.stringify(config)}`,
        ].join("\n\n"),
      },
    ],
  };
}
