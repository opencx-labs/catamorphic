import { randomUUID } from "node:crypto";
import {
  type DispatchMode,
  dispatchModeSchema,
  type JsonValue,
  type SessionInput,
  type SessionMessageAuthor,
  sessionInputSchema,
  sessionMessageAuthorSchema,
} from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import { assertAgentSessionAccess } from "./agent-session-access.js";
import type { SessionDeliveryReceipt } from "./agent-sessions-service.js";
import { requireTenantProject } from "./projects-service.js";
import { jsonColumn, toJson } from "./run-coordinator.js";

type MailboxRow = Selectable<DB["session_mailbox_items"]>;

export interface SessionAuthority {
  hostId: string;
  revision: number;
}

/** A session action taken on another host, for the session's authority to run. */
export interface ForwardedSessionAction {
  operation: string;
  args: JsonValue;
  /** Who took it. */
  actor: SessionMessageAuthor;
}

/** What crosses to the session's authority (ADR 0219): an input, or an action. */
export type SessionMailboxDelivery =
  | {
      kind: "input";
      /** What the delivery becomes in the session (ADR 0217). */
      input: SessionInput;
      mode: DispatchMode;
      attention: boolean;
      /** The member whose call delivered it. */
      deliveredBy: string | null;
      /**
       * Whether the chat's owner wrote it, as the sending host found: the
       * authority runs a turn on the owner's own machine only for that
       * (ADR 0199).
       */
      ownerAuthored: boolean;
    }
  | { kind: "action"; action: ForwardedSessionAction };

export type SessionMailboxItem = SessionMailboxDelivery & {
  id: string;
  projectId: string;
  sessionId: string;
  sourceHostId: string;
  destinationHostId: string;
  authorityRevision: number;
  messageId: string;
  idempotencyKey: string | null;
  /** The enablements whose runs led to it, oldest first (ADR 0090). */
  causation: string[];
  createdAt: string;
};

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
      delivery: SessionMailboxDelivery;
      idempotencyKey?: string;
      causation?: string[];
    },
  ): Promise<SessionDeliveryReceipt> {
    const { delivery } = input;
    // An action runs on the authority and starts nothing.
    const mode = delivery.kind === "input" ? delivery.mode : "message_only";
    return withSpan(
      {
        tracer,
        name: "agent.session.mailbox.enqueue",
        attributes: {
          "catamorphic.project.id": projectId,
          "catamorphic.agent.session.id": sessionId,
          "catamorphic.agent.delivery.mode": mode,
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
          intent: "change",
        });
        if (
          session.authority_host_id !== input.destination.hostId ||
          Number(session.authority_revision) !== input.destination.revision
        ) {
          throw new SessionAuthorityMismatchError(sessionId);
        }

        const itemId = randomUUID();
        const inserted = await this.db
          .insertInto("session_mailbox_items")
          .values({
            project_id: projectId,
            session_id: sessionId,
            source_host_id: this.hostId,
            destination_host_id: input.destination.hostId,
            authority_revision: input.destination.revision,
            item_id: itemId,
            kind: delivery.kind,
            idempotency_key: input.idempotencyKey ?? null,
            causation: jsonColumn(input.causation ?? []),
            ...(delivery.kind === "input"
              ? {
                  input: jsonColumn(toJson(delivery.input)),
                  delivery_mode: delivery.mode,
                  attention: delivery.attention,
                  delivered_by: delivery.deliveredBy,
                  owner_authored: delivery.ownerAuthored,
                }
              : { action: jsonColumn(toJson(delivery.action)) }),
          })
          .onConflict((conflict) =>
            conflict
              .columns(["session_id", "idempotency_key"])
              .where("idempotency_key", "is not", null)
              .doNothing(),
          )
          .returning(["item_id"])
          .executeTakeFirst();
        if (inserted) {
          return {
            messageId: inserted.item_id,
            turnId: null,
            mode,
            created: true,
          };
        }
        const existing = await this.db
          .selectFrom("session_mailbox_items")
          .select("item_id")
          .where("session_id", "=", sessionId)
          .where("idempotency_key", "=", input.idempotencyKey ?? "")
          .executeTakeFirstOrThrow();
        return {
          messageId: existing.item_id,
          turnId: null,
          mode,
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
    // A delivery this host cannot read waits; it never holds up the rest.
    return rows.flatMap((row) => {
      const item = mapMailboxItem(row);
      if (!item)
        console.warn(
          `[catamorphic] Mailbox item ${row.id} carries no input this host can read`,
        );
      return item ? [item] : [];
    });
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

const forwardedActionSchema = z.object({
  operation: z.string(),
  args: z.json(),
  actor: sessionMessageAuthorSchema,
});

function mapMailboxItem(row: MailboxRow): SessionMailboxItem | null {
  const delivery = deliveryOf(row);
  if (!delivery) return null;
  return {
    ...delivery,
    id: row.id,
    projectId: row.project_id,
    sessionId: row.session_id,
    sourceHostId: row.source_host_id,
    destinationHostId: row.destination_host_id,
    authorityRevision: Number(row.authority_revision),
    messageId: row.item_id,
    idempotencyKey: row.idempotency_key,
    causation: z.array(z.string()).catch([]).parse(row.causation),
    createdAt: row.created_at.toISOString(),
  };
}

function deliveryOf(row: MailboxRow): SessionMailboxDelivery | null {
  if (row.kind === "action") {
    const action = forwardedActionSchema.safeParse(row.action);
    return action.success ? { kind: "action", action: action.data } : null;
  }
  const input = sessionInputSchema.safeParse(row.input);
  const mode = dispatchModeSchema.safeParse(row.delivery_mode);
  if (!input.success || !mode.success) return null;
  return {
    kind: "input",
    input: input.data,
    mode: mode.data,
    attention: row.attention,
    deliveredBy: row.delivered_by,
    ownerAuthored: row.owner_authored,
  };
}
