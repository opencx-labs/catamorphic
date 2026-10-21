import {
  Bell,
  Copy,
  Keyboard,
  Palette,
  PanelsTopLeft,
  SquareTerminal,
  X,
} from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import {
  PROFILE_SYNC_LABELS,
  PROFILE_SYNC_PARTS,
  type ProfileSyncPart,
} from "../../shared/profile-sync.js";
import {
  desktopApi,
  type Profile,
  type ProfilesData,
} from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ProfileAvatar } from "./profile-avatar.js";
import { ShortcutHint } from "./shortcut-hint.js";

const PART_ICONS: Record<ProfileSyncPart, typeof Palette> = {
  appearance: Palette,
  workspace: PanelsTopLeft,
  macros: SquareTerminal,
  shortcuts: Keyboard,
  notifications: Bell,
};

/** "A", "A and B", "A, B and C". */
function list(items: readonly string[]): string {
  if (items.length < 2) return items.join("");
  return `${items.slice(0, -1).join(", ")} and ${items.at(-1)}`;
}

/** The profile whose files hold a profile's part (mirrors ProfilesStore). */
function ownerOf(
  profile: Profile,
  data: ProfilesData,
  part: ProfileSyncPart,
): string {
  const owner = profile.syncedFrom?.[part];
  return owner &&
    owner !== profile.id &&
    data.profiles.some((candidate) => candidate.id === owner)
    ? owner
    : profile.id;
}

/** Every other profile that shares this profile's files for a part. */
export function syncPartners(
  profile: Profile,
  data: ProfilesData,
  part: ProfileSyncPart,
): Profile[] {
  const owner = ownerOf(profile, data, part);
  return data.profiles.filter(
    (candidate) =>
      candidate.id !== profile.id &&
      (candidate.id === owner || ownerOf(candidate, data, part) === owner),
  );
}

/** Under a Settings category this profile shares: who else it changes. */
export function SyncedNote({
  profile,
  data,
  part,
}: {
  profile?: Profile;
  data?: ProfilesData | null;
  part: string;
}) {
  const synced = PROFILE_SYNC_PARTS.find((candidate) => candidate === part);
  if (!profile || !data || !synced) return null;
  const partners = syncPartners(profile, data, synced);
  if (!partners.length) return null;
  return (
    <p
      className="-mt-1 mb-3 text-xs text-fg-muted"
      data-testid={`settings-synced-${synced}`}
    >
      Synced with {list(partners.map((partner) => partner.name))}. Profile
      changes here apply to{" "}
      {partners.length === 1 ? "both profiles" : "all of them"}.
    </p>
  );
}

