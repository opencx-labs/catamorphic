import type { ProjectSummary } from "@catamorphic/react/types";
import { Folder, Plug, Settings } from "lucide-react";
import { useEffect, useState } from "react";
import {
  desktopApi,
  type Profile,
  type ProfileSummary,
  type ProfilesData,
} from "../lib/desktop-api";
import { HarnessIcon } from "./harness-icon";
import { ProfileAvatar } from "./profile-avatar";

/** Projects listed before the rest collapse into a count. */
const PROJECTS_SHOWN = 5;
/** Connections named before the rest collapse into a count. */
const CONNECTIONS_NAMED = 3;

/**
 * A profile's preview card: what it holds (projects) and what sets it apart
 * (its default agent and connections), with a way into its settings.
 */
export function ProfileInspector({
  profile,
  data,
  projects,
  onOpenProject,
  onOpenSettings,
}: {
  profile: Profile;
  data: ProfilesData;
  projects: ProjectSummary[];
  onOpenProject: (projectId: string) => void;
  onOpenSettings: () => void;
}) {
  const summary = useProfileSummary(profile.id);
  // The default project leads; the rest keep the profile's own order.
  const owned = projects
    .filter((project) => profile.projectIds.includes(project.id))
    .sort(
      (a, b) =>
        Number(b.id === profile.defaultProjectId) -
        Number(a.id === profile.defaultProjectId),
    );
  const shown = owned.slice(0, PROJECTS_SHOWN);
  const isDefault = profile.id === data.defaultProfileId;
  return (
    <div className="text-[12px] text-fg-muted" data-testid="profile-inspector">
      <header className="flex items-center gap-2.5 pb-2.5">
        <ProfileAvatar profile={profile} size="lg" />
        <div className="flex min-w-0 flex-1 items-center gap-1.5">
          <h2 className="truncate text-[13px] font-semibold text-fg">
            {profile.name}
          </h2>
          {isDefault && (
            <span className="shrink-0 rounded bg-bg-raised px-1.5 py-px text-[10px] font-medium text-fg-muted">
              Default
            </span>
          )}
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={`Open settings for ${profile.name}`}
          className="grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-raised hover:text-fg"
        >
          <Settings className="size-3.5" />
        </button>
      </header>

      <section className="border-t border-border pt-2">
        <h3 className="mb-1 px-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
          Projects
        </h3>
        {shown.length === 0 ? (
          <p className="px-1 pb-1 text-fg-faint">No projects yet</p>
        ) : (
          <ul>
            {shown.map((project) => (
              <li key={project.id}>
                <button
                  type="button"
                  onClick={() => onOpenProject(project.id)}
                  className="flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-1 text-left text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
                >
                  <Folder className="size-3.5 shrink-0 text-fg-faint" />
                  <span className="min-w-0 flex-1 truncate">
                    {project.name}
                  </span>
                  {project.id === profile.defaultProjectId && (
                    <span className="shrink-0 text-[10px] text-fg-faint">
                      Opens first
                    </span>
                  )}
                </button>
              </li>
            ))}
          </ul>
        )}
        {owned.length > shown.length && (
          <p className="px-1 pt-0.5 text-[11px] text-fg-faint">
            {owned.length - shown.length} more
          </p>
        )}
      </section>

      <dl className="mt-2 space-y-1.5 border-t border-border px-1 pt-2.5">
        <div className="flex items-center gap-2">
          <dt className="w-20 shrink-0 text-fg-faint">Agent</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-1.5 text-fg">
            {summary === "loading" ? (
              <Pending />
            ) : summary === "failed" ? (
              <span className="text-fg-faint">Unavailable</span>
            ) : summary.agent ? (
              <>
                <HarnessIcon
                  harness={summary.agent.harness}
                  provider={summary.agent.provider}
                  className="size-3.5 shrink-0"
                />
                <span className="truncate">{summary.agent.name}</span>
              </>
            ) : (
              <span className="text-fg-faint">None</span>
            )}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="w-20 shrink-0 text-fg-faint">Connections</dt>
          <dd className="flex min-w-0 flex-1 items-center gap-1.5 text-fg">
            {summary === "loading" ? (
              <Pending />
            ) : summary === "failed" ? (
              <span className="text-fg-faint">Unavailable</span>
            ) : summary.connections.length > 0 ? (
              <>
                <Plug className="size-3.5 shrink-0 text-fg-faint" />
                <span className="truncate">
                  {connectionsLabel(summary.connections)}
                </span>
              </>
            ) : (
              <span className="text-fg-faint">None</span>
            )}
          </dd>
        </div>
      </dl>
    </div>
  );
}

/** Holds a value's line while the summary loads, so the card never jumps. */
function Pending() {
  return (
    <span className="h-3 w-24 animate-pulse rounded bg-bg-raised">
      <span className="sr-only">Loading</span>
    </span>
  );
}

export function connectionsLabel(names: string[]): string {
  const named = names.slice(0, CONNECTIONS_NAMED).join(", ");
  const rest = names.length - CONNECTIONS_NAMED;
  return rest > 0 ? `${named} and ${rest} more` : named;
}

/** Loads on inspection: the card mounts only when it opens. */
function useProfileSummary(
  profileId: string,
): ProfileSummary | "loading" | "failed" {
  const [summary, setSummary] = useState<ProfileSummary | "loading" | "failed">(
    "loading",
  );
  useEffect(() => {
    let current = true;
    setSummary("loading");
    desktopApi.profileSummary(profileId).then(
      (loaded) => {
        if (current) setSummary(loaded);
      },
      () => {
        if (current) setSummary("failed");
      },
    );
    return () => {
      current = false;
    };
  }, [profileId]);
  return summary;
}
