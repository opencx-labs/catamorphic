import type { ReactNode } from "react";
import { ProjectAuthorityProvider } from "./project-authority-provider.js";
import { useSidebarContent } from "./sidebar-contribution.js";

/** The project's access, while it is read or when it fails, as section status. */
function AccessStatus({ error }: { error: Error | null }) {
  useSidebarContent(
    error ? { state: "error", error: error.message } : { state: "loading" },
  );
  return null;
}

/**
 * Where a sidebar section reads a chat's session: the project's own access
 * (its server's cache for a connected project, shared with the chat), its
 * reading and failing shown as the section's status (ADR 0226).
 */
export function SessionAccess({
  projectId,
  children,
}: {
  projectId: string;
  children: ReactNode;
}) {
  return (
    <ProjectAuthorityProvider
      projectId={projectId}
      fallback={(error) => <AccessStatus error={error} />}
    >
      {children}
    </ProjectAuthorityProvider>
  );
}
