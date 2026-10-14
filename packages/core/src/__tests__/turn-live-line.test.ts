import type {
  Attempt,
  ProviderThread,
  Turn,
} from "@catamorphic/agent-protocol";
import type {
  HarnessEvent,
  ItemDraft,
} from "@catamorphic/agent-protocol/runner";
import type { DB } from "@catamorphic/db";
import {
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import { SecretMask } from "../services/sessions/secret-mask.js";
import { ingestHarnessEvents } from "../services/sessions/turn-ingest.js";

/*
 * The turn's live line is the best a harness says about what the agent is
 * doing: its own words for the work (a reasoning title), held through the
 * steps they lead to, else the running step's own description, else a verb
 * Work derives from the step.
 */

const at = new Date().toISOString();
const attemptId = "00000000-0000-4000-8000-000000000011";
const turn: Turn = {
  id: "00000000-0000-4000-8000-000000000012",
  sessionId: "00000000-0000-4000-8000-000000000013",
  ordinal: 1,
  status: "running",
  inputItemId: null,
  dispatch: "queue",
  priority: 0,
  activity: null,
  activityAt: null,
  attemptCount: 1,
  activeAttemptId: attemptId,
  providerThreadId: null,
  retryAt: null,
  cancellationRequested: false,
  error: null,
  outcome: null,
  checkpoint: { before: null, after: null },
  continuationOf: null,
  createdAt: at,
  startedAt: at,
  completedAt: null,
  updatedAt: at,
};
const attempt: Attempt = {
  id: attemptId,
  turnId: turn.id,
  sessionId: turn.sessionId,
  ordinal: 1,
  reason: "initial",
  status: "running",
  providerThreadId: null,
  nativeTurnRef: null,
  error: null,
  createdAt: at,
  startedAt: at,
  completedAt: null,
};
const thread: ProviderThread = {
  id: "00000000-0000-4000-8000-000000000014",
  sessionId: turn.sessionId,
  harness: "test",
  nativeRef: null,
  status: "active",
  lastTurnOrdinal: null,
  portable: true,
  createdAt: at,
  updatedAt: at,
};

/** A database with no recorded items: every batch here starts new ones. */
function emptyDatabase(): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(): Promise<QueryResult<R>> => ({ rows: [] }),
    // biome-ignore lint/correctness/useYield: never streamed
    streamQuery: async function* () {
      throw new Error("not streamed");
    },
  };
  const driver: Driver = {
    init: async () => {},
    acquireConnection: async () => connection,
    beginTransaction: async () => {},
    commitTransaction: async () => {},
    rollbackTransaction: async () => {},
    releaseConnection: async () => {},
    destroy: async () => {},
  };
  return new Kysely<DB>({
    dialect: {
      createAdapter: () => new PostgresAdapter(),
      createDriver: () => driver,
      createIntrospector: (db) => new PostgresIntrospector(db),
      createQueryCompiler: () => new PostgresQueryCompiler(),
    },
  });
}

const command = (
  description: string | null,
  line = "rg parser src",
): ItemDraft => ({
  kind: "command",
  command: line,
  description,
  output: "",
  exitCode: null,
});

describe("the turn's live line", () => {
  it("says what the running step does, and keeps the agent's own words through the steps they lead to", async () => {
    const db = emptyDatabase();
    let state = { turn, attempt, thread };
    const ingest = async (events: HarnessEvent[]) => {
      const result = await db.transaction().execute((trx) =>
        ingestHarnessEvents({
          trx,
          state: { sessionId: turn.sessionId, agentId: null, ...state },
          events,
          now: new Date(),
        }),
      );
      state = {
        turn: result.turn,
        attempt: result.attempt,
        thread: result.thread,
      };
      return result.turn.activity;
    };

    // A step's own description, as its row shows it.
    expect(
      await ingest([
        {
          type: "item.started",
          key: "c1",
          item: command("Read  the VAD options and their history"),
        },
      ]),
    ).toBe("Read the VAD options and their history");
    // Without one, the verb Work derives from it.
    expect(
      await ingest([{ type: "item.started", key: "c2", item: command(null) }]),
    ).toBe("Searching files...");
    // The agent's own words take the line.
    expect(
      await ingest([{ type: "status", text: "Inspecting the parser" }]),
    ).toBe("Inspecting the parser");
    // And hold it through the work they lead to, a step that describes
    // itself included.
    expect(
      await ingest([
        {
          type: "item.started",
          key: "c3",
          item: command("Read app.tsx"),
          activity: "Inspecting the parser",
        },
      ]),
    ).toBe("Inspecting the parser");
    // Until the agent says something new.
    expect(
      await ingest([
        { type: "status", text: "Fixing the parser" },
        {
          type: "item.started",
          key: "c4",
          item: command("Edit the parser"),
          activity: "Fixing the parser",
        },
      ]),
    ).toBe("Fixing the parser");
  });

  it("follows the batch's order, and never records a secret the words carry", async () => {
    const db = emptyDatabase();
    const mask = new SecretMask({ API_KEY: "sk-live-0123456789" });
    const batch = mask.begin();
    const result = await db.transaction().execute((trx) =>
      ingestHarnessEvents({
        trx,
        state: {
          sessionId: turn.sessionId,
          agentId: null,
          turn,
          attempt,
          thread,
        },
        events: [
          { type: "status", text: "Reading the parser" },
          // Thinking that said nothing: the next step speaks for itself.
          { type: "item.started", key: "c1", item: command("Run the tests") },
          {
            type: "item.started",
            key: "c2",
            item: command(null),
            activity: "Calling the API with sk-live-0123456789",
          },
        ],
        now: new Date(),
        mask: batch,
      }),
    );
    batch.commit();
    expect(result.turn.activity).toBe("Calling the API with [secret API_KEY]");
  });
});
