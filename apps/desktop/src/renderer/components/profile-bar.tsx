import { Check, Pencil, Plus, Star } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import type { Profile, ProfilesData } from "../lib/desktop-api.js";
import { desktopApi } from "../lib/desktop-api.js";

/**
 * Chrome-style profile switcher, docked at the bottom of the sidebar.
 * Click the active profile → a menu of profiles pops up; each profile is
 * a color-dot identity. The star marks the default profile (the one the
 * app opens into); starring is an explicit action, like Chrome's
 * "default browser profile".
 */
export function ProfileBar({
  data,
  activeProfileId,
  onSwitch,
}: {
  data: ProfilesData;
  activeProfileId: string;
  onSwitch: (profile: Profile) => void;
}) {
  const [open, setOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const [newName, setNewName] = useState("");
  // Inline rename (every profile is renameable, "Default Profile" included).
  const [renamingId, setRenamingId] = useState<string | null>(null);
  const [renameValue, setRenameValue] = useState("");
  const containerRef = useRef<HTMLDivElement | null>(null);
  const createInputRef = useRef<HTMLInputElement | null>(null);
  const renameInputRef = useRef<HTMLInputElement | null>(null);

  const active: Profile | undefined =
    data.profiles.find((profile) => profile.id === activeProfileId) ??
    data.profiles[0];

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!containerRef.current?.contains(event.target as Node)) {
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

  useEffect(() => {
    if (renamingId) renameInputRef.current?.select();
  }, [renamingId]);

  const commitRename = async () => {
    const id = renamingId;
    const name = renameValue.trim();
    setRenamingId(null);
    if (!id || !name) return;
    await desktopApi.profilesUpdate(id, { name });
  };

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
      {open && (
        <div className="absolute inset-x-0 bottom-full z-50 mb-1 origin-bottom rounded-lg border border-border bg-bg-overlay p-1 shadow-2xl">
          <p className="px-2 pb-1 pt-1.5 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
            Profiles
          </p>
          {data.profiles.map((profile) => {
            const isActive = profile.id === active.id;
            const isDefault = profile.id === data.defaultProfileId;
            return (
              <div
                key={profile.id}
                className={`group flex h-8 items-center rounded-md transition-colors duration-150 ${
                  isActive ? "text-fg" : "text-fg-muted hover:bg-bg-raised"
                }`}
              >
                {renamingId === profile.id ? (
                  <input
                    ref={renameInputRef}
                    value={renameValue}
                    onChange={(event) => setRenameValue(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") void commitRename();
                      if (event.key === "Escape") setRenamingId(null);
                    }}
                    onBlur={() => void commitRename()}
                    aria-label={`Rename ${profile.name}`}
                    className="field mx-1 h-7 min-w-0 flex-1 rounded-md px-2 text-[13px] text-fg"
                  />
                ) : (
                  <button
                    type="button"
                    onClick={() => {
                      setOpen(false);
                      if (!isActive) onSwitch(profile);
                    }}
                    className="flex h-full min-w-0 flex-1 cursor-pointer items-center gap-2 px-2 text-left text-[13px]"
                  >
                    <span
                      className="size-2.5 shrink-0 rounded-full"
                      style={{ backgroundColor: profile.color }}
                    />
                    <span className="truncate">{profile.name}</span>
                    {isActive && (
                      <Check className="ml-auto size-3.5 shrink-0 text-fg-muted" />
                    )}
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => {
                    setRenamingId(profile.id);
                    setRenameValue(profile.name);
                  }}
                  className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint opacity-0 transition-colors duration-150 hover:text-fg group-hover:opacity-100"
                  aria-label={`Rename ${profile.name}`}
                  title="Rename"
                >
                  <Pencil className="size-3" />
                </button>
                <button
                  type="button"
                  onClick={() => void desktopApi.profilesSetDefault(profile.id)}
                  className={`mr-1 grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:text-fg ${
                    isDefault ? "" : "opacity-0 group-hover:opacity-100"
                  }`}
                  aria-label={
                    isDefault
                      ? `${profile.name} is the default profile`
                      : `Make ${profile.name} the default profile`
                  }
                  title={isDefault ? "Default profile" : "Make default"}
                >
                  <Star
                    className={`size-3 ${isDefault ? "fill-current text-fg-muted" : ""}`}
                  />
                </button>
              </div>
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
      )}

      <button
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
    </div>
  );
}
