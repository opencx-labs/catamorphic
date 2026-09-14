import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import type { SessionMessageAuthor } from "./agent-turns-service.js";
import type { WatchersService } from "./watchers-service.js";

const target = {
  sessionId: z.string().uuid(),
  expectedStateRevision: z.number().int().nonnegative().optional(),
};
const mutation = { ...target, idempotencyKey: z.string().min(1).max(300) };
export const SESSION_ACTION_SCHEMAS = {
  inspect: z.strictObject(target),
  list: z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
  history: z.strictObject({
    ...target,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  create: z.strictObject({
    ...mutation,
    agentId: z.string().optional(),
    title: z.string().max(500).optional(),
  }),
  fork: z.strictObject({
    ...mutation,
    messageId: z.string().uuid().optional(),
  }),
  spawn: z.strictObject({
    ...mutation,
    task: z.string().min(1),
    routeId: z.string().optional(),
    agentId: z.string().optional(),
    title: z.string().max(500).optional(),
    contextMode: z.enum(["fresh", "inherit"]).optional(),
  }),
  archive: z.strictObject({ ...mutation, confirmStop: z.boolean().optional() }),
  unarchive: z.strictObject(mutation),
  interrupt: z.strictObject(mutation),
  complete: z.strictObject({ ...mutation, content: z.string().min(1) }),
  reopen: z.strictObject(mutation),
  stopWatcher: z.strictObject({ ...mutation, watcherId: z.string().uuid() }),
};
export type SessionActionOperation = keyof typeof SESSION_ACTION_SCHEMAS;
const tracer = getTracer("@catamorphic/core");

/** Shared host operations. Transport adapters attach identity and actor, never author code. */
export class SessionActionsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly sessions: AgentSessionsService,
    private readonly watchers: () => WatchersService | undefined,
  ) {}

  async execute(input: {
    identity: Identity;
    projectId: string;
    operation: SessionActionOperation;
    args: unknown;
    author: SessionMessageAuthor;
    causation?: string[];
    provenance?: JsonObject;
  }): Promise<Json> {
    return withSpan(
      {
        tracer,
        name: `session.action.${input.operation}`,
        attributes: {
          "catamorphic.project.id": input.projectId,
          "catamorphic.session.action": input.operation,
        },
      },
      async () => {
        const args = SESSION_ACTION_SCHEMAS[input.operation].parse(input.args);
        if (input.operation === "list")
          return json(
            await this.sessions.list(input.identity, input.projectId, {
              limit: "limit" in args ? args.limit : 100,
            }),
          );
        if (!("sessionId" in args)) throw new Error("sessionId is required");
        const detail = await this.sessions.get(
          input.identity,
          input.projectId,
          args.sessionId,
        );
        const session = detail;
        if (input.operation === "inspect") return json(session);
        if (input.operation === "history")
          return json({
            sessionId: session.id,
            messages: session.messages.slice(
              -("limit" in args ? (args.limit ?? 30) : 30),
            ),
          });
        if (!("idempotencyKey" in args))
          throw new Error("idempotencyKey is required");
        const key = JSON.stringify([input.author, args.idempotencyKey]);
        const accepted = await this.db
          .insertInto("session_actions")
          .values({
            project_id: input.projectId,
            session_id: args.sessionId,
            operation: input.operation,
            target_turn_id:
              input.operation === "interrupt"
                ? this.db
                    .selectFrom("agent_turns")
                    .select("id")
                    .where("session_id", "=", args.sessionId)
                    .where("status", "=", "running")
                    .limit(1)
                : null,
            actor: json({
              ...input.author,
              causation: input.causation ?? [],
              provenance: input.provenance ?? {},
            }),
            input: json(args),
            idempotency_key: key,
          })
          .onConflict((conflict) =>
            conflict.columns(["project_id", "idempotency_key"]).doNothing(),
          )
          .returningAll()
          .executeTakeFirst();
        const action =
          accepted ??
          (await this.db
            .selectFrom("session_actions")
            .selectAll()
            .where("project_id", "=", input.projectId)
            .where("idempotency_key", "=", key)
            .executeTakeFirstOrThrow());
        if (
          action.operation !== input.operation ||
          JSON.stringify(action.input) !== JSON.stringify(json(args))
        ) {
          // Compare JSON semantically below: jsonb property order is not source order.
          if (
            action.operation !== input.operation ||
            canonical(action.input) !== canonical(json(args))
          )
            throw new Error(
              "This idempotency key was already used for another action",
            );
        }
        if (action.status === "completed") return action.result;
        if (
          "expectedStateRevision" in args &&
          args.expectedStateRevision !== undefined &&
          args.expectedStateRevision !== session.stateRevision
        )
          throw new Error(
            "Session state changed; inspect it before retrying this action",
          );
        if (
          session.authorityHostId !== this.sessions.hostId &&
          session.authorityHostId !== "unassigned"
        ) {
          const receipt = await this.sessions.mailboxes.enqueue(
            input.identity,
            input.projectId,
            args.sessionId,
            {
              destination: {
                hostId: session.authorityHostId,
                revision: session.authorityRevision,
              },
              author: input.author,
              content: actionLabel(input.operation),
              mode: "message_only",
              idempotencyKey: `action:${action.id}`,
              metadata: {
                sessionAction: {
                  operation: input.operation,
                  args: json(args),
                  causation: input.causation ?? [],
                  provenance: input.provenance ?? {},
                },
              },
            },
          );
          return json({ delivery: "queued", ...receipt });
        }
        const leaseOwner = randomUUID();
        const claim = await this.db
          .updateTable("session_actions")
          .set({
            status: "running",
            lease_owner: leaseOwner,
            lease_expires_at: new Date(Date.now() + 120_000),
            updated_at: new Date(),
          })
          .where("id", "=", action.id)
          .where(({ or, eb }) =>
            or([
              eb("status", "in", ["pending", "failed"]),
              eb("lease_expires_at", "<=", new Date()),
            ]),
          )
          .returning("id")
          .executeTakeFirst();
        if (!claim)
          throw new Error(
            "Session action is already running; retry with the same idempotency key",
          );
        const renewal = setInterval(() => {
          void this.db
            .updateTable("session_actions")
            .set({ lease_expires_at: new Date(Date.now() + 120_000) })
            .where("id", "=", action.id)
            .where("status", "=", "running")
            .where("lease_owner", "=", leaseOwner)
            .execute()
            .catch(() => {});
        }, 30_000);
        try {
          const sourceActionId = `action:${action.id}`;
          let result: unknown;
          switch (input.operation) {
            case "create":
              result = await this.sessions.create(
                input.identity,
                input.projectId,
                {
                  ...SESSION_ACTION_SCHEMAS.create.parse(args),
                  sourceActionId,
                },
              );
              break;
            case "fork":
              result = await this.sessions.fork(
                input.identity,
                input.projectId,
                args.sessionId,
                { ...SESSION_ACTION_SCHEMAS.fork.parse(args), sourceActionId },
              );
              break;
            case "spawn":
              result = await this.sessions.createSubsession(
                input.identity,
                input.projectId,
                args.sessionId,
                {
                  ...SESSION_ACTION_SCHEMAS.spawn.parse(args),
                  sourceActionId,
                  origin: input,
                },
              );
              break;
            case "archive":
              result = await this.sessions.archive(
                input.identity,
                input.projectId,
                args.sessionId,
                {
                  ...SESSION_ACTION_SCHEMAS.archive.parse(args),
                  origin: input,
                },
              );
              break;
            case "unarchive":
              result = await this.sessions.unarchive(
                input.identity,
                input.projectId,
                args.sessionId,
                { origin: input },
              );
              break;
            case "interrupt":
              if (action.target_turn_id)
                await this.sessions.interrupt(
                  input.identity,
                  input.projectId,
                  args.sessionId,
                  { expectedTurnId: action.target_turn_id },
                );
              result = { interrupted: action.target_turn_id !== null };
              break;
            case "stopWatcher":
              result = {
                stopped: await this.watchers()?.stop({
                  identity: input.identity,
                  projectId: input.projectId,
                  sessionId: args.sessionId,
                  watcherId:
                    SESSION_ACTION_SCHEMAS.stopWatcher.parse(args).watcherId,
                }),
              };
              break;
            default:
              result = { sessionId: args.sessionId };
              break;
          }
          const content =
            "content" in args && typeof args.content === "string"
              ? args.content
              : actionLabel(input.operation);
          await this.db.transaction().execute(async (trx) => {
            const owned = await trx
              .selectFrom("session_actions")
              .select("id")
              .where("id", "=", action.id)
              .where("status", "=", "running")
              .where("lease_owner", "=", leaseOwner)
              .forUpdate()
              .executeTakeFirst();
            if (!owned) throw new Error("Session action lease was replaced");
            await sql`select set_config('catamorphic.session_actor', ${JSON.stringify({ ...input.author, causation: input.causation ?? [] })}, true)`.execute(
              trx,
            );
            if (
              input.operation === "complete" ||
              input.operation === "reopen"
            ) {
              const current = await trx
                .selectFrom("agent_sessions")
                .select("state_revision")
                .where("id", "=", args.sessionId)
                .forUpdate()
                .executeTakeFirstOrThrow();
              if (
                args.expectedStateRevision !== undefined &&
                Number(current.state_revision) !== args.expectedStateRevision
              )
                throw new Error(
                  "Session state changed; inspect it before retrying this action",
                );
            }
            if (input.operation === "complete" || input.operation === "reopen")
              await trx
                .updateTable("agent_sessions")
                .set({
                  work_status:
                    input.operation === "complete" ? "completed" : "open",
                  updated_at: new Date(),
                })
                .where("id", "=", args.sessionId)
                .execute();
            await this.sessions.turns.deliver({
              sessionId: args.sessionId,
              content,
              author: input.author,
              mode: "message_only",
              idempotencyKey: sourceActionId,
              metadata: {
                sessionAction: {
                  id: action.id,
                  operation: input.operation,
                  status: "completed",
                  result: json(result),
                },
                causation: input.causation ?? [],
                provenance: input.provenance ?? {},
              },
              transaction: trx,
            });
            await trx
              .updateTable("session_actions")
              .set({
                status: "completed",
                result: json(result),
                error: null,
                lease_expires_at: null,
                lease_owner: null,
                updated_at: new Date(),
              })
              .where("id", "=", action.id)
              .execute();
          });
          return json(result);
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.db.transaction().execute(async (trx) => {
            const failed = await trx
              .updateTable("session_actions")
              .set({
                status: "failed",
                error: message,
                lease_expires_at: null,
                lease_owner: null,
                updated_at: new Date(),
              })
              .where("id", "=", action.id)
              .where("status", "=", "running")
              .where("lease_owner", "=", leaseOwner)
              .returning("id")
              .executeTakeFirst();
            if (!failed) return;
            await this.sessions.turns.deliver({
              sessionId: args.sessionId,
              content: `${actionLabel(input.operation)} failed: ${message}`,
              author: input.author,
              mode: "message_only",
              idempotencyKey: `action:${action.id}:failure`,
              metadata: {
                sessionAction: {
                  id: action.id,
                  operation: input.operation,
                  status: "failed",
                },
                causation: input.causation ?? [],
                provenance: input.provenance ?? {},
              },
              transaction: trx,
            });
          });
          throw error;
        } finally {
          clearInterval(renewal);
        }
      },
    );
  }
}
function actionLabel(operation: SessionActionOperation): string {
  return {
    inspect: "Inspected this session",
    list: "Listed sessions",
    history: "Read session history",
    create: "Created a session",
    fork: "Forked this session",
    spawn: "Created a child session",
    archive: "Archived this session",
    unarchive: "Unarchived this session",
    interrupt: "Interrupted this session",
    complete: "Marked work finished",
    reopen: "Reopened the work",
    stopWatcher: "Stopped a watcher",
  }[operation];
}
function json(value: unknown): Json {
  return JSON.parse(JSON.stringify(value ?? null));
}
function canonical(value: Json): string {
  if (Array.isArray(value)) return JSON.stringify(value.map(canonical));
  if (value && typeof value === "object")
    return JSON.stringify(
      Object.keys(value)
        .sort()
        .map((key) => [key, canonical(value[key] ?? null)]),
    );
  return JSON.stringify(value);
}
