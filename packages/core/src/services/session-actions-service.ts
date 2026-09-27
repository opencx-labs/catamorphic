import { randomUUID } from "node:crypto";
import type { DB, Json, JsonObject } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import { type Kysely, sql } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import type { AgentSessionsService } from "./agent-sessions-service.js";
import type { SessionMessageAuthor } from "./agent-turns-service.js";
import {
  ChatAudienceSchema,
  ChatKeySchema,
  keyedChatOwnerId,
} from "./chat-delivery.js";
import type { WatchersService } from "./watchers-service.js";

/**
 * A chat by `sessionId`, or by the project's `key` for it (ADR 0173):
 * the caller's own keyed chat, the project chat with `audience: "project"`
 * (the default for a project automation), or a member's.
 */
const target = {
  sessionId: z.string().uuid().optional(),
  key: ChatKeySchema.optional(),
  audience: ChatAudienceSchema.optional(),
  expectedStateRevision: z.number().int().nonnegative().optional(),
};
const mutation = { ...target, idempotencyKey: z.string().min(1).max(300) };
function namesOneChat(value: object, context: z.RefinementCtx): void {
  const given = (field: string) =>
    field in value && Reflect.get(value, field) !== undefined;
  if (Number(given("sessionId")) + Number(given("key")) !== 1)
    context.addIssue({
      code: "custom",
      message: "Name the chat with exactly one of sessionId or key",
    });
  if (given("audience") && !given("key"))
    context.addIssue({
      code: "custom",
      message: "audience applies only to a chat named by key",
    });
}
function chat<Shape extends typeof target>(shape: Shape) {
  return z.strictObject(shape).superRefine(namesOneChat);
}
export const SESSION_ACTION_SCHEMAS = {
  inspect: chat(target),
  list: z.strictObject({ limit: z.number().int().min(1).max(100).optional() }),
  /** The open chat for a key, or null. Never starts one. */
  find: z.strictObject({
    key: ChatKeySchema,
    audience: ChatAudienceSchema.optional(),
  }),
  history: chat({
    ...target,
    limit: z.number().int().min(1).max(100).optional(),
  }),
  create: chat({
    ...mutation,
    agentId: z.string().optional(),
    title: z.string().max(500).optional(),
  }),
  fork: chat({
    ...mutation,
    messageId: z.string().uuid().optional(),
  }),
  spawn: chat({
    ...mutation,
    task: z.string().min(1),
    routeId: z.string().optional(),
    agentId: z.string().optional(),
    title: z.string().max(500).optional(),
    contextMode: z.enum(["fresh", "inherit"]).optional(),
  }),
  archive: chat({ ...mutation, confirmStop: z.boolean().optional() }),
  unarchive: chat(mutation),
  /** The end of a chat's life: its work, workspace and key are released. */
  close: chat(mutation),
  interrupt: chat(mutation),
  complete: chat({ ...mutation, content: z.string().min(1) }),
  reopen: chat(mutation),
  stopWatcher: chat({ ...mutation, watcherId: z.string().uuid() }),
};
export type SessionActionOperation = keyof typeof SESSION_ACTION_SCHEMAS;

export class SessionKeyNotFoundError extends Error {
  constructor(readonly key: string) {
    super(`No open chat has the key ${key}`);
    this.name = "SessionKeyNotFoundError";
  }
}
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
        const parsed = SESSION_ACTION_SCHEMAS[input.operation].parse(
          input.args,
        );
        if (input.operation === "list")
          return json(
            await this.sessions.list(input.identity, input.projectId, {
              limit: "limit" in parsed ? parsed.limit : 100,
            }),
          );
        const keyed =
          "key" in parsed && parsed.key !== undefined
            ? {
                key: parsed.key,
                ownerId: keyedChatOwnerId({
                  caller: input.identity,
                  audience: "audience" in parsed ? parsed.audience : undefined,
                }),
              }
            : undefined;
        const found = keyed
          ? await this.sessions.keyedChatId({
              projectId: input.projectId,
              ...keyed,
            })
          : "sessionId" in parsed
            ? parsed.sessionId
            : undefined;
        if (input.operation === "find")
          return found
            ? json(
                await this.sessions.get(input.identity, input.projectId, found),
              )
            : null;
        if (!found) {
          // A retried mutation whose chat is gone (closed) still answers
          // with its recorded result; otherwise nothing is open for the key.
          if ("idempotencyKey" in parsed) {
            const earlier = await this.db
              .selectFrom("session_actions")
              .select(["operation", "input", "result", "status"])
              .where("project_id", "=", input.projectId)
              .where(
                "idempotency_key",
                "=",
                JSON.stringify([input.author, parsed.idempotencyKey]),
              )
              .executeTakeFirst();
            if (
              earlier?.status === "completed" &&
              earlier.operation === input.operation &&
              canonical(earlier.input) === canonical(json(parsed))
            )
              return earlier.result;
          }
          // Closing a chat that is not open has nothing left to do.
          if (input.operation === "close")
            return json({ sessionId: null, closed: false });
          throw new SessionKeyNotFoundError(keyed?.key ?? "");
        }
        // The chat as the operation sees it: named by id from here on. The
        // action records what the caller asked for (`parsed`).
        const {
          key: _key,
          audience: _audience,
          ...rest
        } = {
          key: undefined,
          audience: undefined,
          ...parsed,
        };
        const args = { ...rest, sessionId: found };
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
        // Everything past this point changes the session: settle access
        // before the action is recorded, so a denied caller leaves no trace.
        await this.sessions.assertSession(
          input.identity,
          input.projectId,
          args.sessionId,
          "change",
        );
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
            input: json(parsed),
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
          JSON.stringify(action.input) !== JSON.stringify(json(parsed))
        ) {
          // Compare JSON semantically below: jsonb property order is not source order.
          if (
            action.operation !== input.operation ||
            canonical(action.input) !== canonical(json(parsed))
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
            case "close":
              await this.sessions.close(
                input.identity,
                input.projectId,
                args.sessionId,
                { origin: input },
              );
              result = { sessionId: args.sessionId, closed: true };
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
                "expectedStateRevision" in args &&
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
    find: "Found a session by key",
    history: "Read session history",
    create: "Created a session",
    fork: "Forked this session",
    spawn: "Created a child session",
    archive: "Archived this session",
    unarchive: "Unarchived this session",
    close: "Closed this chat",
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
