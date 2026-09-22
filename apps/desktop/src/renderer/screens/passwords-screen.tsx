import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Search,
  StickyNote,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState } from "react";
import { Modal } from "../components/modal.js";
import {
  displayHost,
  type PasswordDraft,
  PasswordEditor,
} from "../components/password-editor.js";
import { ShortcutHint } from "../components/shortcut-hint.js";
import { SiteFavicon } from "../components/site-favicon.js";
import { desktopApi, type SavedCredential } from "../lib/desktop-api.js";
import { useListMotion } from "../lib/list-motion.js";

const EMPTY_DRAFT: PasswordDraft = { origin: "", username: "", note: "" };

function matchesQuery(credential: SavedCredential, query: string): boolean {
  const terms = query.trim().toLocaleLowerCase().split(/\s+/).filter(Boolean);
  if (terms.length === 0) return true;
  const searchable = [
    credential.origin,
    displayHost(credential.origin),
    credential.username,
  ]
    .join("\n")
    .toLocaleLowerCase();
  return terms.every((term) => searchable.includes(term));
}

function updatedLabel(time: number): string {
  if (!time) return "";
  const date = new Date(time);
  const today = new Date();
  if (date.toDateString() === today.toDateString()) return "Today";
  return date.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: date.getFullYear() === today.getFullYear() ? undefined : "numeric",
  });
}