/** Welcome and profile settings mount the same dialog, like browser import. */
export function ProfileImportDialog({
  open,
  profile,
  data,
  onClose,
  onComplete,
}: {
  open: boolean;
  profile: Profile;
  data: ProfilesData;
  onClose: () => void;
  onComplete?: () => void;
}) {
  const titleId = useId();
  const sources = data.profiles.filter(
    (candidate) => candidate.id !== profile.id,
  );
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<Set<ProfileSyncPart>>(
    new Set(PROFILE_SYNC_PARTS),
  );
  const [keepInSync, setKeepInSync] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const picked =
    sources.find((candidate) => candidate.id === source) ??
    sources.find((candidate) => candidate.id === data.defaultProfileId) ??
    sources[0];
  const parts = PROFILE_SYNC_PARTS.filter((part) => selected.has(part));
  // Each opening starts from everything, kept in sync.
  useEffect(() => {
    if (!open) return;
    setSelected(new Set(PROFILE_SYNC_PARTS));
    setKeepInSync(true);
    setError(null);
  }, [open]);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  const run = async () => {
    if (!picked || !parts.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      await desktopApi.profilesSyncSettings({
        profileId: profile.id,
        from: picked.id,
        parts,
        keepInSync,
      });
      onComplete?.();
      onClose();
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "Import could not finish. Try again.",
      );
    } finally {
      busyRef.current = false;
      setBusy(false);
    }
  };
  return (
    <Modal open={open} onClose={close} labelledBy={titleId} width={440}>
      <div
        className="p-5 text-left"
        data-testid="profile-import-dialog"
        aria-busy={busy}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-fg">
            Import from a profile
          </h2>
          <ShortcutHint label="Close import">
            <button
              type="button"
              disabled={busy}
              data-disabled-reason="Wait for the import to finish"
              onClick={close}
              aria-label="Close import"
              className="grid size-7 shrink-0 place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay disabled:opacity-40"
            >
              <X className="size-4" />
            </button>
          </ShortcutHint>
        </div>
        <p className="mt-1 text-[13px] leading-5 text-fg-muted">
          Bring another profile's settings into {profile.name}.
        </p>
        <label className="mt-5 block text-xs font-medium text-fg-muted">
          Profile
          <select
            aria-label="Import from profile"
            value={picked?.id ?? ""}
            disabled={busy || !sources.length}
            data-disabled-reason={
              busy ? "Wait for the import to finish" : "No other profiles"
            }
            onChange={(event) => {
              setError(null);
              setSource(event.target.value);
            }}
            className="field mt-1.5 h-9 w-full rounded-md px-2 text-[13px] text-fg"
          >
            {sources.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset
          disabled={busy}
          data-disabled-reason="Wait for the import to finish"
          className="mt-4 space-y-1"
        >
          <legend className="sr-only">Choose what to import</legend>
          {PROFILE_SYNC_PARTS.map((part) => {
            const Icon = PART_ICONS[part];
            const { label, detail } = PROFILE_SYNC_LABELS[part];
            return (
              <label
                key={part}
                className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-bg-overlay has-disabled:cursor-default"
              >
                <Icon className="size-4 shrink-0 text-fg-muted" />
                <span className="min-w-0 flex-1">
                  <span className="block text-[13px] text-fg">{label}</span>
                  <span className="block text-xs text-fg-faint">{detail}</span>
                </span>
                <input
                  type="checkbox"
                  aria-label={label}
                  data-sync-part={part}
                  checked={selected.has(part)}
                  onChange={(event) => {
                    setError(null);
                    setSelected((current) => {
                      const next = new Set(current);
                      if (event.target.checked) next.add(part);
                      else next.delete(part);
                      return next;
                    });
                  }}
                />
              </label>
            );
          })}
          <div className="mx-2 my-1 border-t border-border" />
          <label className="flex cursor-pointer items-center gap-3 rounded-md px-2 py-2.5 transition-colors duration-150 hover:bg-bg-overlay has-disabled:cursor-default">
            <span className="min-w-0 flex-1">
              <span className="block text-[13px] text-fg">Keep in sync</span>
              <span className="block text-xs text-fg-faint">
                Changes in either profile apply to both
              </span>
            </span>
            <input
              type="checkbox"
              aria-label="Keep in sync"
              data-testid="profile-import-keep-in-sync"
              checked={keepInSync}
              onChange={(event) => setKeepInSync(event.target.checked)}
            />
          </label>
        </fieldset>
        <div className="min-h-12 pt-2" aria-live="polite">
          {error ? (
            <p role="alert" className="text-xs leading-5 text-danger">
              {error}
            </p>
          ) : (
            <p className="text-xs leading-5 text-fg-faint">
              {keepInSync
                ? `Replaces ${profile.name}'s choices for what you select. Agents, passwords and browsing data stay with each profile.`
                : `Replaces ${profile.name}'s choices for what you select with a copy. Later changes stay in the profile that makes them.`}
            </p>
          )}
        </div>
        <div className="mt-4 flex justify-end gap-2 border-t border-border pt-4">
          <button
            type="button"
            disabled={busy}
            data-disabled-reason="Wait for the import to finish"
            onClick={close}
            className="h-8 rounded-md border border-border px-3 text-[13px] text-fg-muted transition-colors duration-150 hover:bg-bg-overlay disabled:opacity-40"
          >
            Cancel
          </button>
          <PendingButton
            pending={busy}
            pendingLabel="Importing…"
            disabled={!picked || !parts.length}
            data-disabled-reason={
              picked
                ? "Select at least one item to import"
                : "No other profiles"
            }
            onClick={() => void run()}
            data-testid="profile-import-start"
            className="button-primary"
          >
            Import
          </PendingButton>
        </div>
      </div>
    </Modal>
  );
}

