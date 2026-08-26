import { Check, LogIn, Pencil, Plus, Trash2, Unlink } from "lucide-react";
import { useState } from "react";
import { Screen } from "../components/screen.js";
import { navigate } from "../lib/nav.js";
import {
  activeProfile,
  createProfile,
  deleteProfile,
  removeConnection,
  renameProfile,
  setActiveProfile,
  usePwaState,
} from "../lib/store.js";
import { stashRemoteConnection } from "./connect-screen.js";

/**
 * Profiles are local to this device: a person, their color, and the
 * connections (redeemed invites) they hold — mirroring the desktop's
 * profile switcher. No theming, no settings sprawl.
 */
export function ProfilesScreen({ animation }: { animation?: string }) {
  const state = usePwaState();
  const active = activeProfile(state);
  const [renaming, setRenaming] = useState<string | null>(null);
  const [draft, setDraft] = useState("");

  const commitRename = () => {
    if (renaming) renameProfile(renaming, draft);
    setRenaming(null);
  };

  return (
    <Screen title="Profiles" back animation={animation}>
      <div className="h-full overflow-y-auto overscroll-contain">
        <ul className="flex flex-col py-1">
          {state.profiles.map((profile) => {
            const isActive = profile.id === state.activeProfileId;
            return (
              <li key={profile.id} className="flex items-center">
                <button
                  type="button"
                  onClick={() => setActiveProfile(profile.id)}
                  className="row-press flex min-w-0 flex-1 cursor-pointer items-center gap-3 px-4 py-3 text-left"
                  data-testid="profile-row"
                >
                  <span
                    className="grid size-9 shrink-0 place-items-center rounded-full text-[13px] font-bold text-white"
                    style={{ backgroundColor: profile.color }}
                  >
                    {profile.name.slice(0, 1).toUpperCase()}
                  </span>
                  {renaming === profile.id ? (
                    <input
                      className="field min-w-0 flex-1 px-2 py-1 leading-6 outline-none"
                      value={draft}
                      onChange={(event) => setDraft(event.target.value)}
                      onBlur={commitRename}
                      onKeyDown={(event) => {
                        if (event.key === "Enter") commitRename();
                      }}
                      // biome-ignore lint/a11y/noAutofocus: rename flow
                      autoFocus
                    />
                  ) : (
                    <span className="min-w-0 flex-1 truncate text-[15px] font-medium">
                      {profile.name}
                    </span>
                  )}
                  {isActive && (
                    <Check className="size-4 shrink-0 text-accent" />
                  )}
                </button>
                <button
                  type="button"
                  onClick={() => {
                    setRenaming(profile.id);
                    setDraft(profile.name);
                  }}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center text-fg-faint active:text-fg"
                  aria-label={`Rename ${profile.name}`}
                >
                  <Pencil className="size-4" />
                </button>
                {state.profiles.length > 1 && (
                  <button
                    type="button"
                    onClick={() => {
                      if (
                        window.confirm(
                          `Remove the "${profile.name}" profile and its connections from this device?`,
                        )
                      ) {
                        deleteProfile(profile.id);
                      }
                    }}
                    className="mr-2 grid size-10 shrink-0 cursor-pointer place-items-center text-fg-faint active:text-danger"
                    aria-label={`Delete ${profile.name}`}
                  >
                    <Trash2 className="size-4" />
                  </button>
                )}
              </li>
            );
          })}
          <li>
            <button
              type="button"
              onClick={() => createProfile("")}
              className="row-press flex w-full cursor-pointer items-center gap-3 px-4 py-3 text-left text-fg-muted"
              data-testid="profile-add"
            >
              <span className="grid size-9 shrink-0 place-items-center rounded-full border border-dashed border-border-strong">
                <Plus className="size-4" />
              </span>
              New profile
            </button>
          </li>
        </ul>

        <h2 className="px-4 pb-1 pt-4 text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
          Connections ({active.name})
        </h2>
        {active.connections.length === 0 && (
          <p className="px-4 py-2 text-sm text-fg-muted">
            No connections. Add one from the projects screen.
          </p>
        )}
        <ul className="flex flex-col pb-6">
          {active.connections.map((connection) => (
            <li
              key={connection.id}
              className="flex items-center gap-3 px-4 py-2.5"
            >
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[14px]">
                  {connection.projectName ?? connection.projectId}
                </span>
                <span className="block truncate text-xs text-fg-faint">
                  {new URL(connection.serverUrl).host}
                </span>
                <span
                  className={`block truncate text-xs ${
                    connection.kind === "remote" && !connection.credentials
                      ? "text-danger"
                      : "text-fg-faint"
                  }`}
                >
                  {connection.kind === "device"
                    ? "Paired"
                    : connection.credentials
                      ? "Connected"
                      : "Sign in required"}
                </span>
              </span>
              {connection.kind === "remote" && !connection.credentials && (
                <button
                  type="button"
                  onClick={() => {
                    stashRemoteConnection(connection);
                    navigate({ kind: "connect" });
                  }}
                  className="grid size-10 shrink-0 cursor-pointer place-items-center text-danger active:text-accent"
                  aria-label={`Sign in to ${connection.projectName ?? new URL(connection.serverUrl).host}`}
                  data-testid="profile-remote-sign-in"
                >
                  <LogIn className="size-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => {
                  if (
                    window.confirm(
                      "Disconnect this project from this device? You can sign in again later.",
                    )
                  ) {
                    removeConnection(active.id, connection.id);
                  }
                }}
                className="grid size-10 shrink-0 cursor-pointer place-items-center text-fg-faint active:text-danger"
                aria-label="Disconnect"
              >
                <Unlink className="size-4" />
              </button>
            </li>
          ))}
        </ul>
      </div>
    </Screen>
  );
}
