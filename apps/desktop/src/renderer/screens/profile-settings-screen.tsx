import type { ProjectSummary } from "@catamorphic/react/types";
import { Check, Star, Trash2, X } from "lucide-react";
import { useEffect, useState } from "react";
import { BrowserImport } from "../components/browser-import";
import { PasswordManager } from "../components/password-manager";
import { PendingButton } from "../components/pending-button";
import {
  desktopApi,
  type Profile,
  type ProfilesData,
} from "../lib/desktop-api";

const PROFILE_COLORS = [
  "#8b5cf6",
  "#3b82f6",
  "#14b8a6",
  "#22c55e",
  "#f59e0b",
  "#f97316",
  "#ef4444",
  "#ec4899",
];

export function ProfileSettingsScreen({
  profileId,
  activeProfileId,
  data,
  projects,
  onClose,
}: {
  profileId: string;
  activeProfileId: string;
  data: ProfilesData;
  projects: ProjectSummary[];
  onClose: () => void;
}) {
  const profile = data.profiles.find((candidate) => candidate.id === profileId);
  if (!profile) {
    return (
      <div className="mx-auto w-full max-w-lg px-6 py-6">
        <h1 className="text-base font-semibold">Profile not found</h1>
        <p className="mt-2 text-sm text-fg-muted">
          This profile may have been removed in another window.
        </p>
        <button
          type="button"
          onClick={onClose}
          className="mt-4 rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-accent-fg"
        >
          Close
        </button>
      </div>
    );
  }
  return (
    <ProfileSettingsForm
      profile={profile}
      active={profile.id === activeProfileId}
      data={data}
      projects={projects}
      onClose={onClose}
    />
  );
}

