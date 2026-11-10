import type { AgentSession } from "@catamorphic/react/types";

type SessionIdentity = Pick<AgentSession, "id" | "title" | "icon">;

/** Open chats retain their identity beyond the recent page. Row-only fields
 * (attention, visibility) still come from the fresh list/attention response. */
export function sessionPresentations<T extends SessionIdentity>(
  recent: readonly T[],
  attention: readonly T[],
  open: readonly T[],
  followedIds: ReadonlySet<string>,
): Map<string, T> {
  const rows = new Map(
    [...recent, ...attention].map((session) => [session.id, session]),
  );
  for (const session of open) {
    const row = rows.get(session.id);
    if (!row) rows.set(session.id, session);
    // Partial rename events omit updatedAt, so its snapshot timestamp
    // cannot order live identity changes. Dormant selectors yield to the
    // row refreshed by change hints/polling; followed ones use their stream.
    else if (followedIds.has(session.id))
      rows.set(session.id, {
        ...row,
        title: session.title,
        icon: session.icon,
      });
  }
  return rows;
}

export function sessionLabel(
  session: Pick<AgentSession, "title" | "createdAt">,
): string {
  if (session.title) return session.title;
  const created = new Date(session.createdAt);
  return `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
