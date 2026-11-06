import fs from "node:fs";
import path from "node:path";
import { PROJECT_GITIGNORE } from "@catamorphic/git";
import {
  isProjectPathWithin,
  PROJECT_APP_DATA_DIR,
  PROJECT_WORKSPACE_ROOT,
} from "@catamorphic/workflow/project-layout";

export const PROJECT_WORKSPACE_IGNORE = PROJECT_GITIGNORE;

/** Create the local workspace on first use; never rewrite the owner's ignore choices. */
export function ensureProjectWorkspace({ root }: { root: string }): void {
  const directory = path.join(root, PROJECT_WORKSPACE_ROOT);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink())
    throw new Error(
      `The ${PROJECT_WORKSPACE_ROOT} folder cannot be a symbolic link`,
    );
  fs.mkdirSync(directory, { recursive: true });
  try {
    fs.writeFileSync(
      path.join(directory, ".gitignore"),
      PROJECT_WORKSPACE_IGNORE,
      { flag: "wx" },
    );
  } catch (error) {
    if (!(error instanceof Error && "code" in error && error.code === "EEXIST"))
      throw error;
  }
}

/** Document addresses remain portable while their local backing stays in app-data. */
export function localDocumentRelativePath(relative: string): string {
  return relative.startsWith("store/")
    ? `${PROJECT_APP_DATA_DIR}/${relative}`
    : relative;
}

/** Persistent storage for trusted local app/workflow execution, created on demand. */
export function projectDataDirectory({ root }: { root: string }): string {
  ensureProjectWorkspace({ root });
  const directory = path.join(root, PROJECT_APP_DATA_DIR);
  const existing = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (existing?.isSymbolicLink())
    throw new Error("Project app data cannot be a symbolic link");
  fs.mkdirSync(directory, { recursive: true });
  return fs.realpathSync(directory);
}

/** Mutable project data is never served through the shared program surface. */
export function isProjectDataPath(relative: string): boolean {
  return isProjectPathWithin(relative, PROJECT_APP_DATA_DIR);
}
