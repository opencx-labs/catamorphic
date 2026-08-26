import { Check, Copy, MailPlus, Users, X } from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import {
  desktopApi,
  type RemoteProjectAccessRequest,
  type RemoteProjectMember,
  type RemoteProjectRole,
} from "../lib/desktop-api.js";
import { Modal } from "./modal.js";
import { PendingButton } from "./pending-button.js";

export function RemoteMembersModal({
  open,
  projectId,
  onClose,
}: {
  open: boolean;
  projectId: string;
  onClose: () => void;
}) {
  const [roles, setRoles] = useState<RemoteProjectRole[]>([]);
  const [members, setMembers] = useState<RemoteProjectMember[]>([]);
  const [requests, setRequests] = useState<RemoteProjectAccessRequest[]>([]);
  const [drafts, setDrafts] = useState<Record<string, string[]>>({});
  const [email, setEmail] = useState("");
  const [inviteRole, setInviteRole] = useState("");
  const [inviteLink, setInviteLink] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async () => {
    const data = await desktopApi.remoteMembers(projectId);
    setRoles(data.roles.filter((role) => role.definition));
    setMembers(data.members);
    setRequests(data.requests);
    setDrafts(
      Object.fromEntries(
        data.members.map((member) => [member.externalUserId, member.roles]),
      ),
    );
    setInviteRole(
      (current) =>
        current || data.roles.find((role) => role.definition)?.slug || "",
    );
  }, [projectId]);

  useEffect(() => {
    if (!open) return;
    setError(null);
    setInviteLink(null);
    void load().catch((cause: unknown) =>
      setError(cause instanceof Error ? cause.message : String(cause)),
    );
  }, [open, load]);

  const toggleRole = (memberId: string, role: string) => {
    setDrafts((current) => {
      const selected = current[memberId] ?? [];
      return {
        ...current,
        [memberId]: selected.includes(role)
          ? selected.filter((item) => item !== role)
          : [...selected, role],
      };
    });
  };

  const saveMember = async (member: RemoteProjectMember) => {
    const selected = drafts[member.externalUserId] ?? [];
    if (selected.length === 0) {
      setError("Choose at least one role for this member.");
      return;
    }
    setBusy(member.externalUserId);
    setError(null);
    try {
      await desktopApi.remoteMemberSetRoles({
        projectId,
        externalUserId: member.externalUserId,
        roles: selected,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const invite = async () => {
    if (!inviteRole) return;
    setBusy("invite");
    setError(null);
    try {
      const created = await desktopApi.remoteMemberInvite({
        projectId,
        ...(email.trim() ? { email: email.trim() } : {}),
        roles: [inviteRole],
      });
      const link = created.connectLinks[0] ?? created.webLinks[0] ?? null;
      setInviteLink(link);
      if (link) await navigator.clipboard.writeText(link).catch(() => {});
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  const decideRequest = async (
    requestId: string,
    decision: "approved" | "denied",
  ) => {
    setBusy(requestId);
    setError(null);
    try {
      await desktopApi.remoteAdmissionDecide({
        projectId,
        requestId,
        decision,
      });
      await load();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : String(cause));
    } finally {
      setBusy(null);
    }
  };

  return (
    <Modal open={open} onClose={onClose}>
      <div className="flex max-h-[min(680px,80vh)] w-[520px] flex-col">
        <header className="border-b border-border px-5 py-4">
          <div className="flex items-center gap-2">
            <Users className="size-4 text-fg-muted" />
            <h2 className="text-[15px] font-semibold text-fg">
              Project members
            </h2>
          </div>
          <p className="mt-1 text-xs leading-5 text-fg-muted">
            Roles come from this project's committed role files. Managers can
            assign them without any server-owner account.
          </p>
        </header>

        <div className="flex flex-1 flex-col gap-5 overflow-y-auto px-5 py-4">
          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Invite someone
            </h3>
            <div className="grid grid-cols-[1fr_140px_auto] gap-2">
              <input
                type="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                placeholder="Email, or leave open"
                className="field h-9 min-w-0 px-2.5 text-[13px]"
              />
              <select
                value={inviteRole}
                onChange={(event) => setInviteRole(event.target.value)}
                className="field h-9 min-w-0 px-2 text-[13px]"
              >
                {roles.map((role) => (
                  <option key={role.slug} value={role.slug}>
                    {role.definition?.name ?? role.slug}
                  </option>
                ))}
              </select>
              <PendingButton
                type="button"
                pending={busy === "invite"}
                onClick={() => void invite()}
                disabled={!inviteRole}
                className="flex h-9 items-center gap-1.5 rounded-lg bg-accent px-3 text-xs font-semibold text-accent-fg disabled:opacity-50"
              >
                <MailPlus className="size-3.5" />
                Invite
              </PendingButton>
            </div>
            {inviteLink && (
              <button
                type="button"
                onClick={() => void navigator.clipboard.writeText(inviteLink)}
                className="flex items-center gap-2 rounded-lg border border-success/30 bg-success/10 px-3 py-2 text-left text-xs text-success"
              >
                <Copy className="size-3.5 shrink-0" />
                <span className="min-w-0 flex-1 truncate">
                  Invite link copied. Click to copy again.
                </span>
              </button>
            )}
          </section>

          {requests.length > 0 && (
            <section className="flex flex-col gap-2">
              <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
                Access requests
              </h3>
              {requests.map((request) => (
                <article
                  key={request.id}
                  className="flex items-center gap-3 rounded-xl border border-border p-3"
                >
                  <span className="min-w-0 flex-1">
                    <span className="block truncate text-[13px] font-medium text-fg">
                      {request.email}
                    </span>
                    <span className="block text-xs text-fg-faint">
                      Requested{" "}
                      {new Date(request.requestedAt).toLocaleDateString()}
                    </span>
                  </span>
                  <PendingButton
                    type="button"
                    pending={busy === request.id}
                    onClick={() => void decideRequest(request.id, "approved")}
                    className="grid size-8 place-items-center rounded-lg bg-success/10 text-success"
                    aria-label={`Approve ${request.email}`}
                  >
                    <Check className="size-4" />
                  </PendingButton>
                  <button
                    type="button"
                    disabled={busy === request.id}
                    onClick={() => void decideRequest(request.id, "denied")}
                    className="grid size-8 place-items-center rounded-lg text-fg-faint hover:bg-danger/10 hover:text-danger disabled:opacity-40"
                    aria-label={`Deny ${request.email}`}
                  >
                    <X className="size-4" />
                  </button>
                </article>
              ))}
            </section>
          )}

          <section className="flex flex-col gap-2">
            <h3 className="text-[11px] font-semibold uppercase tracking-wider text-fg-faint">
              Members
            </h3>
            {members.map((member) => {
              const selected = drafts[member.externalUserId] ?? [];
              const changed = selected.join("\0") !== member.roles.join("\0");
              return (
                <article
                  key={member.externalUserId}
                  className="rounded-xl border border-border p-3"
                >
                  <div className="flex items-start gap-3">
                    <span className="grid size-8 shrink-0 place-items-center rounded-full bg-bg-raised text-xs font-semibold text-fg-muted">
                      {(member.name ?? member.email ?? "?")
                        .slice(0, 1)
                        .toUpperCase()}
                    </span>
                    <div className="min-w-0 flex-1">
                      <p className="truncate text-[13px] font-medium text-fg">
                        {member.name ?? member.email ?? "Project member"}
                      </p>
                      <p className="truncate text-xs text-fg-faint">
                        {member.email ?? member.externalUserId}
                      </p>
                    </div>
                    {changed && (
                      <PendingButton
                        type="button"
                        pending={busy === member.externalUserId}
                        onClick={() => void saveMember(member)}
                        className="h-7 rounded-md bg-fg px-2.5 text-xs font-semibold text-bg"
                      >
                        Save
                      </PendingButton>
                    )}
                  </div>
                  <div className="mt-2 flex flex-wrap gap-1.5 pl-11">
                    {roles.map((role) => {
                      const active = selected.includes(role.slug);
                      return (
                        <button
                          key={role.slug}
                          type="button"
                          onClick={() =>
                            toggleRole(member.externalUserId, role.slug)
                          }
                          aria-pressed={active}
                          className={`rounded-full border px-2.5 py-1 text-[11px] font-medium ${
                            active
                              ? "border-accent/50 bg-accent/10 text-accent"
                              : "border-border text-fg-faint hover:text-fg-muted"
                          }`}
                        >
                          {role.definition?.name ?? role.slug}
                        </button>
                      );
                    })}
                  </div>
                </article>
              );
            })}
          </section>
          {error && (
            <p className="text-xs text-danger" role="alert">
              {error}
            </p>
          )}
        </div>

        <footer className="flex justify-end border-t border-border px-5 py-3.5">
          <button
            type="button"
            onClick={onClose}
            className="h-8 rounded-md px-3 text-[13px] text-fg-muted hover:bg-bg-overlay"
          >
            Done
          </button>
        </footer>
      </div>
    </Modal>
  );
}
