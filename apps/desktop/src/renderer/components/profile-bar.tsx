import { Check, ChevronDown, Plus, Star } from "lucide-react";
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import { moveFocusAsApp } from "../lib/app-focus.js";
import type { Profile, ProfilesData } from "../lib/desktop-api.js";
import { desktopApi } from "../lib/desktop-api.js";
import { usePopoverDismiss } from "../lib/popover-dismiss.js";
import { ProfileAvatar } from "./profile-avatar";
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
  activeProfileId,
  onSwitch,
  onOpenSettings,
}: {
  data: ProfilesData;
  activeProfileId: string;
  onSwitch: (profile: Profile) => void;
  onOpenSettings: (profileId: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const popoverRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);

  const active: Profile | undefined =
    data.profiles.find((profile) => profile.id === activeProfileId) ??
    data.profiles[0];

  // A press anywhere else, a web page or an app's frame included, closes
  // it; a press on a profile's card does not. Closing drops the inline
  // create field (below).
  usePopoverDismiss({
    open,
    within: [containerRef],
    onDismiss: () => setOpen(false),
    returnFocus: triggerRef,
  });

  // A dialog takes focus as it opens (on the profile in use) and hands it
  // back to its control as it closes; it comes before the control in tab
  // order, so Tab would not reach it. These are the app's own focus moves:
  // they open no profile's preview.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => {
      const popover = popoverRef.current;
      const target =
        popover?.querySelector<HTMLElement>("[data-profile-active]") ??
        popover?.querySelector<HTMLElement>("button");
      if (target) moveFocusAsApp(() => target.focus());
    });
    return () => cancelAnimationFrame(frame);
  }, [open]);
  // Before the closed dialog turns inert and drops the focus it holds.
  useLayoutEffect(() => {
    if (open) return;
    const trigger = triggerRef.current;
    if (trigger && popoverRef.current?.contains(document.activeElement))
      moveFocusAsApp(() => trigger.focus());
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
    <div ref={containerRef} className="relative min-w-0 flex-1">
      <div
        ref={popoverRef}
        className={`absolute left-0 w-[244px] bottom-full z-50 mb-1 origin-bottom rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl transition-[opacity,translate,scale] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
          open
            ? "translate-y-0 scale-100 opacity-100"
            : "pointer-events-none translate-y-1 scale-[0.98] opacity-0"
        }`}
        // Profiles with their previews and a create field: a popover, not
        // a menu of commands (menus are MenuPortal's).
        role="dialog"
        aria-label="Profiles"
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
              content={(dismiss) => (
                <ProfileInspector
                  profile={profile}
                  data={data}
                  onOpenSettings={() => {
                    dismiss();
                    setOpen(false);
                    onOpenSettings(profile.id);
                  }}
                />
              )}
            >
              {(inspectorProps) => (
                <button
                  {...inspectorProps}
                  type="button"
                  aria-current={isActive || undefined}
                  data-profile-active={isActive || undefined}
                  onClick={() => {
                    setOpen(false);
                    if (!isActive) onSwitch(profile);
                  }}
                  className={`flex h-8 w-full cursor-pointer items-center gap-2 rounded-md px-2 text-left text-[13px] transition-colors duration-150 ${isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised hover:text-fg"}`}
                >
                  <ProfileAvatar profile={profile} size="sm" />
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
        // The open menu already shows every profile; its preview would cover it.
        disabled={open}
        content={(dismiss) => (
          <ProfileInspector
            profile={active}
            data={data}
            onOpenSettings={() => {
              dismiss();
              onOpenSettings(active.id);
            }}
          />
        )}
      >
        {(inspectorProps) => (
          <button
            {...inspectorProps}
            ref={(node) => {
              inspectorProps.ref.current = node;
              triggerRef.current = node;
            }}
            type="button"
            onClick={() => {
              inspectorProps.onClick();
              setOpen((value) => !value);
            }}
            className={`flex h-8 w-full min-w-0 cursor-pointer items-center gap-1 rounded-md px-2 text-[13px] transition-colors duration-150 ${
              open
                ? "bg-bg-overlay text-fg"
                : "text-fg-muted hover:bg-bg-overlay hover:text-fg"
            }`}
            aria-label={`Switch profile: ${active.name}`}
            aria-haspopup="dialog"
            aria-expanded={open}
          >
            <ProfileAvatar profile={active} />
            <span className="min-w-0 flex-1 truncate text-left">
              {active.name}
            </span>
            <ChevronDown
              className={`size-3.5 shrink-0 transition-transform duration-150 ${open ? "rotate-180" : ""}`}
            />
          </button>
        )}
      </ResourceInspector>
    </div>
  );
}
