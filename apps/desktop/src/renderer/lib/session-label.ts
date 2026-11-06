import type { AgentSession } from "@catamorphic/react/types";

export function sessionLabel(
  session: Pick<AgentSession, "title" | "createdAt">,
): string {
  if (session.title) return session.title;
  const created = new Date(session.createdAt);
  return `Chat ${created.toLocaleDateString()} ${created.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}`;
}
