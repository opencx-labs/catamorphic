import { Eye, EyeOff, WandSparkles } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import { desktopApi } from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";
import { SiteFavicon } from "./site-favicon.js";

/** What the editor opens on. An `id` edits that login; none adds one. */
export interface PasswordDraft {
  id?: string;
  origin: string;
  username: string;
  note: string;
}

export function displayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

/**
 * A hidden password, drawn: font bullets render as specks at list sizes
 * and vary by typeface, so these are dots of a fixed size.
 */
export function MaskedPassword({ className = "" }: { className?: string }) {
  return (
    <span
      role="img"
      aria-label="Hidden password"
      className={`flex h-1.5 items-center gap-[3px] ${className}`}
    >
      {Array.from({ length: 10 }, (_, index) => (
        <span
          // biome-ignore lint/suspicious/noArrayIndexKey: identical dots
          key={index}
          className="size-[5px] rounded-full bg-current"
        />
      ))}
    </span>
  );
}

/**
 * The one dialog for a saved login: adding one by hand, editing it from
 * the Passwords page, and "Update" on the password-saved card. Editing
 * keeps the password unless a new one is typed or generated; the site of
 * an existing login is fixed (it is where the password works).
 */
export function PasswordEditor({
  open,
  profileId,
  draft,
  heading,
  onClose,
}: {
  open: boolean;
  profileId: string;
  /** Kept by the caller through the exit motion. */
  draft: PasswordDraft;
  heading?: string;
  onClose: () => void;
}) {
  const editing = Boolean(draft.id);
  const [origin, setOrigin] = useState(draft.origin);
  const [username, setUsername] = useState(draft.username);
  const [password, setPassword] = useState("");
  const [note, setNote] = useState(draft.note);
  const [showPassword, setShowPassword] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const firstFieldRef = useRef<HTMLInputElement>(null);
  const instanceId = useId();
  const ids = {
    title: `${instanceId}-title`,
    origin: `${instanceId}-origin`,
    username: `${instanceId}-username`,
    password: `${instanceId}-password`,
    passwordHint: `${instanceId}-password-hint`,
    note: `${instanceId}-note`,
  };

  // A fresh draft each time the dialog opens.
  useEffect(() => {
    if (!open) return;
    setOrigin(draft.origin);
    setUsername(draft.username);
    setPassword("");
    setNote(draft.note);
    setShowPassword(false);
    setError(null);
    const frame = requestAnimationFrame(() => firstFieldRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [open, draft]);

  const canSave = Boolean(origin.trim()) && (editing || Boolean(password));
  const save = async () => {
    if (!canSave || saving) return;
    setSaving(true);
    setError(null);
    try {
      const saved = draft.id
        ? await desktopApi.vaultUpdate({
            profileId,
            id: draft.id,
            origin: draft.origin,
            username: username.trim(),
            note,
            ...(password ? { password } : {}),
          })
        : await desktopApi.vaultSave({
            profileId,
            origin: origin.trim(),
            username: username.trim(),
            password,
            note,
          });
      if (!saved) throw new Error("This password is no longer saved.");
      onClose();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const generate = async () => {
    const generated = await desktopApi.vaultGeneratePassword();
    setPassword(generated);
    setShowPassword(true);
  };

  return (
    <Modal open={open} onClose={onClose} width={440} labelledBy={ids.title}>
      <form
        data-testid="password-editor"
        onSubmit={(event) => {
          event.preventDefault();
          void save();
        }}
      >
        <div className="px-5 pt-5">
          <h2 id={ids.title} className="text-sm font-semibold text-fg">
            {heading ?? (editing ? "Edit password" : "Add password")}
          </h2>
          <p className="mt-1 text-xs leading-relaxed text-fg-muted">
            Saved in this profile and encrypted by your device.
          </p>
          <div className="mt-4 space-y-3">
            {editing ? (
              <div className="flex h-8 items-center gap-2 text-[13px] text-fg">
                <SiteFavicon url={draft.origin} className="size-4" />
                <span className="truncate" data-testid="password-site">
                  {displayHost(draft.origin)}
                </span>
              </div>
            ) : (
              <label className="block" htmlFor={ids.origin}>
                <span className="mb-1 block text-[11px] text-fg-muted">
                  Website address
                </span>
                <input
                  ref={firstFieldRef}
                  id={ids.origin}
                  data-testid="password-origin"
                  value={origin}
                  onChange={(event) => setOrigin(event.target.value)}
                  placeholder="https://example.com"
                  spellCheck={false}
                  className="field h-8 w-full rounded-md px-2.5 text-[13px]"
                />
              </label>
            )}
            <label className="block" htmlFor={ids.username}>
              <span className="mb-1 block text-[11px] text-fg-muted">
                Username
              </span>
              <input
                ref={editing ? firstFieldRef : undefined}
                id={ids.username}
                data-testid="password-username"
                value={username}
                onChange={(event) => setUsername(event.target.value)}
                autoComplete="off"
                spellCheck={false}
                className="field h-8 w-full rounded-md px-2.5 text-[13px]"
              />
            </label>
            <div>
              <label
                htmlFor={ids.password}
                className="mb-1 block text-[11px] text-fg-muted"
              >
                {editing ? "New password" : "Password"}
              </label>
              <div className="field flex h-8 items-center rounded-md pl-2.5 pr-1">
                <input
                  id={ids.password}
                  data-testid="password-value"
                  type={showPassword ? "text" : "password"}
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  autoComplete="new-password"
                  spellCheck={false}
                  placeholder={editing ? "Unchanged" : undefined}
                  aria-describedby={editing ? ids.passwordHint : undefined}
                  className="h-full min-w-0 flex-1 bg-transparent font-mono text-[13px] text-fg outline-none placeholder:font-sans placeholder:text-fg-faint"
                />
                <ShortcutHint
                  label={showPassword ? "Hide password" : "Show password"}
                >
                  <button
                    type="button"
                    onClick={() => setShowPassword((shown) => !shown)}
                    aria-label={
                      showPassword ? "Hide password" : "Show password"
                    }
                    aria-pressed={showPassword}
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  >
                    {showPassword ? (
                      <EyeOff className="size-3.5" />
                    ) : (
                      <Eye className="size-3.5" />
                    )}
                  </button>
                </ShortcutHint>
                <ShortcutHint label="Generate a strong password">
                  <button
                    type="button"
                    onClick={() => void generate()}
                    aria-label="Generate a strong password"
                    data-testid="password-generate"
                    className="grid size-6 shrink-0 cursor-pointer place-items-center rounded text-fg-faint transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                  >
                    <WandSparkles className="size-3.5" />
                  </button>
                </ShortcutHint>
              </div>
              {editing && (
                <span
                  id={ids.passwordHint}
                  className="mt-1 block text-[11px] text-fg-faint"
                >
                  Leave this blank to keep the current password.
                </span>
              )}
            </div>
            <label className="block" htmlFor={ids.note}>
              <span className="mb-1 block text-[11px] text-fg-muted">Note</span>
              <textarea
                id={ids.note}
                data-testid="password-note"
                value={note}
                onChange={(event) => setNote(event.target.value)}
                rows={3}
                placeholder="Recovery codes, security questions, anything worth keeping with this login"
                className="field block w-full resize-none rounded-md px-2.5 py-2 text-[13px] leading-5"
              />
            </label>
          </div>
          {/* Reserved so an error never moves the footer. */}
          <p
            className="mt-3 min-h-4 text-xs text-danger"
            role={error ? "alert" : undefined}
          >
            {error}
          </p>
        </div>
        <footer className="mt-2 flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <button type="button" onClick={onClose} className="button-ghost">
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={saving}
            data-disabled-reason={
              origin.trim()
                ? "Enter a password to save"
                : "Enter the website address"
            }
            disabled={!canSave || saving}
            className="button-primary"
          >
            {editing ? "Save changes" : "Save password"}
          </PendingButton>
        </footer>
      </form>
    </Modal>
  );
}
