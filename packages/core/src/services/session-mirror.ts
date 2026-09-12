import type { DB, Json, JsonObject } from "@catamorphic/db";
import { type Kysely, type Selectable, sql } from "kysely";
import type { Identity } from "../identity.js";
import type {
  AgentSessionSource,
  AgentTodo,
} from "./agent-sessions-service.js";
import type {
  SessionDeliveryMode,
  SessionMessageAuthor,
} from "./agent-turns-service.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import type { ExecutionEnvironmentsService } from "./execution-environments-service.js";

/**
 * A mirror push found messages here the mirroring side doesn't know —
 * the session was continued on THIS backend, so the mirror source must
 * stop pushing (the conversation forked; this side owns it now).
 */
export class SessionMirrorDivergedError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Agent session '${sessionId}' was continued on this server; the mirror source must stop pushing`,
    );
    this.name = "SessionMirrorDivergedError";
  }
}

export type SessionMirrorInput = {
  title?: string | null;
  icon?: string | null;
  provider?: string;
  source?: AgentSessionSource;
  /**
   * The source session's PROJECT-agent slug, when it ran one: project
   * agent definitions are committed files that sync between backends,
   * so when this side has the same slug (and the caller's scope covers
   * it), the fork continues on the SAME agent instead of the default.
   */
  agentSlug?: string;
  todos: AgentTodo[];
  authority: { hostId: string; revision: number };
  messages: Array<{
    id: string;
    role: "user" | "assistant" | "system";
    content: string;
    metadata: Record<string, unknown> | null;
    author: SessionMessageAuthor;
    deliveryMode: SessionDeliveryMode;
    idempotencyKey: string | null;
    createdAt: string;
  }>;
};

/** Persist an admitted mirror atomically against local authority and transcript order. */
export async function writeSessionMirror({
  db,
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
  executionAllocations: ExecutionAllocationsService;
  identity: Identity;
  projectId: string;
  sessionId: string;
  input: SessionMirrorInput;
  agentId: string | null;
  mirrorAdmission?: Awaited<ReturnType<ExecutionEnvironmentsService["admit"]>>;
  mirrorConnections?: Awaited<ReturnType<ConnectionAdmissionService["admit"]>>;
}): Promise<Selectable<DB["agent_sessions"]>> {
  // One transaction: the divergence check, the session upsert, and
  // the appends must not interleave with a turn starting here (the
  // append order IS the transcript order, via `seq`).
  return db.transaction().execute(async (trx) => {
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
    ) {
      throw new AccessDeniedError();
    }
    if (
      current &&
      current.authority_host_id !== "unassigned" &&
      (current.authority_host_id !== input.authority.hostId ||
        Number(current.authority_revision) > input.authority.revision)
    ) {
      throw new SessionMirrorDivergedError(sessionId);
    }
    if (current && !current.allocation_id) {
      throw new Error("Agent session has no Environment Allocation");
    }
    const held = await trx
      .selectFrom("agent_messages")
      .select(["id"])
      .where("session_id", "=", sessionId)
      .forUpdate()
      .execute();
    const incomingIds = new Set(input.messages.map((m) => m.id));
    if (held.some((entry) => !incomingIds.has(entry.id))) {
      throw new SessionMirrorDivergedError(sessionId);
    }

    const allocation =
      !current && mirrorAdmission
        ? await executionAllocations.create({
            identity,
            projectId,
            environmentName: mirrorAdmission.environmentName,
            workloadKind: "agent",
            rootWorkloadId: sessionId,
            workerNodeId: mirrorAdmission.runtime.workerNodeId,
            policy: {
              binding: mirrorAdmission.binding,
              requirements: mirrorAdmission.effectiveRequirements,
              connections: mirrorConnections,
            },
            transaction: trx,
          })
        : undefined;
    const session = current
      ? await trx
          .updateTable("agent_sessions")
          .set({
            title: input.title ?? current.title,
            icon: input.icon ?? current.icon,
            todos: sql<Json>`${JSON.stringify(input.todos)}::jsonb`,
            updated_at: new Date(),
            authority_host_id: input.authority.hostId,
            authority_revision: input.authority.revision,
            authority_seen_at: new Date(),
            mirror_message_count: input.messages.length,
          })
          .where("id", "=", sessionId)
          .returningAll()
          .executeTakeFirstOrThrow()
      : await trx
          .insertInto("agent_sessions")
          .values({
            id: sessionId,
            project_id: projectId,
            external_user_id: identity.externalUserId,
            provider: input.provider ?? "mirror",
            source: input.source ?? "api",
            provider_session_id: null,
            agent_id: agentId,
            model: null,
            model_effort: null,
            system_prompt: null,
            sandbox_id: null,
            allocation_id: allocation!.id,
            environment_name: mirrorAdmission!.environmentName,
            status: "active",
            base_commit_sha: null,
            title: input.title ?? null,
            icon: input.icon ?? null,
            todos: sql<Json>`${JSON.stringify(input.todos)}::jsonb`,
            authority_host_id: input.authority.hostId,
            authority_revision: input.authority.revision,
            authority_seen_at: new Date(),
            mirror_message_count: input.messages.length,
          })
          .returningAll()
          .executeTakeFirstOrThrow();

    // `seq` is an identity column: transcript order IS insertion
    // order, so append the unseen messages in payload order, in one
    // statement (a mirror can carry hundreds of messages).
    const heldIds = new Set(held.map((entry) => entry.id));
    const fresh = input.messages
      .filter((message) => !heldIds.has(message.id))
      .map((message) => ({
        id: message.id,
        session_id: sessionId,
        role: message.role,
        content: message.content,
        metadata:
          message.metadata === null
            ? null
            : sql<JsonObject>`${JSON.stringify(message.metadata)}::jsonb`,
        author_kind: message.author.kind,
        author_payload: JSON.parse(JSON.stringify(message.author)),
        delivery_mode: message.deliveryMode,
        idempotency_key: message.idempotencyKey,
        commit_sha: null,
        created_at: new Date(message.createdAt),
      }));
    if (fresh.length > 0) {
      await trx.insertInto("agent_messages").values(fresh).execute();
    }
    return session;
  });
}
