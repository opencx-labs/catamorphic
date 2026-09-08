import type { ProjectSummary } from "@catamorphic/react/types";
import { Check, Folder, MoreHorizontal, Star } from "lucide-react";
import type { Profile, ProfilesData } from "../lib/desktop-api";

export function ProfileInspector({
  profile,
  data,
  projects,
  current,
  onOpenSettings,
}: {
  profile: Profile;
  data: ProfilesData;
  projects: ProjectSummary[];
  current: boolean;
  onOpenSettings: () => void;
}) {
  const ownedProjects = projects.filter((project) =>
    profile.projectIds.includes(project.id),
  );
  const defaultProject = ownedProjects.find(
    (project) => project.id === profile.defaultProjectId,
  );
  const isDefault = profile.id === data.defaultProfileId;
  return (
    <div className="text-[12px] text-fg-muted" data-testid="profile-inspector">
      <header className="flex items-start gap-2 border-b border-border pb-2.5">
        <span
          className="mt-1 size-3 shrink-0 rounded-full"
          style={{ backgroundColor: profile.color }}
        />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5">
            <h2 className="truncate text-[13px] font-semibold text-fg">
              {profile.name}
            </h2>
            {current && (
              <Check
                className="size-3.5 text-accent"
                aria-label="Current profile"
              />
            )}
          </div>
          <p className="mt-0.5 text-[10px] text-fg-faint">{profile.id}</p>
        </div>
        <button
          type="button"
          onClick={onOpenSettings}
          aria-label={`Open settings for ${profile.name}`}
          className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-raised hover:text-fg"
        >
          <MoreHorizontal className="size-4" />
        </button>
      </header>
      <dl className="space-y-2 py-2.5">
        <div className="flex items-center gap-2">
          <Star
            className={`size-3.5 ${isDefault ? "fill-current text-accent" : "text-fg-faint"}`}
          />
          <dt className="flex-1">App opens with</dt>
          <dd className="text-fg">
            {isDefault ? "This profile" : "Another profile"}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <Folder className="size-3.5 text-fg-faint" />
          <dt className="flex-1">Projects</dt>
          <dd className="text-fg">{ownedProjects.length}</dd>
        </div>
        <div className="flex items-center gap-2">
          <Folder className="size-3.5 text-fg-faint" />
          <dt className="flex-1">Default project</dt>
          <dd className="max-w-40 truncate text-fg">
            {defaultProject?.name ?? "None"}
          </dd>
        </div>
      </dl>
      {ownedProjects.length > 0 && (
        <div className="border-t border-border pt-2">
          <p className="mb-1 text-[10px] font-semibold uppercase tracking-wide text-fg-faint">
            Project membership
          </p>
          <div className="flex flex-wrap gap-1">
            {ownedProjects.map((project) => (
              <span
                key={project.id}
                className="max-w-full truncate rounded bg-bg-raised px-1.5 py-0.5 text-[10px] text-fg-muted"
              >
                {project.name}
              </span>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
