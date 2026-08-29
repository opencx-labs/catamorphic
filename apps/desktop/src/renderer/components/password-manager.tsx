import {
  Check,
  Copy,
  Eye,
  EyeOff,
  KeyRound,
  Pencil,
  Plus,
  Search,
  Trash2,
  X,
} from "lucide-react";
import { useEffect, useId, useMemo, useRef, useState } from "react";
import { desktopApi, type SavedCredential } from "../lib/desktop-api.js";
import { useListMotion } from "../lib/list-motion.js";
import { PendingButton } from "./pending-button.js";
import { ShortcutHint } from "./shortcut-hint.js";

interface CredentialDraft {
  id?: string;
  origin: string;
  username: string;
  password: string;
}

const EMPTY_DRAFT: CredentialDraft = {
  origin: "",
  username: "",
  password: "",
};

function displayHost(origin: string): string {
  try {
    return new URL(origin).host;
  } catch {
    return origin;
  }
}

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

function PasswordReveal({ password }: { password: string | null }) {
  const [renderedPassword, setRenderedPassword] = useState(password);
  const open = password !== null;
  useEffect(() => {
    if (password !== null) setRenderedPassword(password);
  }, [password]);
  return (
    <div
      className={`grid transition-[grid-template-rows,opacity,margin-top] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-100 ${
        open
          ? "mt-2 grid-rows-[1fr] opacity-100"
          : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
      }`}
      aria-hidden={!open}
      inert={!open ? true : undefined}
      onTransitionEnd={(event) => {
        if (event.target === event.currentTarget && !open) {
          setRenderedPassword(null);
        }
      }}
    >
      <div className="min-h-0 overflow-hidden">
        <div className="rounded-md bg-bg-overlay px-2.5 py-2 font-mono text-xs text-fg break-all">
          {renderedPassword}
        </div>
      </div>
    </div>
  );
}

