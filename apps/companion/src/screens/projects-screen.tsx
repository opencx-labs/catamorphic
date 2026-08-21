import { useQueries } from "@tanstack/react-query";
import { ChevronRight, FolderGit2, Plus } from "lucide-react";
import { Screen } from "../components/screen.js";
import { clientFor, fetchMe } from "../lib/api.js";
import { navigate } from "../lib/nav.js";
import {
  activeProfile,
  type CompanionConnection,
  useCompanionState,
} from "../lib/store.js";

interface ProjectRow {
  connection: CompanionConnection;
  projectId: string;
  name: string;
  host: string;
}

/**
 * Every project the active profile can reach, across all its connections.
 * A scoped invite yields its one project; a root token (e.g. the desktop's
 * own embedded server during development) yields the server's full list.
 */
export function ProjectsScreen({ animation }: { animation?: string }) {
  const state = useCompanionState();
  const profile = activeProfile(state);

  const results = useQueries({
    queries: profile.connections.map((connection) => ({
      queryKey: ["companion", "connection-projects", connection.id],
      staleTime: 30_000,
      queryFn: async (): Promise<ProjectRow[]> => {
        const host = new URL(connection.serverUrl).host;
        const client = clientFor(connection);
        const me = await fetchMe(connection);
        if (me.identity.root) {
          const list = await client.GET("/api/projects");
          const projects = list.data?.items ?? [];
          if (projects.length > 0) {
            return projects.map((project) => ({
              connection,
              projectId: project.id,
              name: project.name,
              host,
            }));
          }
        }
        let name = connection.projectName ?? "Project";
        try {
          const project = await client.GET("/api/projects/{projectId}", {
            params: { path: { projectId: connection.projectId } },
          });
          if (project.data?.name) name = project.data.name;
        } catch {
          // Keep the link's display name.
        }
        return [{ connection, projectId: connection.projectId, name, host }];
      },
    })),
  });

  const rows = results.flatMap((result) => result.data ?? []);
  const loading = results.some((result) => result.isLoading);
  const failed = results.filter((result) => result.isError).length;

  return (
    <Screen
      title="Projects"
      animation={animation}
      trailing={
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={() => navigate({ kind: "connect" })}
            className="grid size-10 cursor-pointer place-items-center rounded-lg text-fg-muted active:bg-bg-overlay"
            aria-label="Connect a project"
            data-testid="projects-add"
          >
            <Plus className="size-5" />
          </button>
          <button
            type="button"
            onClick={() => navigate({ kind: "profiles" })}
            className="grid size-10 cursor-pointer place-items-center rounded-lg active:bg-bg-overlay"
            aria-label={`Profile: ${profile.name}`}
            data-testid="projects-profile"
          >
            <span
              className="grid size-6 place-items-center rounded-full text-[11px] font-bold text-white"
              style={{ backgroundColor: profile.color }}
            >
              {profile.name.slice(0, 1).toUpperCase()}
            </span>
          </button>
        </div>
      }
    >
      <div className="h-full overflow-y-auto overscroll-contain">
        {rows.length === 0 && !loading && (
          <div className="flex h-full flex-col items-center justify-center gap-3 p-8 text-center">
            <FolderGit2 className="size-8 text-fg-faint" />
            <p className="text-sm leading-6 text-fg-muted">
              {failed > 0
                ? "Couldn't reach your projects. Pull yourself together, network."
                : "No projects yet. Connect one with an invite link."}
            </p>
            <button
              type="button"
              onClick={() => navigate({ kind: "connect" })}
              className="h-10 rounded-lg bg-accent px-4 text-[14px] font-semibold text-accent-fg active:scale-[0.98]"
            >
              Connect a project
            </button>
          </div>
        )}
        <ul className="flex flex-col py-1">
          {rows.map((row) => (
            <li key={`${row.connection.id}:${row.projectId}`}>
              <button
                type="button"
                onClick={() =>
                  navigate({
                    kind: "sessions",
                    connectionId: row.connection.id,
                    projectId: row.projectId,
                  })
                }
                className="row-press flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left"
                data-testid="project-row"
              >
                <span className="grid size-10 shrink-0 place-items-center rounded-xl border border-border bg-bg-raised">
                  <FolderGit2 className="size-5 text-fg-muted" />
                </span>
                <span className="min-w-0 flex-1">
                  <span className="block truncate text-[15px] font-medium leading-6">
                    {row.name}
                  </span>
                  <span className="block truncate text-xs leading-4 text-fg-faint">
                    {row.host}
                  </span>
                </span>
                <ChevronRight className="size-4 shrink-0 text-fg-faint" />
              </button>
            </li>
          ))}
        </ul>
        {failed > 0 && rows.length > 0 && (
          <p className="px-4 py-2 text-xs text-danger">
            {failed === 1
              ? "One connection is unreachable."
              : `${failed} connections are unreachable.`}
          </p>
        )}
      </div>
    </Screen>
  );
}
