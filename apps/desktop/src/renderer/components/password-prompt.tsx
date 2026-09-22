import { CircleCheck, KeyRound, X } from "lucide-react";
import { useEffect, useId, useRef, useState } from "react";
import type {
  BrowserCredentialSaveOffer,
  SavedCredential,
} from "../lib/desktop-api.js";
import { displayHost, MaskedPassword } from "./password-editor.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

export type PasswordPromptState =
  | { kind: "offer"; offer: BrowserCredentialSaveOffer }
  | { kind: "saved"; origin: string; credential: SavedCredential };

/** A saved confirmation leaves on its own, unless the pointer is on it. */
const SAVED_LINGER_MS = 8_000;

/**
 * The password card in a browser tab's top-right corner, where Chrome's
 * key bubble opens: "Save password?" after a sign-in lands, "Update
 * password?" when a saved password changed, and "Password saved" when a
 * generated password saved itself. It never takes focus from the page;
 * the page keeps working underneath.
 */
export function PasswordPrompt({
  state,
  open,
  onSave,
  onNever,
  onDismiss,
  onUpdate,
  onExited,
}: {
  state: PasswordPromptState;
  open: boolean;
  onSave: () => Promise<void>;
  onNever: () => void;
  onDismiss: () => void;
  /** Opens the editor on the saved login (username, note). */
  onUpdate: () => void;
  onExited: () => void;
}) {
  const titleId = useId();
  const [saving, setSaving] = useState(false);
  const [held, setHeld] = useState(false);
  const cardRef = useRef<HTMLDivElement>(null);

  const saved = state.kind === "saved";
  useEffect(() => {
    if (!open || !saved || held) return;
    const timer = window.setTimeout(onDismiss, SAVED_LINGER_MS);
    return () => window.clearTimeout(timer);
  }, [open, saved, held, onDismiss]);

  const origin = state.kind === "offer" ? state.offer.origin : state.origin;
  const username =
    state.kind === "offer" ? state.offer.username : state.credential.username;
  const host = displayHost(origin);
  const update = state.kind === "offer" && state.offer.mode === "update";
  const title = saved
    ? "Password saved"
    : update
      ? "Update password?"
      : "Save password?";

  return (
    <div
      ref={cardRef}
      role="dialog"
      aria-labelledby={titleId}
      data-testid="password-prompt"
      data-kind={saved ? "saved" : update ? "update" : "save"}
      onMouseEnter={() => setHeld(true)}
      onMouseLeave={() => setHeld(false)}
      onFocus={() => setHeld(true)}
      onBlur={(event) => {
        if (!cardRef.current?.contains(event.relatedTarget as Node | null))
          setHeld(false);
      }}
      onAnimationEnd={(event) => {
        if (event.animationName === "pop-out" && !open) onExited();
      }}
      className={`absolute right-3 top-3 z-30 w-[340px] max-w-[calc(100%-24px)] origin-top-right rounded-lg border border-border bg-bg-overlay shadow-2xl ${
        open ? "animate-pop-in" : "pointer-events-none animate-pop-out"
      }`}
    >
      <div className="flex items-start gap-3 px-4 pt-4">
        <span
          className={`grid size-8 shrink-0 place-items-center rounded-md bg-bg-inset ${
            saved ? "text-success" : "text-fg-muted"
          }`}
        >
          {saved ? (
            <CircleCheck className="size-4" />
          ) : (
            <KeyRound className="size-4" />
          )}
        </span>
        <div className="min-w-0 flex-1 pt-px">
          <h2 id={titleId} className="text-[13px] font-semibold text-fg">
            {title}
          </h2>
          <p className="mt-0.5 truncate text-xs text-fg-muted">{host}</p>
        </div>
        {!saved && (
          <ShortcutHint label="Not now">
            <button
              type="button"
              onClick={onDismiss}
              aria-label="Not now"
              className="-mr-1.5 -mt-1 grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-faint transition-colors duration-150 hover:bg-bg-raised hover:text-fg"
            >
              <X className="size-3.5" />
            </button>
          </ShortcutHint>
        )}
      </div>
      <div className="mx-4 mt-3 rounded-md bg-bg-inset px-3 py-2">
        <p
          className={`truncate text-[13px] ${username ? "text-fg" : "text-fg-faint"}`}
          data-testid="password-prompt-username"
        >
          {username || "No username"}
        </p>
        <MaskedPassword className="mt-1.5 text-fg-faint" />
      </div>
      <footer className="flex items-center gap-2 px-4 pb-4 pt-3">
        {saved ? (
          <>
            <span className="flex-1" />
            <button
              type="button"
              onClick={onUpdate}
              className="button-secondary button-sm"
              data-testid="password-prompt-update"
            >
              Update
            </button>
            <button
              type="button"
              onClick={onDismiss}
              className="button-primary button-sm"
            >
              Done
            </button>
          </>
        ) : (
          <>
            {update ? (
              <span className="flex-1" />
            ) : (
              <>
                <button
                  type="button"
                  onClick={onNever}
                  className="button-ghost button-sm"
                  data-testid="password-prompt-never"
                >
                  Never for this site
                </button>
                <span className="flex-1" />
              </>
            )}
            {update && (
              <button
                type="button"
                onClick={onDismiss}
                className="button-ghost button-sm"
              >
                Not now
              </button>
            )}
            <PendingButton
              pending={saving}
              onClick={() => {
                setSaving(true);
                void onSave().finally(() => setSaving(false));
              }}
              className="button-primary button-sm"
              data-testid="password-prompt-save"
            >
              {update ? "Update" : "Save"}
            </PendingButton>
          </>
        )}
      </footer>
    </div>
  );
}
