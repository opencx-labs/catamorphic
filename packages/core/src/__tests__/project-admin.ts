import { EVERY_ARTIFACT, type Identity } from "../identity.js";

/**
 * What an admin role (`"agents": ["*"]`, `"workflows": ["*"]`,
 * `"apps": ["*"]`, `"permissions": ["*"]`) expands to on one project.
 */
export function projectAdmin(
  projectId: string,
): Pick<Identity, "scope" | "projectPermissions"> {
  return {
    scope: [
      { kind: "agent", projectId, name: EVERY_ARTIFACT },
      { kind: "workflow", projectId, name: EVERY_ARTIFACT },
      { kind: "app", projectId, name: EVERY_ARTIFACT },
    ],
    projectPermissions: [{ projectId, permission: "*" }],
  };
}
