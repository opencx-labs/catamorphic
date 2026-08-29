import { createHash } from "node:crypto";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";

export interface PushSubscriptionInput {
  endpoint: string;
  expirationTime: number | null;
  keys: { p256dh: string; auth: string };
  userAgent?: string;
}

export interface PushNotificationTransport {
  publicKey: string;
  send(args: {
    subscription: {
      endpoint: string;
      expirationTime: number | null;
      keys: { p256dh: string; auth: string };
    };
    payload: string;
  }): Promise<"delivered" | "retired">;
}

export interface NotificationDelivery {
  eventId: string;
  subscriptionId: string;
  payload: string;
  subscription: {
    endpoint: string;
    expirationTime: number | null;
    keys: { p256dh: string; auth: string };
  };
}

/** Durable user notification events and per-device Web Push deliveries. */
export class UserNotificationsService {
  constructor(
    private readonly db: Kysely<DB>,
    readonly transport?: PushNotificationTransport,
  ) {}

  get pushConfig(): { enabled: boolean; publicKey: string | null } {
    return {
      enabled: Boolean(this.transport),
      publicKey: this.transport?.publicKey ?? null,
    };
  }

  async subscribe(
    identity: Identity,
    input: PushSubscriptionInput,
  ): Promise<void> {
    const now = new Date();
    await this.db
      .insertInto("push_subscriptions")
      .values({
        tenant_id: identity.tenantId,
        external_user_id: identity.externalUserId,
        endpoint_hash: endpointHash(input.endpoint),
        endpoint: input.endpoint,
        p256dh: input.keys.p256dh,
        auth_secret: input.keys.auth,
        user_agent: input.userAgent ?? null,
        expires_at:
          input.expirationTime === null ? null : new Date(input.expirationTime),
      })
      .onConflict((conflict) =>
        conflict
          .columns(["tenant_id", "external_user_id", "endpoint_hash"])
          .doUpdateSet({
            endpoint: input.endpoint,
            p256dh: input.keys.p256dh,
            auth_secret: input.keys.auth,
            user_agent: input.userAgent ?? null,
            expires_at:
              input.expirationTime === null
                ? null
                : new Date(input.expirationTime),
            retired_at: null,
            updated_at: now,
          }),
      )
      .execute();
  }

  async unsubscribe(identity: Identity, endpoint: string): Promise<void> {
    await this.db
      .updateTable("push_subscriptions")
      .set({ retired_at: new Date(), updated_at: new Date() })
      .where("tenant_id", "=", identity.tenantId)
      .where("external_user_id", "=", identity.externalUserId)
      .where("endpoint_hash", "=", endpointHash(endpoint))
      .execute();
  }

  async publish(args: {
    identity: Identity;
    kind: string;
    title: string;
    body: string;
    route: string;
    collapseKey: string;
    projectId?: string;
    sessionId?: string;
  }): Promise<void> {
    await this.db.transaction().execute(async (transaction) => {
      const subscriptions = await transaction
        .selectFrom("push_subscriptions")
        .select("id")
        .where("tenant_id", "=", args.identity.tenantId)
        .where("external_user_id", "=", args.identity.externalUserId)
        .where("retired_at", "is", null)
        .execute();
      if (subscriptions.length === 0) return;
      const inserted = await transaction
        .insertInto("user_notification_events")
        .values({
          tenant_id: args.identity.tenantId,
          external_user_id: args.identity.externalUserId,
          project_id: args.projectId ?? null,
          session_id: args.sessionId ?? null,
          kind: args.kind,
          title: args.title,
          body: args.body,
          route: args.route,
          collapse_key: args.collapseKey,
        })
        .onConflict((conflict) =>
          conflict
            .columns(["tenant_id", "external_user_id", "collapse_key"])
            .doNothing(),
        )
        .returning("id")
        .executeTakeFirst();
      const event =
        inserted ??
        (await transaction
          .selectFrom("user_notification_events")
          .select("id")
          .where("tenant_id", "=", args.identity.tenantId)
          .where("external_user_id", "=", args.identity.externalUserId)
          .where("collapse_key", "=", args.collapseKey)
          .executeTakeFirstOrThrow());
      await transaction
        .insertInto("notification_deliveries")
        .values(
          subscriptions.map((subscription) => ({
            event_id: event.id,
            subscription_id: subscription.id,
          })),
        )
        .onConflict((conflict) => conflict.doNothing())
        .execute();
    });
  }

  /** Emit one collapsed alert when mirrored sessions lose their source lease. */
  async publishPausedSessions(args: {
    authorityHostId: string;
    authorityLeaseMs?: number;
  }): Promise<number> {
    const authorityLeaseMs = args.authorityLeaseMs ?? 90_000;
    const paused = await this.db
      .selectFrom("agent_sessions")
      .innerJoin("projects", "projects.id", "agent_sessions.project_id")
      .select([
        "projects.tenant_id",
        "agent_sessions.external_user_id",
        "agent_sessions.id",
        "agent_sessions.project_id",
        "agent_sessions.authority_host_id",
        "agent_sessions.authority_revision",
      ])
      .where("agent_sessions.status", "=", "active")
      .where("agent_sessions.mirror_message_count", ">", 0)
      .where("agent_sessions.handoff_status", "=", "none")
      .where("agent_sessions.authority_host_id", "!=", "unassigned")
      .where("agent_sessions.authority_host_id", "!=", args.authorityHostId)
      .where(
        "agent_sessions.authority_seen_at",
        "<=",
        new Date(Date.now() - authorityLeaseMs),
      )
      .execute();
    const groups = new Map<
      string,
      {
        identity: Identity;
        projectId: string;
        sessionWatermarks: string[];
        count: number;
      }
    >();
    for (const row of paused) {
      const key = `${row.tenant_id}:${row.external_user_id}:${row.project_id}`;
      const current = groups.get(key);
      groups.set(key, {
        identity: {
          tenantId: row.tenant_id,
          externalUserId: row.external_user_id,
        },
        projectId: row.project_id,
        sessionWatermarks: [
          ...(current?.sessionWatermarks ?? []),
          `${row.id}:${row.authority_revision}`,
        ],
        count: (current?.count ?? 0) + 1,
      });
    }
    for (const group of groups.values()) {
      await this.publish({
        identity: group.identity,
        projectId: group.projectId,
        kind: "sessions_paused",
        title: group.count === 1 ? "A session paused" : "Some sessions paused",
        body:
          group.count === 1
            ? "Open your chats to resume it here."
            : "Open your chats to resume them here.",
        route: `/?project=${encodeURIComponent(group.projectId)}`,
        collapseKey: `sessions-paused:${group.projectId}:${endpointHash(
          group.sessionWatermarks.sort().join("|"),
        ).slice(0, 20)}`,
      });
    }
    return groups.size;
  }

