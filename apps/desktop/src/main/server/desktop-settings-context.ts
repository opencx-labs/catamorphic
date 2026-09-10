import path from "node:path";
import type { ProfileConfigManager } from "../profile-config.js";
import {
  projectLocalSidebarFile,
  projectSidebarFile,
} from "../sidebar-config.js";

/** Host metadata, refreshed per turn; it grants no filesystem permissions. */
export function desktopSettingsContext({
  config,
  profileId,
  project,
  access,
}: {
  config: ProfileConfigManager;
  profileId: string;
  project: { id: string; rootPath: string | null };
  access: "native" | "read-only" | "unavailable";
}) {
  if (access === "unavailable")
    return {
      access,
      projectId: project.id,
      profileId,
      note: "Desktop host configuration is not accessible from this agent's filesystem. A similarly named sandbox file does not configure the desktop. Do not create a mirror directory or claim host settings changed.",
    };
  const stores = config.forProfile(profileId);
  const preferences = config.settingsFiles(profileId, project);
  return {
    access,
    projectId: project.id,
    profileId,
    files: {
      preferences,
      theme: {
        profile: stores.theme.file,
        project: preferences.project,
        personal: preferences.personal,
      },
      shortcuts: stores.keybindings.file,
      sidebar: {
        profile: stores.sidebar.file,
        personal: projectLocalSidebarFile(
          path.dirname(stores.sidebar.file),
          project.id,
        ),
        ...(project.rootPath
          ? { project: projectSidebarFile(project.rootPath) }
          : {}),
      },
    },
    errors: config.resolveSettings(profileId, project).errors,
    skill: "configuring-catamorphic-desktop",
    note:
      access === "read-only"
        ? "Inspect only. This agent is read-only; do not edit host configuration."
        : "These are host paths for the initiating project's owning profile, independent of the foreground window and any session worktree. Edit files directly with ordinary file or shell facilities. Native harness permissions still apply, especially outside the checkout; these paths do not grant access. Load the configuration skill for schemas, precedence and reset. Read affected files before and after editing. Validation errors appear here on the next turn and in Settings; valid changes apply live.",
  };
}
