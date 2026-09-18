import {
  Bookmark,
  Check,
  Download,
  History,
  KeyRound,
  RefreshCw,
  ShieldCheck,
  X,
} from "lucide-react";
import { useCallback, useEffect, useId, useRef, useState } from "react";
import type { BrowserImportCategory } from "../../shared/browser-import.js";
import { desktopApi, type ImportableBrowser } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

const CATEGORIES = [
  {
    id: "bookmarks",
    label: "Bookmarks",
    detail: "Your saved sites and folders",
    icon: Bookmark,
  },
  {
    id: "history",
    label: "History",
    detail: "Pages you've visited",
    icon: History,
  },
  {
    id: "passwords",
    label: "Passwords",
    detail: "Saved accounts for autofill",
    icon: KeyRound,
  },
  {
    id: "sessions",
    label: "Signed-in sessions",
    detail: "Stay signed in where supported",
    icon: ShieldCheck,
  },
] satisfies Array<{
  id: BrowserImportCategory;
  label: string;
  detail: string;
  icon: typeof Bookmark;
}>;

/** Settings and onboarding mount the exact same selection and progress dialog. */
export function BrowserImportDialog({
  open,
  profileId,
  onClose,
  onComplete,
}: {
  open: boolean;
  profileId: string;
  onClose: () => void;
  onComplete?: () => void;
}) {
  const titleId = useId();
  const [browsers, setBrowsers] = useState<ImportableBrowser[]>([]);
  const [source, setSource] = useState("");
  const [selected, setSelected] = useState<Set<BrowserImportCategory>>(
    new Set(CATEGORIES.map(({ id }) => id)),
  );
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const [error, setError] = useState<string | null>(null);
  const [scan, setScan] = useState(0);
  const options = browsers.flatMap((browser) =>
    browser.profiles.map((profile) => ({
      browser,
      profile,
      key: JSON.stringify([browser.id, profile.id]),
    })),
  );
  const picked = options.find(({ key }) => key === source);
  const available = CATEGORIES.filter(
    ({ id }) =>
      picked &&
      (id === "bookmarks"
        ? picked.profile.bookmarkCount > 0
        : id === "history"
          ? picked.profile.hasHistory
          : id === "passwords"
            ? picked.profile.hasPasswords
            : picked.profile.hasSessions),
  );
  const categories = available
    .filter(({ id }) => selected.has(id))
    .map(({ id }) => id);
  // biome-ignore lint/correctness/useExhaustiveDependencies: rescan is an explicit retry.
  useEffect(() => {
    if (!open) return;
    let active = true;
    setLoading(true);
    setError(null);
    void desktopApi
      .browserImportList()
      .then((result) => {
        if (!active) return;
        setBrowsers(result);
        const choices = result.flatMap((browser) =>
          browser.profiles.map((profile) =>
            JSON.stringify([browser.id, profile.id]),
          ),
        );
        setSource((current) =>
          choices.includes(current) ? current : (choices[0] ?? ""),
        );
      })
      .catch(() => {
        if (active)
          setError("Could not find browser profiles. Try scanning again.");
      })
      .finally(() => {
        if (active) setLoading(false);
      });
    return () => {
      active = false;
    };
  }, [open, scan]);
  const close = () => {
    if (!busyRef.current) onClose();
  };
  const run = async () => {
    if (!picked || !categories.length || busyRef.current) return;
    busyRef.current = true;
    setBusy(true);
    setError(null);
    try {
      const result = await desktopApi.browserImportRun({
        browserId: picked.browser.id,
        sourceProfileId: picked.profile.id,
        targetProfileId: profileId,
        categories,
      });
      if (result.error) {
        setError(result.error);
      } else if (!result.cancelled) {
        onComplete?.();
        onClose();
      }
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
        data-testid="browser-import-dialog"
        aria-busy={busy}
      >
        <div className="flex items-center justify-between gap-3">
          <h2 id={titleId} className="text-base font-semibold text-fg">
            Import from a browser
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
          Bring your browser into this profile.
        </p>
        <div className="mt-5 flex items-end gap-2">
          <label className="min-w-0 flex-1 text-xs font-medium text-fg-muted">
            Browser profile
            <select
              aria-label="Browser profile"
              value={source}
              disabled={busy || loading || !options.length}
              data-disabled-reason={
                busy
                  ? "Wait for the import to finish"
                  : loading
                    ? "Looking for browser profiles"
                    : "No browser profiles found"
              }
              onChange={(event) => {
                setError(null);
                setSource(event.target.value);
              }}
              className="field mt-1.5 h-9 w-full rounded-md px-2 text-[13px] text-fg"
            >
              {!options.length && (
                <option value="">
                  {loading
                    ? "Looking for browsers…"
                    : "No browser profiles found"}
                </option>
              )}
              {options.map(({ browser, profile, key }) => (
                <option key={key} value={key}>
                  {browser.label} · {profile.name}
                </option>
              ))}
            </select>
          </label>
          <ShortcutHint label="Scan again">
            <button
              type="button"
              disabled={busy || loading}
              data-disabled-reason={
                busy
                  ? "Wait for the import to finish"
                  : "Looking for browser profiles"
              }
              onClick={() => setScan((value) => value + 1)}
              aria-label="Scan for browsers again"
              className="grid size-9 place-items-center rounded-md border border-border text-fg-muted transition-colors duration-150 hover:bg-bg-overlay disabled:opacity-40"
            >
              <RefreshCw
                className={`size-3.5 ${loading ? "animate-spin motion-reduce:animate-none" : ""}`}
              />
            </button>
          </ShortcutHint>
        </div>
        <fieldset
          disabled={busy || loading}
          data-disabled-reason={
            busy
              ? "Wait for the import to finish"
              : "Looking for browser profiles"
          }
          className="mt-4 min-h-48 space-y-1"
        >
          <legend className="sr-only">Choose what to import</legend>
          {available.map(({ id, label, detail, icon: Icon }) => (
            <label
              key={id}
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
                checked={selected.has(id)}
                onChange={(event) => {
                  setError(null);
                  setSelected((current) => {
                    const next = new Set(current);
                    if (event.target.checked) next.add(id);
                    else next.delete(id);
                    return next;
                  });
                }}
                className="size-4 accent-accent"
              />
            </label>
          ))}
          {!loading && !available.length && (
            <p className="py-8 text-center text-[13px] text-fg-muted">
              Choose another browser profile to import.
            </p>
          )}
        </fieldset>
        <div className="min-h-18 pt-2" aria-live="polite">
          {busy ? (
            <p role="status" className="text-xs leading-5 text-fg-muted">
              Importing your browser data. Confirm any system prompts that
              appear.
            </p>
          ) : error ? (
            <p role="alert" className="text-xs leading-5 text-danger">
              {error}
            </p>
          ) : (
            <p className="text-xs leading-5 text-fg-faint">
              Your existing browser data stays in place.
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
            disabled={loading || !categories.length}
            data-disabled-reason={
              loading
                ? "Looking for browser profiles"
                : "Select at least one item to import"
            }
            onClick={() => void run()}
            data-testid="browser-import-start"
            className="h-8 rounded-md bg-accent px-4 text-[13px] font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90 disabled:opacity-50"
          >
            Import
          </PendingButton>
        </div>
      </div>
    </Modal>
  );
}

export function BrowserImport({ profileId }: { profileId: string }) {
  const [open, setOpen] = useState(false);
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const importCsv = useCallback(async () => {
    setBusy(true);
    setError(null);
    try {
      const result = await desktopApi.browserImportPasswords({ profileId });
      if (!result.cancelled) setDone(true);
    } catch {
      setError("Could not import this password file. Try another export.");
    } finally {
      setBusy(false);
    }
  }, [profileId]);
  return (
    <section className="settings-card mt-4">
      <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
        <Download className="size-4 text-fg-muted" />
        Import browser data
      </h2>
      <p className="mt-1 text-xs leading-5 text-fg-muted">
        Bring your bookmarks, history and accounts from another browser.
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <button
          type="button"
          onClick={() => setOpen(true)}
          data-testid="settings-browser-import"
          className="h-8 rounded-md border border-border px-3 text-xs text-fg transition-colors duration-150 hover:bg-bg-overlay"
        >
          Import from a browser
        </button>
        <PendingButton
          pending={busy}
          pendingLabel="Importing…"
          onClick={() => void importCsv()}
          className="h-8 rounded-md px-2 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay"
        >
          Import password CSV
        </PendingButton>
        {done && (
          <span
            role="status"
            className="inline-flex items-center gap-1.5 text-xs text-fg-muted"
          >
            <Check className="size-3.5" />
            Import complete
          </span>
        )}
      </div>
      {error && (
        <p role="alert" className="mt-2 text-xs text-danger">
          {error}
        </p>
      )}
      <BrowserImportDialog
        open={open}
        profileId={profileId}
        onClose={() => setOpen(false)}
        onComplete={() => setDone(true)}
      />
    </section>
  );
}