/** Rows of profiles this one shares settings with, grouped by profile. */
function syncRows(profile: Profile, data: ProfilesData) {
  const rows = new Map<
    string,
    { partner: Profile; parts: ProfileSyncPart[]; follower: string }
  >();
  const add = (partner: Profile, part: ProfileSyncPart, follower: string) => {
    const row = rows.get(partner.id) ?? { partner, parts: [], follower };
    row.parts.push(part);
    rows.set(partner.id, row);
  };
  for (const part of PROFILE_SYNC_PARTS) {
    const owner = ownerOf(profile, data, part);
    if (owner !== profile.id) {
      const partner = data.profiles.find((candidate) => candidate.id === owner);
      if (partner) add(partner, part, profile.id);
      continue;
    }
    for (const candidate of data.profiles)
      if (
        candidate.id !== profile.id &&
        ownerOf(candidate, data, part) === profile.id
      )
        add(candidate, part, candidate.id);
  }
  return [...rows.values()];
}

/** Profile settings: import from another profile and see what stays in sync. */
export function ProfileSettingsSync({
  profile,
  data,
}: {
  profile: Profile;
  data: ProfilesData;
}) {
  const [open, setOpen] = useState(false);
  const [stopping, setStopping] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const rows = syncRows(profile, data);
  const canImport = data.profiles.length > 1;
  const stop = async (row: (typeof rows)[number]) => {
    setStopping(row.partner.id);
    setError(null);
    try {
      // The follower takes a copy; whoever else shares the files keeps them.
      await desktopApi.profilesStopSyncing({
        profileId: row.follower,
        parts: row.parts,
      });
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setStopping(null);
    }
  };
  return (
    <section className="settings-card mt-4" data-testid="profile-settings-sync">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Copy className="size-4 text-fg-muted" />
        Settings from another profile
      </h2>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        Bring appearance, workspace, macros, shortcuts and notifications from
        another profile, once or kept in sync.
      </p>
      {rows.length > 0 && (
        <ul className="mt-3 divide-y divide-border rounded-md border border-border">
          {rows.map((row) => (
            <li
              key={row.partner.id}
              data-sync-partner={row.partner.id}
              className="flex items-center gap-3 px-3 py-2.5"
            >
              <ProfileAvatar profile={row.partner} size="sm" />
              <span className="min-w-0 flex-1">
                <span className="block truncate text-[13px] text-fg">
                  {row.partner.name}
                </span>
                <span className="block text-xs text-fg-faint">
                  {`${list(row.parts.map((part) => PROFILE_SYNC_LABELS[part].label))}, kept in sync`}
                </span>
              </span>
              <PendingButton
                pending={stopping === row.partner.id}
                pendingLabel="Stopping…"
                disabled={stopping !== null && stopping !== row.partner.id}
                data-disabled-reason="Wait for the other change to finish"
                onClick={() => void stop(row)}
                className="h-7 shrink-0 rounded-md px-2 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              >
                Stop syncing
              </PendingButton>
            </li>
          ))}
        </ul>
      )}
      <div className="mt-3">
        <button
          type="button"
          disabled={!canImport}
          data-disabled-reason="Create another profile first"
          onClick={() => setOpen(true)}
          data-testid="settings-profile-import"
          className="h-8 rounded-md border border-border px-3 text-xs text-fg transition-colors duration-150 hover:bg-bg-overlay disabled:cursor-not-allowed disabled:opacity-60"
        >
          Import from a profile
        </button>
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <ProfileImportDialog
        open={open}
        profile={profile}
        data={data}
        onClose={() => setOpen(false)}
      />
    </section>
  );
}
