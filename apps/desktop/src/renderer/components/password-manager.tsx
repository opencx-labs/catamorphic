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
} from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { desktopApi, type SavedCredential } from "../lib/desktop-api.js";
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

export function PasswordManager({ profileId }: { profileId: string }) {
  const [credentials, setCredentials] = useState<SavedCredential[]>([]);
  const [loading, setLoading] = useState(true);
  const [query, setQuery] = useState("");
  const [draft, setDraft] = useState<CredentialDraft | null>(null);
  const [saving, setSaving] = useState(false);
  const [revealed, setRevealed] = useState<{
    id: string;
    password: string;
  } | null>(null);
  const [confirmDelete, setConfirmDelete] = useState<string | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const reload = async () => {
    const saved = await desktopApi.vaultList({ profileId });
    setCredentials(saved);
  };

  useEffect(() => {
    let cancelled = false;
    setCredentials([]);
    setDraft(null);
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
    const needle = query.trim().toLowerCase();
    if (!needle) return credentials;
    return credentials.filter((credential) =>
      `${credential.origin}\n${credential.username}`
        .toLowerCase()
        .includes(needle),
    );
  }, [credentials, query]);

  const save = async () => {
    if (!draft) return;
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
      setDraft(null);
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
      setTimeout(() => setCopiedId(null), 1_500);
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
          onClick={() => {
            setDraft({ ...EMPTY_DRAFT });
            setRevealed(null);
          }}
          className="flex h-8 shrink-0 cursor-pointer items-center gap-1.5 rounded-md bg-accent px-2.5 text-xs font-medium text-accent-fg"
        >
          <Plus className="size-3.5" /> Add password
        </button>
      </div>

      <label className="relative mt-3 block">
        <Search className="pointer-events-none absolute left-2.5 top-2 size-3.5 text-fg-faint" />
        <input
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="Search websites and usernames"
          aria-label="Search passwords"
          className="field h-8 w-full rounded-md pl-8 pr-2.5 text-[13px]"
        />
      </label>

      {draft && (
        <div
          className="mt-3 space-y-2 rounded-md border border-border bg-bg p-3"
          data-testid="password-editor"
        >
          <p className="text-xs font-medium text-fg">
            {draft.id ? "Edit password" : "Add password"}
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">
                Website
              </span>
              <input
                value={draft.origin}
                onChange={(event) =>
                  setDraft({ ...draft, origin: event.target.value })
                }
                placeholder="https://example.com"
                aria-label="Password website"
                className="field h-8 w-full rounded-md px-2.5 text-[13px]"
              />
            </label>
            <label className="block">
              <span className="mb-1 block text-[11px] text-fg-muted">
                Username
              </span>
              <input
                value={draft.username}
                onChange={(event) =>
                  setDraft({ ...draft, username: event.target.value })
                }
                autoComplete="off"
                aria-label="Password username"
                className="field h-8 w-full rounded-md px-2.5 text-[13px]"
              />
            </label>
          </div>
          <label className="block">
            <span className="mb-1 block text-[11px] text-fg-muted">
              Password {draft.id ? "(leave blank to keep it)" : ""}
            </span>
            <input
              type="password"
              value={draft.password}
              onChange={(event) =>
                setDraft({ ...draft, password: event.target.value })
              }
              autoComplete="new-password"
              aria-label="Password value"
              className="field h-8 w-full rounded-md px-2.5 font-mono text-[13px]"
            />
          </label>
          <div className="flex gap-2 pt-1">
            <PendingButton
              pending={saving}
              pendingLabel="Saving…"
              disabled={
                !draft.origin.trim() || (!draft.id && !draft.password) || saving
              }
              onClick={() => void save()}
              className="h-8 rounded-md bg-accent px-3 text-xs font-medium text-accent-fg"
            >
              Save
            </PendingButton>
            <button
              type="button"
              onClick={() => setDraft(null)}
              className="h-8 rounded-md px-2.5 text-xs text-fg-muted hover:bg-bg-overlay"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      <div className="mt-3 overflow-hidden rounded-md border border-border">
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
              className={`px-3 py-2.5 ${index ? "border-t border-border" : ""}`}
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
                          ? "Hide password"
                          : "Reveal password"
                      }
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
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
                      aria-label="Copy password"
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
                    >
                      {copiedId === credential.id ? (
                        <Check className="size-3.5 text-success" />
                      ) : (
                        <Copy className="size-3.5" />
                      )}
                    </button>
                  </ShortcutHint>
                  <ShortcutHint label="Edit password">
                    <button
                      type="button"
                      onClick={() => {
                        setDraft({ ...credential, password: "" });
                        setRevealed(null);
                      }}
                      aria-label="Edit password"
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-bg-overlay hover:text-fg"
                    >
                      <Pencil className="size-3.5" />
                    </button>
                  </ShortcutHint>
                  <ShortcutHint label="Delete password">
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(credential.id)}
                      aria-label="Delete password"
                      className="grid size-7 cursor-pointer place-items-center rounded-md text-fg-muted hover:bg-danger/10 hover:text-danger"
                    >
                      <Trash2 className="size-3.5" />
                    </button>
                  </ShortcutHint>
                </div>
              </div>
              {revealed?.id === credential.id && (
                <div className="mt-2 rounded-md bg-bg-overlay px-2.5 py-2 font-mono text-xs text-fg break-all">
                  {revealed.password}
                </div>
              )}
              {confirmDelete === credential.id && (
                <div className="mt-2 flex items-center justify-between gap-3 rounded-md bg-danger/10 px-2.5 py-2">
                  <p className="text-xs text-danger">Delete this password?</p>
                  <div className="flex gap-1.5">
                    <button
                      type="button"
                      onClick={() => void remove(credential)}
                      className="h-7 rounded-md bg-danger px-2.5 text-xs font-medium text-white"
                    >
                      Delete
                    </button>
                    <button
                      type="button"
                      onClick={() => setConfirmDelete(null)}
                      className="h-7 rounded-md px-2 text-xs text-fg-muted hover:bg-bg-overlay"
                    >
                      Cancel
                    </button>
                  </div>
                </div>
              )}
            </div>
          ))
        )}
      </div>
      {error && (
        <p className="mt-2 text-xs text-danger" role="alert">
          {error}
        </p>
      )}
    </section>
  );
}
