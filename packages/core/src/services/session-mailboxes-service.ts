import { randomUUID } from "node:crypto";
import type { DB, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import {
  parseSessionMessageAuthor,
  type SessionDeliveryMode,
  type SessionDeliveryReceipt,
  type SessionMessageAuthor,
} from "./agent-turns-service.js";
import { requireTenantProject } from "./projects-service.js";

type MailboxRow = Selectable<DB["session_mailbox_items"]>;

export interface SessionAuthority {
  hostId: string;
  revision: number;
}

export interface SessionMailboxItem {
  id: string;
  projectId: string;
  sessionId: string;
  sourceHostId: string;
  destinationHostId: string;
  authorityRevision: number;
  messageId: string;
  content: string;
  author: SessionMessageAuthor;
  mode: SessionDeliveryMode;
  idempotencyKey: string | null;
  metadata: JsonObject | null;
  createdAt: string;
}

export class SessionAuthorityMismatchError extends Error {
  constructor(readonly sessionId: string) {
    super(
      `Session '${sessionId}' authority changed; refresh before delivering`,
    );
    this.name = "SessionAuthorityMismatchError";
  }
}

export class SessionMailboxNotFoundError extends Error {
  constructor(readonly mailboxId: string) {
    super(`Session mailbox item '${mailboxId}' not found`);
    this.name = "SessionMailboxNotFoundError";
  }
}

const tracer = getTracer("@catamorphic/core");

/** Durable cross-host delivery outbox. Only the authority host may import it. */
export class SessionMailboxesService {
  constructor(
    private readonly db: Kysely<DB>,
    readonly hostId: string,
  ) {}

  async enqueue(
    identity: Identity,
    projectId: string,
    sessionId: string,
    input: {
      destination: SessionAuthority;
      content: string;
      author: SessionMessageAuthor;
      mode: SessionDeliveryMode;
      idempotencyKey?: string;
      metadata?: JsonObject;
    },
  ): Promise<SessionDeliveryReceipt> {
    return withSpan(
      {
        tracer,
        name: "agent.session.mailbox.enqueue",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.agent.session.id": sessionId,
          "catamorphic.agent.delivery.mode": input.mode,
        },
      },
      async () => {
        await requireTenantProject(this.db, identity.tenantId, projectId);
        const session = await this.db
          .selectFrom("agent_sessions")
          .selectAll()
          .where("id", "=", sessionId)
          .where("project_id", "=", projectId)
          .executeTakeFirst();
        if (!session) throw new SessionAuthorityMismatchError(sessionId);
        assertAgentSessionAccess({
          identity,
          projectId,
          externalUserId: session.external_user_id,
          agentId: session.agent_id,
        });
        if (
          session.authority_host_id !== input.destination.hostId ||
          Number(session.authority_revision) !== input.destination.revision
        ) {
          throw new SessionAuthorityMismatchError(sessionId);
        }

        const messageId = randomUUID();
        const inserted = await this.db
          .insertInto("session_mailbox_items")
          .values({
            project_id: projectId,
            session_id: sessionId,
            source_host_id: this.hostId,
            destination_host_id: input.destination.hostId,
            authority_revision: input.destination.revision,
            message_id: messageId,
            content: input.content,
            author_kind: input.author.kind,
            author_payload: JSON.parse(JSON.stringify(input.author)),
            delivery_mode: input.mode,
            idempotency_key: input.idempotencyKey ?? null,
            metadata: input.metadata ?? null,
          })
          .onConflict((conflict) =>
            conflict
              .columns(["session_id", "idempotency_key"])
              .where("idempotency_key", "is not", null)
              .doNothing(),
          )
          .returning(["message_id"])
          .executeTakeFirst();
        if (inserted) {
          return {
            messageId: inserted.message_id,
            turnId: null,
            mode: input.mode,
            created: true,
          };
        }
        const existing = await this.db
          .selectFrom("session_mailbox_items")
          .select("message_id")
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", input.idempotencyKey ?? "")
          .executeTakeFirstOrThrow();
        return {
          messageId: existing.message_id,
          turnId: null,
          mode: input.mode,
          created: false,
        };
      },
    );
  }

  async list(
    identity: Identity,
    projectId: string,
    input: { destinationHostId: string; limit?: number },
  ): Promise<SessionMailboxItem[]> {
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const rows = await this.db
      .selectFrom("session_mailbox_items")
      .innerJoin(
        "agent_sessions",
        "agent_sessions.id",
        "session_mailbox_items.session_id",
      )
      .selectAll("session_mailbox_items")
      .where("session_mailbox_items.project_id", "=", projectId)
      .where(
        "session_mailbox_items.destination_host_id",
        "=",
        input.destinationHostId,
      )
      .where("session_mailbox_items.status", "=", "pending")
      .where("agent_sessions.external_user_id", "=", identity.externalUserId)
      .whereRef(
        "agent_sessions.authority_host_id",
        "=",
        "session_mailbox_items.destination_host_id",
      )
      .whereRef(
        "agent_sessions.authority_revision",
        "=",
        "session_mailbox_items.authority_revision",
      )
      .orderBy("session_mailbox_items.created_at", "asc")
      .limit(input.limit ?? 100)
      .execute();
    return rows.map(mapMailboxItem);
  }

  async acknowledge(
    identity: Identity,
    projectId: string,
    mailboxId: string,
    input: { destinationHostId: string },
  ): Promise<void> {
    await requireTenantProject(this.db, identity.tenantId, projectId);
    const result = await this.db
      .updateTable("session_mailbox_items")
      .set({ status: "acknowledged", acknowledged_at: new Date() })
      .where("id", "=", mailboxId)
      .where("project_id", "=", projectId)
      .where("destination_host_id", "=", input.destinationHostId)
      .where("session_id", "in", (query) =>
        query
          .selectFrom("agent_sessions")
          .select("id")
          .where("external_user_id", "=", identity.externalUserId),
      )
      .executeTakeFirst();
    if (result.numUpdatedRows === 0n) {
      throw new SessionMailboxNotFoundError(mailboxId);
    }
  }
}

function mapMailboxItem(row: MailboxRow): SessionMailboxItem {
  return {
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sourceHostId: row.source_host_id,
    destinationHostId: row.destination_host_id,
    authorityRevision: Number(row.authority_revision),
    messageId: row.message_id,
    content: row.content,
    author: parseSessionMessageAuthor(row.author_kind, row.author_payload),
    mode: parseMode(row.delivery_mode),
    idempotencyKey: row.idempotency_key,
    metadata: row.metadata as JsonObject | null,
    createdAt: row.created_at.toISOString(),
  };
}

function parseMode(value: string): SessionDeliveryMode {
  if (
    value === "message_only" ||
    value === "next_turn" ||
    value === "interrupt"
  ) {
    return value;
  }
  throw new Error(`Invalid session mailbox delivery mode '${value}'`);
}
