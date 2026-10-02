import { randomUUID } from "node:crypto";
import type { Turn } from "@catamorphic/agent-protocol";
import type { DB } from "@catamorphic/db";
import type { Kysely } from "kysely";
import { SessionLog } from "../services/sessions/session-log.js";
import { TurnQueue } from "../services/sessions/turn-queue.js";

/**
 * The session log without the service, for tests of claiming and leases:
 * queue a person's message as a turn, and settle a claimed one.
 */
export function sessionLogFixture(db: Kysely<DB>) {
  const log = new SessionLog(db);
  const queue = new TurnQueue(db, log);
  return {
    log,
    queue,
    /** A person's message and the queued turn it starts. */
    async queueTurn(input: {
      sessionId: string;
      text: string;
      externalUserId?: string;
    }): Promise<Turn> {
      return db.transaction().execute(async (trx) => {
        const last = await trx
          .selectFrom("agent_turns")
          .select((eb) => eb.fn.max("ordinal").as("ordinal"))
          .where("session_id", "=", input.sessionId)
          .executeTakeFirst();
        const now = new Date().toISOString();
        const itemId = randomUUID();
        const turn: Turn = {
          id: randomUUID(),
          sessionId: input.sessionId,
          ordinal: Number(last?.ordinal ?? 0) + 1,
          status: "queued",
          inputItemId: itemId,
          dispatch: "queue",
          priority: 0,
          activity: null,
          activityAt: null,
          attemptCount: 0,
          activeAttemptId: null,
          providerThreadId: null,
          retryAt: null,
          cancellationRequested: false,
          error: null,
          outcome: null,
          checkpoint: { before: null, after: null },
          continuationOf: null,
          createdAt: now,
          startedAt: null,
          completedAt: null,
          updatedAt: now,
        };
        await log.append(trx, {
          sessionId: input.sessionId,
          events: [
            {
              type: "item.added",
              item: {
                id: itemId,
                sessionId: input.sessionId,
                turnId: turn.id,
                attemptId: null,
                parentItemId: null,
                position: 0,
                status: "completed",
                nativeRef: null,
                createdAt: now,
                updatedAt: now,
                startedAt: now,
                endedAt: now,
                kind: "user_message",
                author: {
                  kind: "user",
                  externalUserId: input.externalUserId ?? "member",
                },
                text: input.text,
                attachments: [],
                dispatch: "queue",
                attention: null,
                idempotencyKey: null,
                metadata: {},
              },
            },
            { type: "turn.changed", turn },
          ],
        });
        return turn;
      });
    },
    /** Settle a claimed turn as completed and give up its lease. */
    async complete(turn: Turn): Promise<void> {
      await db.transaction().execute(async (trx) => {
        const now = new Date().toISOString();
        await log.append(trx, {
          sessionId: turn.sessionId,
          events: [
            {
              type: "turn.changed",
              turn: { ...turn, status: "completed", completedAt: now, updatedAt: now },
            },
          ],
        });
        await queue.release(trx, { turnId: turn.id });
      });
    },
  };
}
