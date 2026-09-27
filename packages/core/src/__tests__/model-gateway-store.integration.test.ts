import crypto from "node:crypto";
import { createDatabase, migrateToLatest } from "@catamorphic/db";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  dbModelGatewayStore,
  type ModelUsageRecord,
} from "../services/model-gateway.js";

const connectionString = process.env.DATABASE_URL ?? "";
const describeIf = connectionString ? describe : describe.skip;
const schema = `catamorphic_model_usage_${crypto.randomUUID().replaceAll("-", "")}`;
const db = createDatabase({ connectionString, schema, poolSize: 8 });

describeIf("model usage reservations (ADR 0180)", () => {
  beforeAll(async () => {
    await migrateToLatest({ db, schema });
  });

  afterAll(async () => {
    await db.schema.dropSchema(schema).cascade().execute();
    await db.destroy();
  });

  const call = (turnId: string, sessionId: string): ModelUsageRecord => ({
    tenantId: crypto.randomUUID(),
    projectId: crypto.randomUUID(),
    sessionId,
    turnId,
    allocationId: crypto.randomUUID(),
    connectionId: crypto.randomUUID(),
    alias: "model",
    endpoint: "messages",
    model: "claude-test-1",
  });

  it("grants concurrent calls no more than the turn's budget", async () => {
    const store = dbModelGatewayStore(db);
    const turnId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const granted = await Promise.all(
      Array.from({ length: 12 }, () =>
        store.reserve({
          record: call(turnId, sessionId),
          outputTokens: 64,
          budget: 300,
        }),
      ),
    );
    const total = granted.reduce((sum, grant) => sum + grant.outputTokens, 0);
    expect(total).toBe(300);
    expect(granted.filter((grant) => grant.id === null)).toHaveLength(7);
    expect((await store.usage({ sessionId, turnId }))?.outputTokens).toBe(300);
  });

  it("settles a reservation to what the call used, or drops it", async () => {
    const store = dbModelGatewayStore(db);
    const turnId = crypto.randomUUID();
    const sessionId = crypto.randomUUID();
    const first = await store.reserve({
      record: call(turnId, sessionId),
      outputTokens: 100,
      budget: 150,
    });
    const second = await store.reserve({
      record: call(turnId, sessionId),
      outputTokens: 100,
      budget: 150,
    });
    expect([first.outputTokens, second.outputTokens]).toEqual([100, 50]);
    if (!first.id || !second.id) throw new Error("expected reservations");
    await store.settle({
      id: first.id,
      usage: {
        inputTokens: 10,
        cachedInputTokens: 0,
        cacheCreationTokens: 0,
        outputTokens: 12,
        reasoningTokens: 0,
      },
    });
    await store.settle({ id: second.id, usage: null });
    expect(await store.usage({ sessionId, turnId })).toMatchObject({
      model: "claude-test-1",
      inputTokens: 10,
      outputTokens: 12,
    });
    const third = await store.reserve({
      record: call(turnId, sessionId),
      outputTokens: 500,
      budget: 150,
    });
    expect(third.outputTokens).toBe(138);
  });
});
