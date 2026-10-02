import type {
  AgentTodo,
  SessionSnapshot,
  StoredSessionEvent,
} from "@catamorphic/agent-protocol";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import type { AgentSessionSource } from "./agent-sessions-service.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import {
  admissionPolicy,
  type ExecutionEnvironmentsService,
} from "./execution-environments-service.js";
import { SessionLogGapError, type SessionLog } from "./sessions/session-log.js";

/**
 * The session was continued on THIS backend: its authority moved here, so
 * the mirror source must stop pushing (the conversation forked; this side
 * owns it now).
 */
export class SessionMirrorDivergedError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Agent session '${sessionId}' was continued on this server; the mirror source must stop pushing`,
    );
    this.name = "SessionMirrorDivergedError";
  }
}

/**
 * The mirror's copy ends at `sequence`, not where the push began: the
 * source resends from there (or a base when this side has no copy).
 */
export class SessionMirrorBehindError extends Error {
  constructor(
    readonly sessionId: string,
    readonly sequence: number,
  ) {
    super(`The mirror of session '${sessionId}' is at event ${sequence}`);
    this.name = "SessionMirrorBehindError";
  }
}

/**
 * One mirror push (ADR 0196): the source's log after this copy's last
 * sequence, or, for a copy that does not exist yet, a full snapshot to
 * start from and the events after it.
 */
export type SessionMirrorInput = {
  authority: { hostId: string; revision: number };
  title?: string | null;
  icon?: string | null;
  source?: AgentSessionSource;
  /**
   * The source session's PROJECT-agent slug, when it ran one: project
   * agent definitions are committed files that sync between backends,
   * so when this side has the same slug (and the caller's scope covers
   * it), the copy continues on the SAME agent instead of the default.
   */
  agentSlug?: string;
  todos?: AgentTodo[];
  workStatus?: "open" | "completed";
  /** Every turn, item, request and thread at `base.sequence`, for a new copy. */
  base?: SessionSnapshot;
  events: StoredSessionEvent[];
  /** The source's workflow-facing session events, so automations here see them. */
  projectEvents?: Array<{
    id: string;
    kind: string;
    occurredAt: string;
    payload: JsonObject;
  }>;
};

/** Persist a mirror push atomically against local authority and the log. */
export async function writeSessionMirror({
  db,
  log,
  executionAllocations,
  identity,
  projectId,
  sessionId,
  input,
  agentId,
  mirrorAdmission,
  mirrorConnections,
}: {
  db: Kysely<DB>;
  log: SessionLog;
  executionAllocations: ExecutionAllocationsService;
  identity: Identity;
  projectId: string;
  sessionId: string;
  input: SessionMirrorInput;
  agentId: string | null;
  mirrorAdmission?: Awaited<ReturnType<ExecutionEnvironmentsService["admit"]>>;
  mirrorConnections?: Awaited<ReturnType<ConnectionAdmissionService["admit"]>>;
}): Promise<{ session: Selectable<DB["agent_sessions"]>; sequence: number }> {
  return db.transaction().execute(async (trx) => {
    // The source's history is not new activity here: no workflow fires on it.
    await sql`select set_config('catamorphic.suppress_session_events', 'true', true)`.execute(
      trx,
    );
    const current = await trx
      .selectFrom("agent_sessions")
      .selectAll()
      .where("id", "=", sessionId)
      .forUpdate()
      .executeTakeFirst();
    if (
      current &&
      (current.project_id !== projectId ||
        current.external_user_id !== identity.externalUserId)
    )
      throw new AccessDeniedError();
    if (
      current &&
      current.authority_host_id !== "unassigned" &&
      (current.authority_host_id !== input.authority.hostId ||
        Number(current.authority_revision) > input.authority.revision)
    )
      throw new SessionMirrorDivergedError(sessionId);
    if (!current && !input.base)
      throw new SessionMirrorBehindError(sessionId, 0);
    const allocation =
      !current && mirrorAdmission
        ? await executionAllocations.create({
            identity,
            projectId,
            environmentName: mirrorAdmission.environmentName,
            workloadKind: "agent",
            rootWorkloadId: sessionId,
            workerNodeId: mirrorAdmission.runtime.workerNodeId,
            policy: admissionPolicy({
              admission: mirrorAdmission,
              connections: mirrorConnections ?? [],
            }),
            transaction: trx,
          })
        : undefined;
    if (!current) {
      if (!allocation || !mirrorAdmission)
        throw new Error("A new mirror needs an admitted Environment");
      await trx
        .insertInto("agent_sessions")
        .values({
          id: sessionId,
          project_id: projectId,
          external_user_id: identity.externalUserId,
          source: input.source ?? "api",
          agent_id: agentId,
          model: null,
          model_effort: null,
          system_prompt: null,
          sandbox_id: null,
          allocation_id: allocation.id,
          environment_name: mirrorAdmission.environmentName,
          status: "active",
          base_commit_sha: null,
          title: input.title ?? null,
          icon: input.icon ?? null,
          work_status: input.workStatus ?? "open",
          todos: sql<Json>`${JSON.stringify(input.todos ?? [])}::jsonb`,
          authority_host_id: input.authority.hostId,
          authority_revision: input.authority.revision,
          authority_seen_at: new Date(),
        })
        .execute();
    }
    // The source's native threads live on its machine: the copy keeps them
    // for the turns that name them, as unavailable, so a turn here starts a
    // thread of its own and is handed the history (ADR 0197).
    const away = <T extends { status: string }>(thread: T): T => ({ ...thread, status: "unavailable" });
    if (input.base && (!current || Number(current.event_sequence) === 0)) {
      await log.importSnapshot(trx, {
        sessionId,
        snapshot: { ...input.base, providerThreads: input.base.providerThreads.map(away) },
      });
    }
    const events = input.events.map((stored) =>
      stored.event.type === "provider_thread.changed"
        ? { ...stored, event: { ...stored.event, thread: away(stored.event.thread) } }
        : stored,
    );
    let sequence: number;
    try {
      sequence = await log.replicate(trx, { sessionId, events });
    } catch (error) {
      if (error instanceof SessionLogGapError)
        throw new SessionMirrorBehindError(sessionId, error.expected - 1);
      throw error;
    }
    const session = await trx
      .updateTable("agent_sessions")
      .set({
        title: input.title ?? current?.title ?? null,
        icon: input.icon ?? current?.icon ?? null,
        ...(input.workStatus ? { work_status: input.workStatus } : {}),
        ...(input.todos
          ? { todos: sql<Json>`${JSON.stringify(input.todos)}::jsonb` }
          : {}),
        updated_at: new Date(),
        authority_host_id: input.authority.hostId,
        authority_revision: input.authority.revision,
        authority_seen_at: new Date(),
        mirror_sequence: sequence,
      })
      .where("id", "=", sessionId)
      .returningAll()
      .executeTakeFirstOrThrow();
    for (const event of input.projectEvents ?? []) {
      if (
        event.payload.sessionId !== sessionId ||
        !event.kind.startsWith("session.")
      )
        throw new AccessDeniedError();
      const snapshot = event.payload.session;
      await trx
        .insertInto("project_events")
        .values({
          id: event.id,
          project_id: projectId,
          source: "session",
          kind: event.kind,
          external_id: `${input.authority.hostId}:${event.id}`,
          occurred_at: new Date(event.occurredAt),
          payload: {
            ...event.payload,
            sessionId,
            externalUserId: identity.externalUserId,
            agentId: session.agent_id,
            session:
              snapshot && typeof snapshot === "object" && !Array.isArray(snapshot)
                ? { ...snapshot, id: sessionId }
                : {},
          },
        })
        .onConflict((conflict) => conflict.doNothing())
        .execute();
    }
    return { session, sequence };
  });
}