  async claimDue(args: {
    workerId: string;
    limit?: number;
    leaseMs?: number;
  }): Promise<NotificationDelivery[]> {
    const now = new Date();
    return this.db.transaction().execute(async (transaction) => {
      const rows = await transaction
        .selectFrom("notification_deliveries")
        .innerJoin(
          "user_notification_events",
          "user_notification_events.id",
          "notification_deliveries.event_id",
        )
        .innerJoin(
          "push_subscriptions",
          "push_subscriptions.id",
          "notification_deliveries.subscription_id",
        )
        .select([
          "notification_deliveries.event_id",
          "notification_deliveries.subscription_id",
          "user_notification_events.kind",
          "user_notification_events.title",
          "user_notification_events.body",
          "user_notification_events.route",
          "user_notification_events.collapse_key",
          "push_subscriptions.endpoint",
          "push_subscriptions.p256dh",
          "push_subscriptions.auth_secret",
          "push_subscriptions.expires_at",
        ])
        .where("push_subscriptions.retired_at", "is", null)
        .where((expression) =>
          expression.or([
            expression.and([
              expression("notification_deliveries.status", "=", "pending"),
              expression("notification_deliveries.next_attempt_at", "<=", now),
            ]),
            expression.and([
              expression("notification_deliveries.status", "=", "leased"),
              expression("notification_deliveries.lease_expires_at", "<=", now),
            ]),
          ]),
        )
        .orderBy("notification_deliveries.next_attempt_at")
        .limit(args.limit ?? 25)
        .forUpdate("notification_deliveries")
        .skipLocked()
        .execute();
      if (rows.length === 0) return [];
      for (const row of rows) {
        await transaction
          .updateTable("notification_deliveries")
          .set({
            status: "leased",
            lease_owner: args.workerId,
            lease_expires_at: new Date(
              now.getTime() + (args.leaseMs ?? 30_000),
            ),
            attempt_count: (eb) => eb("attempt_count", "+", 1),
            updated_at: now,
          })
          .where("event_id", "=", row.event_id)
          .where("subscription_id", "=", row.subscription_id)
          .execute();
      }
      return rows.map((row) => ({
        eventId: row.event_id,
        subscriptionId: row.subscription_id,
        payload: JSON.stringify({
          kind: row.kind,
          title: row.title,
          body: row.body,
          route: row.route,
          tag: row.collapse_key,
        }),
        subscription: {
          endpoint: row.endpoint,
          expirationTime: row.expires_at?.getTime() ?? null,
          keys: { p256dh: row.p256dh, auth: row.auth_secret },
        },
      }));
    });
  }

  async settle(args: {
    workerId: string;
    eventId: string;
    subscriptionId: string;
    result: "delivered" | "retired" | "retry";
    error?: string;
  }): Promise<void> {
    const nextAttemptAt = new Date(Date.now() + 30_000);
    await this.db.transaction().execute(async (transaction) => {
      const delivery = await transaction
        .updateTable("notification_deliveries")
        .set({
          status: args.result === "retry" ? "pending" : args.result,
          delivered_at: args.result === "delivered" ? new Date() : null,
          next_attempt_at: nextAttemptAt,
          lease_owner: null,
          lease_expires_at: null,
          last_error: args.error ?? null,
          updated_at: new Date(),
        })
        .where("event_id", "=", args.eventId)
        .where("subscription_id", "=", args.subscriptionId)
        .where("status", "=", "leased")
        .where("lease_owner", "=", args.workerId)
        .returning("subscription_id")
        .executeTakeFirst();
      if (!delivery) return;
      if (args.result === "retired") {
        await transaction
          .updateTable("push_subscriptions")
          .set({ retired_at: new Date(), updated_at: new Date() })
          .where("id", "=", delivery.subscription_id)
          .execute();
      }
    });
  }

  async drain(workerId: string): Promise<number> {
    if (!this.transport) return 0;
    const deliveries = await this.claimDue({ workerId });
    await Promise.all(
      deliveries.map(async (delivery) => {
        try {
          const result = await this.transport?.send({
            subscription: delivery.subscription,
            payload: delivery.payload,
          });
          await this.settle({
            workerId,
            eventId: delivery.eventId,
            subscriptionId: delivery.subscriptionId,
            result: result ?? "retry",
          });
        } catch (error) {
          await this.settle({
            workerId,
            eventId: delivery.eventId,
            subscriptionId: delivery.subscriptionId,
            result: "retry",
            error: error instanceof Error ? error.message : String(error),
          });
        }
      }),
    );
    return deliveries.length;
  }
}

function endpointHash(endpoint: string): string {
  return createHash("sha256").update(endpoint).digest("hex");
}