function ProfileSettingsForm({
  profile,
  active,
  data,
  projects,
  onClose,
}: {
  profile: Profile;
  active: boolean;
  data: ProfilesData;
  projects: ProjectSummary[];
  onClose: () => void;
}) {
  const [name, setName] = useState(profile.name);
  const [saving, setSaving] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const profileProjects = projects.filter((project) =>
    profile.projectIds.includes(project.id),
  );

  useEffect(() => setName(profile.name), [profile.name]);

  const update = async (patch: {
    name?: string;
    color?: string;
    defaultProjectId?: string;
  }) => {
    setSaving(true);
    setError(null);
    try {
      await desktopApi.profilesUpdate(profile.id, patch);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const remove = async () => {
    setDeleting(true);
    setError(null);
    try {
      const removed = await desktopApi.profilesRemove(profile.id);
      if (!removed) {
        setError("The last profile cannot be removed.");
        setDeleting(false);
        return;
      }
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
      setDeleting(false);
    }
  };

  const isDefault = data.defaultProfileId === profile.id;
  const canDelete = data.profiles.length > 1 && !active;
  return (
    <div
      className="h-full min-h-0 w-full overflow-y-auto overscroll-contain"
      data-testid="profile-settings-screen"
    >
      <div className="mx-auto w-full max-w-2xl px-6 py-4">
        <header className="mb-6 flex items-center justify-between">
          <div>
            <h1 className="text-base font-semibold">Profile settings</h1>
            <p className="mt-0.5 text-xs text-fg-muted">
              Manage this profile's identity, projects, passwords, and browser
              data.
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
            aria-label="Close profile settings"
          >
            <X className="size-4" />
          </button>
        </header>

        <section className="space-y-4 rounded-lg border border-border bg-bg-raised/30 p-4">
          <label className="block">
            <span className="mb-1 block text-xs font-medium text-fg">Name</span>
            <div className="flex gap-2">
              <input
                value={name}
                onChange={(event) => setName(event.target.value)}
                className="field h-8 min-w-0 flex-1 rounded-md px-2.5 text-[13px]"
                aria-label="Profile name"
              />
              <PendingButton
                pending={saving}
                pendingLabel="Saving…"
                disabled={!name.trim() || name.trim() === profile.name}
                onClick={() => void update({ name: name.trim() })}
                className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg"
              >
                Save
              </PendingButton>
            </div>
          </label>

          <fieldset>
            <legend className="mb-2 text-xs font-medium text-fg">Color</legend>
            <div className="flex flex-wrap gap-2">
              {PROFILE_COLORS.map((color) => (
                <button
                  key={color}
                  type="button"
                  onClick={() => void update({ color })}
                  className="grid size-7 cursor-pointer place-items-center rounded-full border border-border"
                  style={{ backgroundColor: color }}
                  aria-label={`Use profile color ${color}`}
                  aria-pressed={profile.color === color}
                >
                  {profile.color === color && (
                    <Check className="size-3.5 text-white drop-shadow" />
                  )}
                </button>
              ))}
            </div>
          </fieldset>

          <div>
            <p className="mb-1 text-xs font-medium text-fg">Default project</p>
            <select
              value={profile.defaultProjectId ?? ""}
              onChange={(event) =>
                void update({
                  defaultProjectId: event.target.value || undefined,
                })
              }
              className="field h-8 w-full rounded-md px-2 text-[13px]"
              aria-label="Default project"
            >
              <option value="">No default project</option>
              {profileProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
            <p className="mt-1 text-[11px] text-fg-faint">
              Used when this profile opens without a more recent project.
            </p>
          </div>

          <div className="flex items-center justify-between border-t border-border pt-3">
            <div>
              <p className="text-xs font-medium text-fg">Default profile</p>
              <p className="text-[11px] text-fg-faint">
                The app opens in this profile.
              </p>
            </div>
            <button
              type="button"
              disabled={isDefault}
              onClick={() => void desktopApi.profilesSetDefault(profile.id)}
              className="flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-border px-2.5 text-xs text-fg disabled:cursor-default disabled:opacity-60"
            >
              <Star
                className={`size-3.5 ${isDefault ? "fill-current text-accent" : ""}`}
              />{" "}
              {isDefault ? "Default" : "Make default"}
            </button>
          </div>
        </section>

        <PasswordManager profileId={profile.id} />

        <BrowserImport />

        <section className="mt-4 rounded-lg border border-danger/30 p-4">
          <h2 className="text-sm font-semibold text-fg">Delete profile</h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Projects are moved to the default profile. Browser and agent data
            scoped to this profile may no longer be available.
          </p>
          {!confirmDelete ? (
            <button
              type="button"
              disabled={!canDelete}
              onClick={() => setConfirmDelete(true)}
              className="mt-3 flex h-8 cursor-pointer items-center gap-1.5 rounded-md border border-danger/40 px-2.5 text-xs text-danger disabled:cursor-default disabled:opacity-50"
            >
              <Trash2 className="size-3.5" />
              Delete profile
            </button>
          ) : (
            <div className="mt-3 flex items-center gap-2">
              <PendingButton
                pending={deleting}
                pendingLabel="Deleting…"
                onClick={() => void remove()}
                className="h-8 rounded-md bg-danger px-3 text-xs font-medium text-white"
              >
                Confirm delete
              </PendingButton>
              <button
                type="button"
                onClick={() => setConfirmDelete(false)}
                className="h-8 rounded-md px-2.5 text-xs text-fg-muted hover:bg-bg-overlay"
              >
                Cancel
              </button>
            </div>
          )}
          {!canDelete && (
            <p className="mt-2 text-[11px] text-fg-faint">
              {data.profiles.length <= 1
                ? "The last profile cannot be removed."
                : "Switch to another profile before deleting this one."}
            </p>
          )}
        </section>
        {error && (
          <p
            className="mt-3 rounded-md bg-danger/10 px-3 py-2 text-xs text-danger"
            role="alert"
          >
            {error}
          </p>
        )}
      </div>
    </div>
  );
}
