import type {
  Attempt,
  Item,
  ProviderThread,
  SessionEvent,
  Turn,
} from "@catamorphic/agent-protocol";
import type { HarnessEvent } from "@catamorphic/agent-protocol/runner";
import type { DB } from "@catamorphic/db";
import {
  type CompiledQuery,
  type DatabaseConnection,
  type Driver,
  Kysely,
  PostgresAdapter,
  PostgresIntrospector,
  PostgresQueryCompiler,
  type QueryResult,
} from "kysely";
import { describe, expect, it } from "vitest";
import { SecretMask, secretForms } from "../services/sessions/secret-mask.js";
import {
  derivedId,
  ingestHarnessEvents,
} from "../services/sessions/turn-ingest.js";

/*
 * Values a turn's sandbox received never enter its recorded output (ADR
 * 0206): whole values become `[secret NAME]`, and streamed text holds back
 * whatever could still be the start of a value, across deltas and batches.
 */

const KEY = "sk-live-0123456789";

describe("secret masks", () => {
  it("replaces every whole value, longest first, and never its own labels", () => {
    const mask = new SecretMask({
      API_KEY: KEY,
      PREFIX: "sk-live",
      // A value that is also a word in the labels Work writes.
      WORD: "secret",
      SHORT: "abc",
    });
    expect(mask.text(`a ${KEY} b sk-live c secret d abc`)).toBe(
      "a [secret API_KEY] b [secret PREFIX] c [secret WORD] d abc",
    );
    expect(
      mask.value({ input: { command: `curl -H ${KEY}` }, list: [KEY, 3] }),
    ).toEqual({
      input: { command: "curl -H [secret API_KEY]" },
      list: ["[secret API_KEY]", 3],
    });
    expect(new SecretMask({ SHORT: "abcde" }).empty).toBe(true);
    expect(
      new SecretMask({ ONE: ["first-value", "other-value"] }).text(
        "first-value other-value",
      ),
    ).toBe("[secret ONE] [secret ONE]");
  });

  it("masks the forms output carries a value in", () => {
    const quoted = 'pa"ss\\word-0123';
    const pem = "-----BEGIN KEY-----\nMIIEowIBAAKCAQEA\n-----END KEY-----";
    const mask = new SecretMask({ QUOTED: quoted, PEM: pem, API_KEY: KEY });
    // Inside a JSON string, as a tool's JSON result holds it.
    expect(mask.text(JSON.stringify({ token: quoted }))).toBe(
      '{"token":"[secret QUOTED]"}',
    );
    // Base64 (with and without padding, URL-safe) and URL-encoded.
    const base64 = Buffer.from(KEY).toString("base64");
    expect(mask.text(`a ${base64} b`)).toBe("a [secret API_KEY] b");
    expect(mask.text(base64.replace(/=+$/, ""))).toBe("[secret API_KEY]");
    expect(mask.text(Buffer.from(quoted).toString("base64url"))).toBe(
      "[secret QUOTED]",
    );
    expect(mask.text(`?t=${encodeURIComponent(quoted)}`)).toBe(
      "?t=[secret QUOTED]",
    );
    // A multi-line value with CRLF endings, and any one of its lines.
    expect(mask.text(pem.replaceAll("\n", "\r\n"))).toBe("[secret PEM]");
    expect(mask.text("line: MIIEowIBAAKCAQEA")).toBe("line: [secret PEM]");
    expect(mask.text(JSON.stringify(pem))).toBe('"[secret PEM]"');
    expect(secretForms("short")).toEqual([]);
  });

  it("holds back a split value until its stream says what it is", () => {
    const mask = new SecretMask({ API_KEY: KEY });
    const key = { itemId: "item", field: "text" as const };
    const first = mask.begin();
    expect(first.stream(key, "Your key is sk-li")).toBe("Your key is ");
    first.commit();
    const second = mask.begin();
    expect(second.stream(key, "ve-0123")).toBe("");
    expect(second.stream(key, "456789 and more")).toBe(
      "[secret API_KEY] and more",
    );
    // A tail that turned out to be ordinary text is released.
    expect(second.stream(key, " sk-")).toBe(" ");
    expect(second.flush(key)).toBe("sk-");
    expect(second.holding()).toEqual([]);
  });

  it("keeps held text only from batches that were recorded", () => {
    const mask = new SecretMask({ API_KEY: KEY });
    const key = { itemId: "item", field: "output" as const };
    const recorded = mask.begin();
    expect(recorded.stream(key, "sk-live-01")).toBe("");
    recorded.commit();
    // This batch's transaction failed: what it took is read again.
    const lost = mask.begin();
    expect(lost.stream(key, "23456789")).toBe("[secret API_KEY]");
    const again = mask.begin();
    expect(again.holding()).toEqual([key]);
    expect(again.stream(key, "23456789")).toBe("[secret API_KEY]");
    // A field given whole drops what streamed into it.
    again.stream(key, "sk-");
    again.drop(key);
    expect(again.holding()).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// The ingest point

const at = new Date().toISOString();
const attemptId = "00000000-0000-4000-8000-000000000001";
const turn: Turn = {
  id: "00000000-0000-4000-8000-000000000002",
  sessionId: "00000000-0000-4000-8000-000000000003",
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
  id: "00000000-0000-4000-8000-000000000004",
  sessionId: turn.sessionId,
  harness: "test",
  nativeRef: null,
  status: "active",
  lastTurnOrdinal: null,
  portable: true,
  createdAt: at,
  updatedAt: at,
};

/**
 * A database that answers the ingest's reads from `items`, the recorded
 * items as the log projected them: enough to ingest batch after batch.
 */
function itemsDatabase(items: Map<string, Item>): Kysely<DB> {
  const connection: DatabaseConnection = {
    executeQuery: async <R>(query: CompiledQuery): Promise<QueryResult<R>> => {
      if (!query.sql.includes('from "agent_items"')) return { rows: [] };
      const rows = query.parameters.flatMap((id) => {
        const item = typeof id === "string" ? items.get(id) : undefined;
        return item ? [{ payload: item }] : [];
      });
      return { rows: rows as R[] };
    },
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

/** Apply recorded events to the items, as the log's projection would. */
function project(items: Map<string, Item>, events: readonly SessionEvent[]) {
  for (const event of events) {
    if (event.type === "item.added" || event.type === "item.changed")
      items.set(event.item.id, event.item);
    if (event.type === "item.text_appended") {
      const item = items.get(event.itemId);
      if (item?.kind === "assistant_message" && event.field === "text")
        items.set(item.id, { ...item, text: item.text + event.text });
      if (item?.kind === "command" && event.field === "output")
        items.set(item.id, { ...item, output: item.output + event.text });
    }
  }
}

describe("recorded output of a turn with secrets", () => {
  it("never records a value, whole or in parts, anywhere an event carries it", async () => {
    const items = new Map<string, Item>();
    const db = itemsDatabase(items);
    const mask = new SecretMask({ API_KEY: KEY });
    const recorded: SessionEvent[] = [];
    let state = { turn, attempt, thread };
    const ingest = async (events: HarnessEvent[]) => {
      const batch = mask.begin();
      const result = await db.transaction().execute((trx) =>
        ingestHarnessEvents({
          trx,
          state: { sessionId: turn.sessionId, agentId: null, ...state },
          events,
          now: new Date(),
          mask: batch,
        }),
      );
      batch.commit();
      project(items, result.events);
      recorded.push(...result.events);
      state = {
        turn: result.turn,
        attempt: result.attempt,
        thread: result.thread,
      };
      return result;
    };

    await ingest([
      {
        type: "item.started",
        key: "reply",
        item: { kind: "assistant_message", text: "", agentId: null },
      },
      {
        type: "item.delta",
        key: "reply",
        field: "text",
        text: "The key is sk-li",
      },
      {
        type: "item.started",
        key: "run",
        item: {
          kind: "command",
          command: `echo ${KEY}`,
          description: null,
          output: "",
          exitCode: null,
        },
      },
      { type: "item.delta", key: "run", field: "output", text: `${KEY}\n` },
      { type: "status", text: `Using ${KEY}` },
    ]);
    // The next batch, read after the first was recorded.
    const last = await ingest([
      { type: "item.delta", key: "reply", field: "text", text: "ve-0123456" },
      { type: "item.delta", key: "reply", field: "text", text: "789, and sk-" },
      { type: "item.completed", key: "reply", status: "completed" },
      {
        type: "item.completed",
        key: "run",
        status: "completed",
        item: { output: `${KEY}\n`, exitCode: 0 },
      },
      {
        type: "request.opened",
        key: "approve",
        request: {
          kind: "approval",
          blocking: false,
          title: `Run curl with ${KEY}?`,
          origin: { kind: "tool", id: "bash" },
          approval: {
            action: "bash",
            tool: { server: null, name: "bash", input: { command: KEY } },
          },
        },
      },
      {
        type: "turn.completed",
        status: "failed",
        error: { message: `Rejected ${KEY}` },
      },
    ]);

    expect(JSON.stringify(recorded)).not.toContain("0123456789");
    expect(JSON.stringify(recorded)).not.toContain("sk-live");
    const reply = items.get(derivedId(attemptId, "reply"));
    expect(reply?.kind === "assistant_message" && reply.text).toBe(
      "The key is [secret API_KEY], and sk-",
    );
    const run = items.get(derivedId(attemptId, "run"));
    expect(run?.kind === "command" && run.command).toBe(
      "echo [secret API_KEY]",
    );
    expect(run?.kind === "command" && run.output).toBe("[secret API_KEY]\n");
    expect(last.completed?.error?.message).toBe("Rejected [secret API_KEY]");
  });
});