export function PasswordManager({ profileId }: { profileId: string }) {
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CredentialDraft>(EMPTY_DRAFT);
  const [editorOpen, setEditorOpen] = useState(false);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{
    id: string;
    password: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const instanceId = useId();
  const searchId = `${instanceId}-password-search`;
  const searchSummaryId = `${instanceId}-password-search-summary`;
  const originId = `${instanceId}-password-origin`;
  const usernameId = `${instanceId}-password-username`;
  const passwordId = `${instanceId}-password-value`;
  const editHintId = `${instanceId}-password-edit-hint`;
  const editorOriginRef = useRef<HTMLInputElement>(null);
  const editorTriggerRef = useRef<HTMLButtonElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const copiedTimerRef = useRef<number | undefined>(undefined);

  const reload = async () => {
    const saved = await desktopApi.vaultList({ profileId });
    setCredentials(saved);
  };

  useEffect(() => {
    let cancelled = false;
    setCredentials([]);
    setDraft(EMPTY_DRAFT);
    setEditorOpen(false);
    setRevealed(null);
    setConfirmDelete(null);
    setQuery("");
    setLoading(true);
    desktopApi
      .vaultList({ profileId })
      .then((saved) => {
        if (!cancelled) setCredentials(saved);
      })
      .catch((cause) => {
        if (!cancelled) {
          setError(cause instanceof Error ? cause.message : String(cause));
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [profileId]);

  useEffect(
    () =>
      desktopApi.onVaultChanged((changedProfileId) => {
        if (changedProfileId !== profileId) return;
        void desktopApi
          .vaultList({ profileId })
          .then(setCredentials)
          .catch((cause) =>
            setError(cause instanceof Error ? cause.message : String(cause)),
          );
      }),
    [profileId],
  );

  const filtered = useMemo(() => {
    return credentials.filter((credential) => matchesQuery(credential, query));
  }, [credentials, query]);
  const filtering = query.trim().length > 0;
  const resultLabel = filtering
    ? `${filtered.length} ${filtered.length === 1 ? "match" : "matches"}`
    : loading
      ? "Loading saved logins"
      : `${credentials.length} saved ${credentials.length === 1 ? "login" : "logins"}`;
  useListMotion(listRef, filtered, {
    enterOnFirstPass: true,
    keepTransitions: "background-color 150ms cubic-bezier(0.2, 0, 0, 1)",
  });

  useEffect(() => {
    if (!editorOpen) return;
    const frame = requestAnimationFrame(() => editorOriginRef.current?.focus());
    return () => cancelAnimationFrame(frame);
  }, [editorOpen]);

  useEffect(
    () => () => {
      if (copiedTimerRef.current !== undefined) {
        window.clearTimeout(copiedTimerRef.current);
      }
    },
    [],
  );

  const openEditor = (
    nextDraft: CredentialDraft,
    trigger: HTMLButtonElement,
  ) => {
    editorTriggerRef.current = trigger;
    setDraft(nextDraft);
    setEditorOpen(true);
    setRevealed(null);
    setConfirmDelete(null);
  };

  const closeEditor = () => {
    setEditorOpen(false);
    requestAnimationFrame(() => editorTriggerRef.current?.focus());
  };

  const updateQuery = (value: string) => {
    setQuery(value);
    setRevealed(null);
    setConfirmDelete(null);
  };

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      if (draft.id) {
        await desktopApi.vaultUpdate({
          profileId,
          id: draft.id,
          origin: draft.origin,
          username: draft.username,
          ...(draft.password ? { password: draft.password } : {}),
        });
      } else {
        await desktopApi.vaultSave({
          profileId,
          origin: draft.origin,
          username: draft.username,
          password: draft.password,
        });
      }
      await reload();
      closeEditor();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setSaving(false);
    }
  };

  const reveal = async (credential: SavedCredential) => {
    if (revealed?.id === credential.id) {
      setRevealed(null);
      return;
    }
    setError(null);
    try {
      const secret = await desktopApi.vaultReveal({
        profileId,
        id: credential.id,
      });
      if (secret) {
        setRevealed({ id: credential.id, password: secret.password });
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const copy = async (credential: SavedCredential) => {
    setError(null);
    try {
      const copied = await desktopApi.vaultCopyPassword({
        profileId,
        id: credential.id,
      });
      if (!copied) return;
      setCopiedId(credential.id);
      if (copiedTimerRef.current !== undefined) {
        window.clearTimeout(copiedTimerRef.current);
      }
      copiedTimerRef.current = window.setTimeout(() => {
        setCopiedId(null);
        copiedTimerRef.current = undefined;
      }, 1_500);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  const remove = async (credential: SavedCredential) => {
    setError(null);
    try {
      await desktopApi.vaultRemove({ profileId, id: credential.id });
      setConfirmDelete(null);
      if (revealed?.id === credential.id) setRevealed(null);
      await reload();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    }
  };

  return (
    <section className="mt-4 rounded-lg border border-border bg-bg-raised/30 p-4">
      <div className="flex items-start justify-between gap-3">
        <div>
          <h2 className="flex items-center gap-2 text-sm font-semibold text-fg">
            <KeyRound className="size-4 text-fg-muted" /> Passwords
          </h2>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Saved logins stay in this profile and are encrypted by your device.
          </p>
        </div>
        <button
          type="button"
          onClick={(event) =>
            openEditor({ ...EMPTY_DRAFT }, event.currentTarget)
          }
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg transition-opacity duration-150 hover:opacity-90"
        >
          <Plus className="size-3.5" /> Add password
        </button>
      </div>

      <div className="relative mt-3">
        <label className="sr-only" htmlFor={searchId}>
          Search passwords
        </label>
        <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-fg-faint" />
        <input
          id={searchId}
          data-testid="password-search"
          value={query}
          onChange={(event) => updateQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Escape" && query) {
              event.preventDefault();
              updateQuery("");
            }
          }}
          placeholder="Search websites and usernames"
          aria-describedby={searchSummaryId}
          className="field h-8 w-full rounded-md pl-8 pr-8 text-[13px]"
        />
        <button
          type="button"
          onClick={() => updateQuery("")}
          aria-label="Clear password search"
          className={`absolute right-1 top-1 grid size-6 place-items-center rounded-md text-fg-faint transition-[opacity,color,background-color] duration-150 hover:bg-bg-overlay hover:text-fg ${
            query
              ? "cursor-pointer opacity-100"
              : "pointer-events-none opacity-0"
          }`}
          tabIndex={query ? 0 : -1}
        >
          <X className="size-3.5" />
        </button>
      </div>

      <div
        id={searchSummaryId}
        className="mt-2 flex items-center justify-between text-[11px] text-fg-faint"
      >
        <span>{resultLabel}</span>
        {filtering && <span>Press Esc to clear</span>}
      </div>

      <div
        className={`grid transition-[grid-template-rows,opacity,margin-top] duration-200 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-100 ${
          editorOpen
            ? "mt-3 grid-rows-[1fr] opacity-100"
            : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
        }`}
        aria-hidden={!editorOpen}
        inert={!editorOpen ? true : undefined}
        onTransitionEnd={(event) => {
          if (event.target === event.currentTarget && !editorOpen) {
            setDraft(EMPTY_DRAFT);
          }
        }}
      >
        <div className="min-h-0 overflow-hidden">
          <div
            className="space-y-2 rounded-md border border-border bg-bg p-3"
            data-testid="password-editor"
          >
            <p className="text-xs font-medium text-fg">
              {draft.id ? "Edit password" : "Add password"}
            </p>
            <div className="grid gap-2 sm:grid-cols-2">
              <label className="block" htmlFor={originId}>
                <span className="mb-1 block text-[11px] text-fg-muted">
                  Website address
                </span>
                <input
                  ref={editorOriginRef}
                  id={originId}
                  data-testid="password-origin"
                  value={draft.origin}
                  onChange={(event) =>
                    setDraft({ ...draft, origin: event.target.value })
                  }
                  placeholder="https://example.com"
                  className="field h-8 w-full rounded-md px-2.5 text-[13px]"
                />
              </label>
              <label className="block" htmlFor={usernameId}>
                <span className="mb-1 block text-[11px] text-fg-muted">
                  Username
                </span>
                <input
                  id={usernameId}
                  data-testid="password-username"
                  value={draft.username}
                  onChange={(event) =>
                    setDraft({ ...draft, username: event.target.value })
                  }
                  autoComplete="off"
                  className="field h-8 w-full rounded-md px-2.5 text-[13px]"
                />
              </label>
            </div>
            <label className="block" htmlFor={passwordId}>
              <span className="mb-1 block text-[11px] text-fg-muted">
                {draft.id ? "New password" : "Password"}
              </span>
              <input
                id={passwordId}
                data-testid="password-value"
                type="password"
                value={draft.password}
                onChange={(event) =>
                  setDraft({ ...draft, password: event.target.value })
                }
                autoComplete="new-password"
                aria-describedby={draft.id ? editHintId : undefined}
                className="field h-8 w-full rounded-md px-2.5 font-mono text-[13px]"
              />
              {draft.id && (
                <span
                  id={editHintId}
                  className="mt-1 block text-[11px] text-fg-faint"
                >
                  Leave this blank to keep the current password.
                </span>
              )}
            </label>
            <div className="flex gap-2 pt-1">
              <PendingButton
                pending={saving}
                pendingLabel="Saving…"
                disabled={
                  !draft.origin.trim() ||
                  (!draft.id && !draft.password) ||
                  saving
                }
                onClick={() => void save()}
                className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg"
              >
                {draft.id ? "Save changes" : "Save password"}
              </PendingButton>
              <button
                type="button"
                onClick={closeEditor}
                className="h-8 rounded-md px-2.5 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
              >
                Cancel
              </button>
            </div>
          </div>
        </div>
      </div>

      <div
        ref={listRef}
        className="mt-3 overflow-hidden rounded-md border border-border"
      >
        {loading ? (
          <p className="px-3 py-4 text-center text-xs text-fg-faint">
            Loading passwords…
          </p>
        ) : filtered.length === 0 ? (
          <p className="px-3 py-5 text-center text-xs text-fg-faint">
            {query
              ? "No passwords match your search."
              : "No saved passwords yet."}
          </p>
        ) : (
          filtered.map((credential, index) => (
            <div
              key={credential.id}
              data-item-id={credential.id}
              className={`px-3 py-2.5 transition-colors duration-150 hover:bg-bg-overlay/40 ${index ? "border-t border-border" : ""}`}
            >
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <p className="truncate text-[13px] font-medium text-fg">
                    {displayHost(credential.origin)}
                  </p>
                  <p className="truncate text-xs text-fg-muted">
                    {credential.username || "No username"}
                  </p>
                </div>
                <div className="flex shrink-0 items-center gap-0.5">
                  <ShortcutHint
                    label={revealed?.id === credential.id ? "Hide" : "Reveal"}
                  >
                    <button
                      type="button"
                      onClick={() => void reveal(credential)}
                      aria-label={
                        revealed?.id === credential.id
                          ? `Hide password for ${displayHost(credential.origin)}`
                          : `Reveal password for ${displayHost(credential.origin)}`
                      }
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                    >
                      {revealed?.id === credential.id ? (
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
                          ? `Password for ${displayHost(credential.origin)} copied`
                          : `Copy password for ${displayHost(credential.origin)}`
                      }
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
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
                  <ShortcutHint label="Edit password">
                    <button
                      type="button"
                      onClick={(event) =>
                        openEditor(
                          { ...credential, password: "" },
                          event.currentTarget,
                        )
                      }
                      aria-label={`Edit password for ${displayHost(credential.origin)}`}
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </ShortcutHint>
                  <ShortcutHint label="Delete password">
                    <button
                      type="button"
                      onClick={() => {
                        setConfirmDelete(credential.id);
                        if (revealed?.id === credential.id) setRevealed(null);
                      }}
                      aria-label={`Delete password for ${displayHost(credential.origin)}`}
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted transition-colors duration-150 hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </ShortcutHint>
                </div>
              </div>
              <PasswordReveal
                password={
                  revealed?.id === credential.id ? revealed.password : null
                }
              />
              <div
                className={`grid transition-[grid-template-rows,opacity,margin-top] duration-150 ease-[cubic-bezier(0.2,0,0,1)] motion-reduce:duration-100 ${
                  confirmDelete === credential.id
                    ? "mt-2 grid-rows-[1fr] opacity-100"
                    : "pointer-events-none mt-0 grid-rows-[0fr] opacity-0"
                }`}
                aria-hidden={confirmDelete !== credential.id}
                inert={confirmDelete !== credential.id ? true : undefined}
              >
                <div className="min-h-0 overflow-hidden">
                  <div className="flex items-center justify-between gap-3 rounded-md bg-danger/10 px-2.5 py-2">
                    <p className="text-xs text-danger">
                      Delete the password for {displayHost(credential.origin)}?
                    </p>
                    <div className="flex gap-1.5">
                      <button
                        type="button"
                        onClick={() => void remove(credential)}
                        className="h-7 rounded-md bg-danger px-2.5 text-xs font-medium text-white transition-opacity duration-150 hover:opacity-90"
                      >
                        Delete password
                      </button>
                      <button
                        type="button"
                        onClick={() => setConfirmDelete(null)}
                        className="h-7 rounded-md px-2 text-xs text-fg-muted transition-colors duration-150 hover:bg-bg-overlay hover:text-fg"
                      >
                        Cancel
                      </button>
                    </div>
                  </div>
                </div>
              </div>
            </div>
          ))
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
      <span className="sr-only" aria-live="polite">
        {copiedId
          ? `Password for ${displayHost(credentials.find((credential) => credential.id === copiedId)?.origin ?? "this website")} copied. The clipboard will clear in 30 seconds.`
          : ""}
      </span>
    </section>
  );
}