/** A revealed secret opens in place under its row and closes the same way. */
function Reveal({
  label,
  text,
  testId,
  className,
}: {
  label: string;
  text: string | null;
  testId: string;
  className: string;
}) {
  const [rendered, setRendered] = useState(text);
  const open = text !== null;
  useEffect(() => {
    if (text !== null) setRendered(text);
  }, [text]);
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity] duration-150 ease-[cubic-bezier(0.2,0,0,1)] ${
        open ? "grid-rows-[1fr] opacity-100" : "grid-rows-[0fr] opacity-0"
      }`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) setRendered(null);
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="mb-2 ml-9 mr-2 flex gap-3 rounded-md bg-bg-inset px-2.5 py-2 text-xs">
          <span className="w-16 shrink-0 text-fg-faint">{label}</span>
          <span
            data-testid={testId}
            className={`min-w-0 flex-1 text-fg break-all ${className}`}
          >
            {rendered}
          </span>
        </div>
      </div>
    </div>
  );
}

const iconButton =
  "grid size-7 shrink-0 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-raised hover:text-fg";

/**
 * Every login this profile saved, and the sites it never saves for.
 * Rows reveal, copy, edit (username, password, note) and delete; adding
 * and editing open the shared password dialog. Opened from the palette,
 * profile settings, and "Manage passwords" under a login field.
 */
export function PasswordsScreen({ profileId }: { profileId: string }) {
  const [credentials, setCredentials] = useState<SavedCredential[] | null>(
    null,
  );
  const [neverSaved, setNeverSaved] = useState<string[]>([]);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<PasswordDraft>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [revealed, setRevealed] = useState<{
    id: string;
    password: string;
    note: string;
  } | null>(null);
  const [deleteTarget, setDeleteTarget] = useState<SavedCredential | null>(
    null,
  );
  const [confirmDelete, setConfirmDelete] = useState(false);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const copiedTimer = useRef<number | undefined>(undefined);
  const editorTrigger = useRef<HTMLElement | null>(null);

  const fail = (cause: unknown) =>
    setError(cause instanceof Error ? cause.message : String(cause));

  useEffect(() => {
    let cancelled = false;
    const load = () =>
      Promise.all([
        desktopApi.vaultList({ profileId }),
        desktopApi.vaultNeverSaved({ profileId }),
      ])
        .then(([saved, never]) => {
          if (cancelled) return;
          setCredentials(saved);
          setNeverSaved(never);
        })
        .catch((cause: unknown) => {
          if (!cancelled)
            setError(cause instanceof Error ? cause.message : String(cause));
        });
    setCredentials(null);
    setRevealed(null);
    void load();
    const stop = desktopApi.onVaultChanged((changed) => {
      if (changed === profileId) void load();
    });
    return () => {
      cancelled = true;
      stop();
    };
  }, [profileId]);

  useEffect(() => () => window.clearTimeout(copiedTimer.current), []);

  const filtered = useMemo(
    () => (credentials ?? []).filter((item) => matchesQuery(item, query)),
    [credentials, query],
  );
  const filteredNever = useMemo(() => {
    const words = query.toLocaleLowerCase().trim().split(/\s+/);
    return neverSaved.filter((origin) =>
      words.every((word) => origin.toLocaleLowerCase().includes(word)),
    );
  }, [neverSaved, query]);
  useListMotion(
    listRef,
    [...filtered.map(({ id }) => id), ...filteredNever].join("\n"),
  );

  const openEditor = (next: PasswordDraft, trigger: HTMLElement) => {
    editorTrigger.current = trigger;
    setDraft(next);
    setEditorOpen(true);
  };
  const closeEditor = () => {
    setEditorOpen(false);
    requestAnimationFrame(() => editorTrigger.current?.focus());
  };

  /** Secrets (password, note) come from the vault behind device auth. */
  const reveal = async (credential: SavedCredential) => {
    setError(null);
    try {
      return await desktopApi.vaultReveal({ profileId, id: credential.id });
    } catch (cause) {
      fail(cause);
      return null;
    }
  };

  const toggleReveal = async (credential: SavedCredential) => {
    if (revealed?.id === credential.id) {
      setRevealed(null);
      return;
    }
    const secret = await reveal(credential);
    if (secret)
      setRevealed({
        id: credential.id,
        password: secret.password,
        note: secret.note,
      });
  };

  const edit = async (credential: SavedCredential, trigger: HTMLElement) => {
    // Editing shows the note, so it opens behind the same unlock.
    const secret = credential.hasNote ? await reveal(credential) : null;
    if (credential.hasNote && !secret) return;
    openEditor(
      {
        id: credential.id,
        origin: credential.origin,
        username: credential.username,
        note: secret?.note ?? "",
      },
      trigger,
    );
  };

  const copy = async (credential: SavedCredential) => {
    setError(null);
    try {
      if (
        !(await desktopApi.vaultCopyPassword({ profileId, id: credential.id }))
      )
        return;
      setCopiedId(credential.id);
      window.clearTimeout(copiedTimer.current);
      copiedTimer.current = window.setTimeout(() => setCopiedId(null), 1_500);
    } catch (cause) {
      fail(cause);
    }
  };

  const remove = async (credential: SavedCredential) => {
    setDeleteError(null);
    try {
      await desktopApi.vaultRemove({ profileId, id: credential.id });
      setConfirmDelete(false);
      if (revealed?.id === credential.id) setRevealed(null);
    } catch (cause) {
      setDeleteError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const allowSaving = (origin: string) => {
    void desktopApi.vaultAllowSaving({ profileId, origin }).catch(fail);
  };

  const count = credentials?.length ?? 0;
  return (
    <div className="flex min-h-0 flex-1 flex-col" data-testid="passwords-page">
      <header className="flex h-12 shrink-0 items-center gap-2 border-b border-border px-4">
        <KeyRound className="size-4 text-fg-muted" />
        <h1 className="min-w-0 flex-1 text-sm font-medium text-fg">
          Passwords
          {credentials && (
            <span className="ml-2 text-xs font-normal text-fg-faint">
              {count} saved
            </span>
          )}
        </h1>
        <label className="field flex h-7 w-56 items-center gap-2 rounded-full px-3">
          <Search className="size-3.5 shrink-0 text-fg-faint" />
          <input
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Escape" && query) {
                event.preventDefault();
                setQuery("");
              }
            }}
            placeholder="Filter passwords"
            aria-label="Filter passwords"
            data-testid="password-search"
            spellCheck={false}
            className="min-w-0 flex-1 bg-transparent text-[12px] text-fg outline-none placeholder:text-fg-faint"
          />
        </label>
        <button
          type="button"
          onClick={(event) =>
            openEditor({ ...EMPTY_DRAFT }, event.currentTarget)
          }
          className="button-primary button-sm"
        >
          <Plus className="size-3.5" /> Add
        </button>
      </header>
      <div className="min-h-0 flex-1 overflow-auto px-4 pb-6">
        <div ref={listRef} className="mx-auto max-w-3xl">
          {filtered.length > 0 && (
            <h2 className="pb-2 pt-5 text-xs font-medium text-fg-muted">
              Saved passwords
            </h2>
          )}
          {filtered.map((credential) => {
            const host = displayHost(credential.origin);
            const open = revealed?.id === credential.id;
            return (
              <div
                key={credential.id}
                data-item-id={credential.id}
                data-testid="password-row"
                className="group rounded-md transition-colors duration-150 hover:bg-bg-overlay focus-within:bg-bg-overlay"
              >
                <div className="flex min-w-0 items-center gap-1">
                  <button
                    type="button"
                    onClick={(event) =>
                      void edit(credential, event.currentTarget)
                    }
                    className="flex min-w-0 flex-1 cursor-pointer items-center gap-3 rounded-md px-2 py-2 text-left"
                  >
                    <SiteFavicon url={credential.origin} className="size-4" />
                    <span className="min-w-0 flex-1">
                      <span className="block truncate text-[13px] text-fg">
                        {host}
                      </span>
                      <span className="flex min-w-0 items-center gap-1.5 text-xs text-fg-faint">
                        <span className="truncate">
                          {credential.username || "No username"}
                        </span>
                        {credential.hasNote && (
                          <span
                            className="inline-flex shrink-0 items-center gap-1"
                            data-testid="password-row-note"
                          >
                            <StickyNote className="size-3" /> Note
                          </span>
                        )}
                      </span>
                    </span>
                    <span className="shrink-0 text-[11px] tabular-nums text-fg-faint">
                      {updatedLabel(credential.updatedAt)}
                    </span>
                  </button>
                  <span className="mr-1 flex shrink-0 items-center">
                    <ShortcutHint label={open ? "Hide" : "Reveal"}>
                      <button
                        type="button"
                        onClick={() => void toggleReveal(credential)}
                        aria-label={
                          open
                            ? `Hide password for ${host}`
                            : `Reveal password for ${host}`
                        }
                        className={`${iconButton} ${open ? "" : "row-reveal"}`}
                      >
                        {open ? (
                          <EyeOff className="size-3.5" />
                        ) : (
                          <Eye className="size-3.5" />
                        )}
                      </button>
                    </ShortcutHint>
                    <ShortcutHint label="Copy password">
                      <button
                        type="button"
                        onClick={() => void copy(credential)}
                        aria-label={
                          copiedId === credential.id
                            ? `Password for ${host} copied`
                            : `Copy password for ${host}`
                        }
                        className={`${iconButton} row-reveal`}
                      >
                        <span className="relative grid size-3.5 place-items-center">
                          <Copy
                            className={`col-start-1 row-start-1 size-3.5 transition-[opacity,transform] duration-150 ${
                              copiedId === credential.id
                                ? "scale-75 opacity-0"
                                : "scale-100 opacity-100"
                            }`}
                          />
                          <Check
                            className={`col-start-1 row-start-1 size-3.5 text-success transition-[opacity,transform] duration-150 ${
                              copiedId === credential.id
                                ? "scale-100 opacity-100"
                                : "scale-75 opacity-0"
                            }`}
                          />
                        </span>
                      </button>
                    </ShortcutHint>
                    <ShortcutHint label="Edit">
                      <button
                        type="button"
                        onClick={(event) =>
                          void edit(credential, event.currentTarget)
                        }
                        aria-label={`Edit password for ${host}`}
                        className={`${iconButton} row-reveal`}
                      >
                        <Pencil className="size-3.5" />
                      </button>
                    </ShortcutHint>
                    <ShortcutHint label="Delete">
                      <button
                        type="button"
                        onClick={() => {
                          setDeleteTarget(credential);
                          setDeleteError(null);
                          setConfirmDelete(true);
                        }}
                        aria-label={`Delete password for ${host}`}
                        className={`${iconButton} row-reveal hover:bg-danger/10 hover:text-danger`}
                      >
                        <Trash2 className="size-3.5" />
                      </button>
                    </ShortcutHint>
                  </span>
                </div>
                <Reveal
                  label="Password"
                  text={open && revealed ? revealed.password : null}
                  testId="revealed-password"
                  className="font-mono"
                />
                <Reveal
                  label="Note"
                  text={open && revealed?.note ? revealed.note : null}
                  testId="revealed-note"
                  className="whitespace-pre-wrap"
                />
              </div>
            );
          })}
          {filteredNever.length > 0 && (
            <h2 className="pb-2 pt-6 text-xs font-medium text-fg-muted">
              Never saved
            </h2>
          )}
          {filteredNever.map((origin) => (
            <div
              key={origin}
              data-item-id={origin}
              data-testid="never-saved-row"
              className="group flex min-w-0 items-center gap-3 rounded-md px-2 py-2 transition-colors duration-150 hover:bg-bg-overlay focus-within:bg-bg-overlay"
            >
              <SiteFavicon url={origin} className="size-4" />
              <span className="min-w-0 flex-1 truncate text-[13px] text-fg">
                {displayHost(origin)}
              </span>
              <button
                type="button"
                onClick={() => allowSaving(origin)}
                className="row-reveal button-ghost button-sm"
              >
                Allow saving
              </button>
            </div>
          ))}
          {filtered.length === 0 && filteredNever.length === 0 && (
            <p className="py-16 text-center text-[13px] text-fg-muted">
              {!credentials
                ? (error ?? "Reading passwords…")
                : query
                  ? "No password matches."
                  : "Passwords you save while signing in appear here."}
            </p>
          )}
          {error && credentials && (
            <p role="alert" className="mt-3 text-xs text-danger">
              {error}
            </p>
          )}
        </div>
      </div>

      <PasswordEditor
        open={editorOpen}
        profileId={profileId}
        draft={draft}
        onClose={closeEditor}
      />
      <Modal
        open={confirmDelete}
        onClose={() => setConfirmDelete(false)}
        width={420}
      >
        <div className="px-5 pt-5">
          <h2 className="text-sm font-semibold text-fg">
            Delete the password for{" "}
            {displayHost(deleteTarget?.origin ?? "this website")}?
          </h2>
          <p className="mt-2 text-[13px] leading-relaxed text-fg-muted">
            {deleteTarget?.username
              ? `The login for ${deleteTarget.username} and its note are removed from this profile.`
              : "The saved login and its note are removed from this profile."}
          </p>
          <p
            className="mt-3 min-h-4 text-xs text-danger"
            role={deleteError ? "alert" : undefined}
          >
            {deleteError}
          </p>
        </div>
        <footer className="mt-1 flex justify-end gap-2 border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={() => setConfirmDelete(false)}
            className="button-ghost"
          >
            Cancel
          </button>
          <button
            type="button"
            onClick={() => deleteTarget && void remove(deleteTarget)}
            className="button-danger"
          >
            Delete password
          </button>
        </footer>
      </Modal>
      <span className="sr-only" aria-live="polite">
        {copiedId ? "Password copied. The clipboard clears in 30 seconds." : ""}
      </span>
    </div>
  );
}
