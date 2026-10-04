import { FileKey, X } from "lucide-react";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import type { PasswordFileImportResult } from "../../shared/password-import.js";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

type Locked = Extract<PasswordFileImportResult, { status: "locked" }>;
type Imported = Extract<PasswordFileImportResult, { status: "imported" }>;

const count = (value: number, one: string, many: string) =>
  `${value} ${value === 1 ? one : many}`;

/** What an import did, in one sentence. */
export function importSummary(result: Imported): string {
  const added = [
    result.passwords ? count(result.passwords, "password", "passwords") : "",
    result.passkeys ? count(result.passkeys, "passkey", "passkeys") : "",
  ].filter(Boolean);
  const notes = [
    result.existing ? `${result.existing} already saved` : "",
    result.skipped
      ? `${count(result.skipped, "item", "items")} without a website or passkey left out`
      : "",
  ].filter(Boolean);
  if (!added.length && !result.skipped)
    return result.existing
      ? "Everything in this file is already saved."
      : "This file has no website logins or passkeys.";
  const head = added.length
    ? `Imported ${added.join(" and ")}`
    : "Nothing new to import";
  return notes.length ? `${head}. ${notes.join(", ")}.` : `${head}.`;
}

/**
 * Importing passwords and passkeys from a file (ADR 0201): a CSV export,
 * Bitwarden's JSON export, or a KeePass database, which asks for its
 * password (and key file) here. Main reads the file; nothing in it
 * reaches this window. Settings and the Passwords page share it.
 */
export function usePasswordFileImport(profileId: string): {
  start: () => void;
  /** Forget the last result (another import is starting). */
  reset: () => void;
  busy: boolean;
  summary: string | null;
  error: string | null;
  dialog: ReactNode;
} {
  const [busy, setBusy] = useState(false);
  const [summary, setSummary] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState<Locked | null>(null);
  const [unlockOpen, setUnlockOpen] = useState(false);

  const finish = useCallback((result: PasswordFileImportResult) => {
    if (result.status === "locked") {
      setLocked(result);
      setUnlockOpen(true);
      return;
    }
    setUnlockOpen(false);
    if (result.status === "imported") setSummary(importSummary(result));
    if (result.status === "failed") setError(result.message);
  }, []);

  const start = useCallback(() => {
    setBusy(true);
    setError(null);
    setSummary(null);
    desktopApi
      .passwordFileImport({ profileId })
      .then(finish)
      .catch(() =>
        setError("This file could not be imported. Try another export."),
      )
      .finally(() => setBusy(false));
  }, [profileId, finish]);

  const dialog = (
    <UnlockDatabase
      open={unlockOpen}
      profileId={profileId}
      locked={locked}
      onResult={finish}
      onClose={() => {
        setUnlockOpen(false);
        if (locked) void desktopApi.passwordFileForget({ token: locked.token });
      }}
    />
  );
  const reset = useCallback(() => {
    setSummary(null);
    setError(null);
  }, []);
  return { start, reset, busy, summary, error, dialog };
}

function UnlockDatabase({
  open,
  profileId,
  locked,
  onResult,
  onClose,
}: {
  open: boolean;
  profileId: string;
  /** Kept through the exit motion. */
  locked: Locked | null;
  onResult: (result: PasswordFileImportResult) => void;
  onClose: () => void;
}) {
  const [password, setPassword] = useState("");
  const [keyFile, setKeyFile] = useState<string | null>(null);
  const [unlocking, setUnlocking] = useState(false);
  const fieldRef = useRef<HTMLInputElement>(null);
  const id = useId();

  // A fresh field for each database (it focuses itself as the dialog
  // mounts); a wrong password is selected to retype.
  useEffect(() => {
    if (!open) return;
    setKeyFile(locked?.keyFile ?? null);
    if (locked?.wrongKey) {
      fieldRef.current?.focus();
      fieldRef.current?.select();
    }
  }, [open, locked]);
  useEffect(() => {
    if (open) setPassword("");
  }, [open]);

  const unlock = async () => {
    if (!locked || unlocking) return;
    setUnlocking(true);
    try {
      onResult(
        await desktopApi.passwordFileUnlock({
          profileId,
          token: locked.token,
          password,
        }),
      );
    } catch {
      onResult({
        status: "failed",
        message: "This database could not be imported. Try again.",
      });
    } finally {
      setUnlocking(false);
    }
  };
  const chooseKeyFile = async (clear = false) => {
    if (!locked) return;
    const chosen = await desktopApi
      .passwordFileKeyFile({ token: locked.token, clear })
      .catch(() => null);
    if (chosen) setKeyFile(chosen.keyFile);
  };

  return (
    <Modal open={open} onClose={onClose} width={420} labelledBy={`${id}-title`}>
      <form
        data-testid="password-file-unlock"
        onSubmit={(event) => {
          event.preventDefault();
          void unlock();
        }}
      >
        <div className="px-5 pt-5">
          <h2 id={`${id}-title`} className="text-sm font-semibold text-fg">
            Unlock {locked?.name ?? "database"}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Its website logins and passkeys are imported into this profile. The
            database itself is left as it is.
          </p>
          <label className="mt-4 block" htmlFor={`${id}-password`}>
            <span className="mb-1 block text-[11px] text-fg-muted">
              Database password
            </span>
            <input
              ref={fieldRef}
              // biome-ignore lint/a11y/noAutofocus: the dialog's one field, focused as it opens
              autoFocus
              id={`${id}-password`}
              type="password"
              data-testid="password-file-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              autoComplete="off"
              spellCheck={false}
              aria-invalid={locked?.wrongKey || undefined}
              aria-describedby={`${id}-error`}
              className="field h-8 w-full rounded-md px-2.5 text-[13px]"
            />
          </label>
          <div className="mt-3 flex min-h-7 items-center gap-2 text-xs">
            {keyFile ? (
              <span className="inline-flex min-w-0 items-center gap-1.5 rounded-md bg-bg-inset py-1 pl-2 pr-1 text-fg">
                <FileKey className="size-3.5 shrink-0 text-fg-muted" />
                <span className="truncate" data-testid="password-file-key">
                  {keyFile}
                </span>
                <button
                  type="button"
                  onClick={() => void chooseKeyFile(true)}
                  aria-label="Remove key file"
                  className="grid size-5 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                >
                  <X className="size-3" />
                </button>
              </span>
            ) : (
              <button
                type="button"
                onClick={() => void chooseKeyFile()}
                data-testid="password-file-choose-key"
                className="button-ghost button-sm -ml-2"
              >
                <FileKey className="size-3.5" /> Add a key file
              </button>
            )}
          </div>
          {/* Reserved so an error never moves the footer. */}
          <p
            id={`${id}-error`}
            className="mt-2 min-h-4 text-xs text-danger"
            aria-live="assertive"
          >
            {locked?.wrongKey
              ? keyFile
                ? "That password and key file do not open this database."
                : "That password does not open this database."
              : null}
          </p>
        </div>
        <footer className="mt-2 flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <button type="button" onClick={onClose} className="button-ghost">
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={unlocking}
            pendingLabel="Importing…"
            disabled={unlocking || (!password && !keyFile)}
            data-disabled-reason="Enter the database password"
            data-testid="password-file-unlock-submit"
            className="button-primary"
          >
            Import
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}
