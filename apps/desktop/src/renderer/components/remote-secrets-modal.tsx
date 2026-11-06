import { ChevronRight, LockKeyhole } from "lucide-react";
import {
  type FormEvent,
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
} from "react";
import {
  desktopApi,
  type RemoteProjectMember,
  type RemoteProjectSecret,
} from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

const message = (cause: unknown) =>
  cause instanceof Error ? cause.message : String(cause);

/** Whose value a row edits: the caller's (`me`), the shared one, or a member's. */
type Target =
  | { kind: "own" }
  | { kind: "shared" }
  | { kind: "member"; id: string };

const targetKey = (name: string, target: Target) =>
  `${name}\u0000${target.kind === "member" ? target.id : target.kind}`;

const targetMember = (target: Target): string | undefined =>
  target.kind === "own"
    ? "me"
    : target.kind === "member"
      ? target.id
      : undefined;

/**
 * The project's secrets on its server (ADR 0206): what each one is for and
 * which Environments set it, the member's own value, and for people who
 * manage secrets, the shared value and everyone's own. Values only ever
 * travel to the server; nothing here shows one again.
 */
export function RemoteSecretsModal({
  open,
  projectId,
  canManage,
  canListMembers,
  onClose,
}: {
  open: boolean;
  projectId: string;
  /** Holds `secrets:write`: sets the shared value and members' values. */
  canManage: boolean;
  /** Holds `memberships:read`: names every member, not only those with values. */
  canListMembers: boolean;
  onClose: () => void;
}) {
  const [secrets, setSecrets] = useState<RemoteProjectSecret[] | null>(null);
  const [members, setMembers] = useState<RemoteProjectMember[] | null>(null);
  const [editing, setEditing] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const titleId = useId();

  const load = useCallback(async () => {
    const data = await desktopApi.remoteSecrets({
      projectId,
      members: canManage && canListMembers,
    });
    setSecrets(data.secrets);
    setMembers(data.members);
  }, [projectId, canManage, canListMembers]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setEditing(null);
    void load().catch((cause: unknown) => setError(message(cause)));
  }, [open, load]);

  const save = async (name: string, target: Target, value: string) => {
    const key = targetKey(name, target);
    setBusy(key);
    setError(null);
    try {
      const member = targetMember(target);
      await desktopApi.remoteSecretSet({
        projectId,
        name,
        value,
        ...(member ? { member } : {}),
      });
      setEditing(null);
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const clear = async (name: string, target: Target) => {
    const key = targetKey(name, target);
    setBusy(key);
    setError(null);
    try {
      const member = targetMember(target);
      await desktopApi.remoteSecretDelete({
        projectId,
        name,
        ...(member ? { member } : {}),
      });
      await load();
    } catch (cause) {
      setError(message(cause));
    } finally {
      setBusy(null);
    }
  };

  const row = (input: {
    secret: RemoteProjectSecret;
    target: Target;
    title: string;
    detail: string;
    isSet: boolean;
  }) => {
    const key = targetKey(input.secret.name, input.target);
    const name = input.secret.name;
    return (
      <ValueRow
        key={key}
        title={input.title}
        detail={input.detail}
        isSet={input.isSet}
        secretName={name}
        clearQuestion={
          input.target.kind === "shared"
            ? `Clear the shared value of ${name}? Chats lose it at their next turn.`
            : input.target.kind === "member"
              ? `Clear the value of ${name} for ${input.title}? Their chats lose it at their next turn.`
              : undefined
        }
        editing={editing === key}
        pending={busy === key}
        disabled={busy !== null}
        onEdit={() => {
          setError(null);
          setEditing(key);
        }}
        onCancel={() => setEditing(null)}
        onSave={(value) => void save(input.secret.name, input.target, value)}
        onClear={() => void clear(input.secret.name, input.target)}
      />
    );
  };

  const now = Date.now();

  return (
    <Modal open={open} onClose={onClose} width={560} labelledBy={titleId}>
      <div className="flex max-h-[min(720px,82vh)] flex-col">
        <header className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <LockKeyhole className="size-4 text-fg-muted" />
            <h2 id={titleId} className="text-[15px] font-semibold text-fg">
              Secrets
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Values such as API keys that this project's Environments set for its
            chats on the server. Your own value reaches only your own chats. A
            saved value is never shown again.
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-3 overflow-y-auto px-5 py-4">
          {secrets && secrets.length === 0 && (
            <p className="text-xs leading-5 text-fg-muted">
              This project declares no secrets yet. Declare them under "secrets"
              in .work/project.json and list them on an Environment.
            </p>
          )}
          {secrets?.map((secret) => {
            const showing = expanded.includes(secret.name);
            const people = memberRows({ secret, members });
            const withValue = secret.members.length;
            return (
              <article
                key={secret.name}
                className="flex flex-col gap-2 rounded-xl border border-border p-3"
                data-testid="remote-secret"
              >
                <div className="min-w-0">
                  <p className="flex items-baseline gap-2">
                    <span className="truncate font-mono text-[12px] text-fg">
                      {secret.name}
                    </span>
                    {secret.label && (
                      <span className="truncate text-xs text-fg-muted">
                        {secret.label}
                      </span>
                    )}
                  </p>
                  {secret.description && (
                    <p className="mt-0.5 text-xs leading-5 text-fg-muted">
                      {secret.description}
                    </p>
                  )}
                  <p className="mt-0.5 text-xs text-fg-faint">
                    {secret.environments.length > 0
                      ? `Set in ${secret.environments.length === 1 ? "Environment" : "Environments"} ${secret.environments.join(", ")}`
                      : "No Environment sets it in chats yet"}
                  </p>
                </div>
                <div className="flex flex-col divide-y divide-border rounded-lg bg-bg-inset px-3">
                  {row({
                    secret,
                    target: { kind: "own" },
                    title: "Your value",
                    detail: secret.own
                      ? `Set ${ago(secret.ownUpdatedAt, now)}`
                      : secret.shared
                        ? "Not set: your chats use the shared value"
                        : "Not set",
                    isSet: secret.own,
                  })}
                  {canManage &&
                    row({
                      secret,
                      target: { kind: "shared" },
                      title: "Shared value",
                      detail: secret.shared
                        ? `Set ${ago(secret.updatedAt, now)}`
                        : "Not set",
                      isSet: secret.shared,
                    })}
                </div>
                {canManage && people.length > 0 && (
                  <div className="flex flex-col gap-1">
                    <button
                      type="button"
                      onClick={() =>
                        setExpanded((current) =>
                          showing
                            ? current.filter((name) => name !== secret.name)
                            : [...current, secret.name],
                        )
                      }
                      aria-expanded={showing}
                      className="flex h-7 w-fit cursor-pointer items-center gap-1 rounded-md px-1.5 text-xs text-fg-muted hover:bg-bg-overlay hover:text-fg"
                    >
                      <ChevronRight
                        className={`size-3.5 transition-transform duration-150 ${showing ? "rotate-90" : ""}`}
                      />
                      Members' values
                      <span className="text-fg-faint">
                        {withValue === 0
                          ? "none set"
                          : withValue === 1
                            ? "1 set"
                            : `${withValue} set`}
                      </span>
                    </button>
                    {showing && (
                      <div
                        className="flex flex-col divide-y divide-border rounded-lg bg-bg-inset px-3"
                        data-testid="remote-secret-members"
                      >
                        {people.map((person) => {
                          const value = secret.members.find(
                            (entry) => entry.member === person.id,
                          );
                          return row({
                            secret,
                            target: { kind: "member", id: person.id },
                            title: person.title,
                            detail: value
                              ? `Set ${ago(value.updatedAt, now)}`
                              : "Not set",
                            isSet: value !== undefined,
                          });
                        })}
                      </div>
                    )}
                  </div>
                )}
              </article>
            );
          })}
        </div>

        <footer className="flex items-center gap-2 border-t border-border px-5 py-3.5">
          <p
            className={`min-h-5 min-w-0 flex-1 truncate text-xs leading-5 ${error ? "text-danger" : "text-fg-faint"}`}
            role={error ? "alert" : undefined}
            data-testid="remote-secrets-status"
          >
            {error ?? (secrets === null ? "Loading…" : null)}
          </p>
          <button type="button" onClick={onClose} className="button-ghost">
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}

/**
 * The members a manager may give a value: every member when the list is
 * readable (but the manager, whose row is "Your value"), else those who
 * hold one.
 */
function memberRows(input: {
  secret: RemoteProjectSecret;
  members: RemoteProjectMember[] | null;
}): Array<{ id: string; title: string }> {
  if (!input.members)
    return input.secret.members.map((value) => ({
      id: value.member,
      title: value.member,
    }));
  const named = input.members.map((member) => ({
    id: member.externalUserId,
    title: member.name ?? member.email ?? member.externalUserId,
  }));
  const known = new Set(named.map((member) => member.id));
  // Someone who left still holds a value until it is cleared.
  const departed = input.secret.members
    .filter((value) => !known.has(value.member))
    .map((value) => ({ id: value.member, title: value.member }));
  return [...named, ...departed];
}

function ValueRow({
  title,
  detail,
  isSet,
  secretName,
  clearQuestion,
  editing,
  pending,
  disabled,
  onEdit,
  onCancel,
  onSave,
  onClear,
}: {
  title: string;
  detail: string;
  isSet: boolean;
  secretName: string;
  /** Asked in place before clearing a value other people's chats use. */
  clearQuestion?: string;
  editing: boolean;
  pending: boolean;
  disabled: boolean;
  onEdit: () => void;
  onCancel: () => void;
  onSave: (value: string) => void;
  onClear: () => void;
}) {
  // The field stays uncontrolled: React copies a controlled input's value
  // into its `value` attribute, which puts the secret in the page's markup.
  // Only whether it is empty is state.
  const inputRef = useRef<HTMLInputElement>(null);
  const [empty, setEmpty] = useState(true);
  useEffect(() => {
    if (!editing) return;
    const input = inputRef.current;
    return () => {
      // Saved, cancelled or closed: the value never outlives the field.
      if (input) input.value = "";
      setEmpty(true);
    };
  }, [editing]);
  const [confirming, setConfirming] = useState(false);
  useEffect(() => {
    if (!isSet || editing) setConfirming(false);
  }, [isSet, editing]);
  const questionId = useId();
  const rowRef = useRef<HTMLDivElement>(null);
  const keepButton = useRef<HTMLButtonElement>(null);
  const refocusClear = useRef(false);
  useEffect(() => {
    // Keyboard focus follows the question in and back out.
    if (confirming) {
      keepButton.current?.focus();
      return;
    }
    if (!refocusClear.current) return;
    refocusClear.current = false;
    rowRef.current
      ?.querySelector<HTMLButtonElement>("[data-row-clear]")
      ?.focus();
  }, [confirming]);
  const waitReason = "Wait for the current change to finish";

  if (editing) {
    const submit = (event: FormEvent) => {
      event.preventDefault();
      const value = inputRef.current?.value ?? "";
      if (value.length > 0) onSave(value);
    };
    return (
      <form className="flex flex-col gap-2 py-2.5" onSubmit={submit}>
        <p className="text-[13px] text-fg">{title}</p>
        <div className="flex items-center gap-2">
          <input
            ref={inputRef}
            type="password"
            onChange={(event) =>
              setEmpty(event.currentTarget.value.length === 0)
            }
            autoComplete="off"
            spellCheck={false}
            // biome-ignore lint/a11y/noAutofocus: the field the person asked to fill
            autoFocus
            aria-label={`New value of ${secretName} for ${title}`}
            placeholder="Paste the value"
            className="field h-8 min-w-0 flex-1 px-2.5 font-mono text-[12px]"
          />
          <button type="button" onClick={onCancel} className="button-ghost">
            Cancel
          </button>
          <PendingButton
            type="submit"
            pending={pending}
            disabled={empty || disabled}
            data-disabled-reason="Paste a value first"
            className="button-primary button-sm"
          >
            Save
          </PendingButton>
        </div>
      </form>
    );
  }

  if (confirming && clearQuestion) {
    return (
      <div
        className="flex items-center gap-3 py-2.5"
        data-testid="remote-secret-clear-confirm"
      >
        <p
          id={questionId}
          className="min-w-0 flex-1 text-[13px] leading-5 text-fg"
        >
          {clearQuestion}
        </p>
        <button
          ref={keepButton}
          type="button"
          disabled={pending}
          data-disabled-reason={waitReason}
          aria-describedby={questionId}
          onClick={() => {
            refocusClear.current = true;
            setConfirming(false);
          }}
          className="button-ghost button-sm"
        >
          Cancel
        </button>
        <PendingButton
          type="button"
          pending={pending}
          disabled={disabled}
          data-disabled-reason={waitReason}
          aria-describedby={questionId}
          onClick={onClear}
          className="button-danger button-sm"
        >
          Clear
        </PendingButton>
      </div>
    );
  }

  return (
    <div ref={rowRef} className="flex items-center gap-3 py-2.5">
      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] text-fg">{title}</p>
        <p className="truncate text-xs text-fg-faint">{detail}</p>
      </div>
      {isSet && (
        <PendingButton
          type="button"
          pending={pending}
          disabled={disabled}
          data-disabled-reason={waitReason}
          data-row-clear=""
          onClick={clearQuestion ? () => setConfirming(true) : onClear}
          aria-label={`Clear ${title} of ${secretName}`}
          className="button-ghost button-sm"
        >
          Clear
        </PendingButton>
      )}
      <button
        type="button"
        disabled={disabled}
        data-disabled-reason={waitReason}
        onClick={onEdit}
        aria-label={`${isSet ? "Replace" : "Set"} ${title} of ${secretName}`}
        className="button-secondary button-sm"
      >
        {isSet ? "Replace" : "Set"}
      </button>
    </div>
  );
}

function ago(iso: string | null, now: number): string {
  if (!iso) return "";
  const seconds = Math.max(0, (now - Date.parse(iso)) / 1000);
  if (!Number.isFinite(seconds) || seconds < 60) return "just now";
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ago`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}h ago`;
  return `${Math.floor(hours / 24)}d ago`;
}
