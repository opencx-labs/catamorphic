import type { ProjectSummary } from "@catamorphic/react/types";
import { Check, Plus, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Profile, ProfilesData } from "../lib/desktop-api.js";
import { desktopApi } from "../lib/desktop-api.js";
import { ProfileInspector } from "./profile-inspector";
import { ResourceInspector } from "./resource-inspector";

/**
 * Chrome-style profile switcher, docked at the bottom of the sidebar.
 * Click the active profile → a menu of profiles pops up; each profile is
 * a color-dot identity. The star passively marks the default profile (the one
 * the app opens into); profile mutations live in the settings workspace.
 */
export function ProfileBar({
  data,
  projects,
  activeProfileId,
  onSwitch,
  onOpenSettings,
}: {
  data: ProfilesData;
  projects: ProjectSummary[];
  activeProfileId: string;
  onSwitch: (profile: Profile) => void;
  onOpenSettings: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);

  const active: Profile | undefined =
    data.profiles.find((profile) => profile.id === activeProfileId) ??
    data.profiles[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      const target = event.target;
      const insideRoot =
        target instanceof Node &&
        Boolean(containerRef.current?.contains(target));
      const insideInspector =
        target instanceof Element &&
        Boolean(target.closest("[data-resource-inspector]"));
      if (!insideRoot && !insideInspector) {
        setOpen(false);
        setCreating(false);
      }
    };
    window.addEventListener("pointerdown", onPointerDown);
    return () => window.removeEventListener("pointerdown", onPointerDown);
  }, [open]);

  useEffect(() => {
    if (creating) createInputRef.current?.focus();
  }, [creating]);

  // The menu stays mounted for its exit transition; closing it must still
  // drop transient state (inline create/rename fields).
  useEffect(() => {
    if (open) return;
    setCreating(false);
    setNewName("");
  }, [open]);

  const create = async () => {
    const name = newName.trim();
    if (!name) {
      setCreating(false);
      return;
    }
    const profile = await desktopApi.profilesCreate(name);
    setNewName("");
    setCreating(false);
    setOpen(false);
    onSwitch(profile);
  };

  if (!active) return null;

  return (
    <div ref={containerRef} className="relative">
      <div
        className={`absolute inset-x-0 bottom-full z-50 mb-1 origin-bottom rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl transition-[opacity,translate,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
          open
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
        }`}
        aria-hidden={!open}
        inert={!open ? true : undefined}
      >
        <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          Profiles
        </p>
        {data.profiles.map((profile) => {
          const isActive = profile.id === active.id;
          const isDefault = profile.id === data.defaultProfileId;
          return (
            <ResourceInspector
              key={profile.id}
              label={`${profile.name} profile details`}
              content={
                <ProfileInspector
                  profile={profile}
                  data={data}
                  projects={projects}
                  current={isActive}
                  onOpenSettings={() => {
                    setOpen(false);
                    onOpenSettings(profile.id);
                  }}
                />
              }
            >
              {(inspectorProps) => (
                <button
                  {...inspectorProps}
                  type="button"
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onSwitch(profile);
                  }}
                  className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                >
                  <span
                    className="size-2.5 shrink-0 rounded-full"
                    style={{ backgroundColor: profile.color }}
                  />
                  <span className="min-w-0 flex-1 truncate">
                    {profile.name}
                  </span>
                  {isDefault && (
                    <Star
                      className="size-3 shrink-0 fill-current text-fg-faint"
                      aria-label="Default profile"
                    />
                  )}
                  {isActive && (
                    <Check className="size-3.5 shrink-0 text-accent" />
                  )}
                </button>
              )}
            </ResourceInspector>
          );
        })}
        <div className="mx-1 my-1 border-t border-border" />
        {creating ? (
          <input
            ref={createInputRef}
            value={newName}
            onChange={(event) => setNewName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void create();
              if (event.key === "Escape") {
                setCreating(false);
                setNewName("");
              }
            }}
            onBlur={() => void create()}
            placeholder="Profile name"
            className="field mx-1 mb-1 h-7 w-[calc(100%-8px)] rounded-md px-2 text-[13px] text-fg"
          />
        ) : (
          <button
            type="button"
            onClick={() => setCreating(true)}
            className="flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
          >
            <Plus className="size-3.5" />
            New profile
          </button>
        )}
      </div>

      <ResourceInspector
        label={`${active.name} profile details`}
        content={
          <ProfileInspector
            profile={active}
            data={data}
            projects={projects}
            current
            onOpenSettings={() => onOpenSettings(active.id)}
          />
        }
      >
        {(inspectorProps) => (
          <button
            {...inspectorProps}
            type="button"
            onClick={() => setOpen((value) => !value)}
            className={`flex h-7 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-[13px] transition-colors duration-150 ${
              open
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
            }`}
            aria-haspopup="menu"
            aria-expanded={open}
          >
            <span
              className="size-2.5 shrink-0 rounded-full"
              style={{ backgroundColor: active.color }}
            />
            <span className="truncate">{active.name}</span>
          </button>
        )}
      </ResourceInspector>
    </div>
  );
}
