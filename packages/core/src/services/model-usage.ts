import type { DB } from "@catamorphic/db";
import { type Kysely, sql } from "kysely";
import { MAX_OPEN_CALL_MINUTES } from "./model-gateway.js";

/** Token totals and the cost providers reported for a set of model calls. */
export interface ModelUsageTotals {
  /** Settled calls counted here. */
  calls: number;
  /** Uncached input tokens (never includes the cached portion). */
  inputTokens: number;
  cachedInputTokens: number;
  cacheCreationTokens: number;
  outputTokens: number;
  /** Subset of `outputTokens`. */
  reasoningTokens: number;
  /**
   * The sum of what providers said these calls cost, in US dollars; null
   * when none said. Work never estimates (ADR 0329).
   */
  costUsd: number | null;
  /** Calls whose provider reported no cost: `costUsd` is a lower bound. */
  unpricedCalls: number;
}

/** A chat's model usage through the gateway, optionally with its subsessions. */
export interface SessionUsage extends ModelUsageTotals {
  sessionId: string;
  /** Whether the totals include every subsession below the chat. */
  family: boolean;
  /** The chats counted: the chat, and its subsessions when `family`. */
  sessions: number;
  /** Calls still streaming, not yet in the totals. */
  openCalls: number;
  /** The same totals per model, by name; `model` is null when unknown. */
  models: Array<ModelUsageTotals & { model: string | null }>;
}

/**
 * Totals of the settled gateway calls of these sessions, per model, in one
 * grouped query over the `model_usage_session_turn` index.
 */
export async function sessionUsageTotals(args: {
  db: Kysely<DB>;
  projectId: string;
  sessionId: string;
  sessionIds: readonly string[];
  family: boolean;
}): Promise<SessionUsage> {
  const rows =
    args.sessionIds.length === 0
      ? []
      : await args.db
          .selectFrom("model_usage")
          .where("project_id", "=", args.projectId)
          .where("agent_session_id", "in", [...args.sessionIds])
          .groupBy("model")
          .orderBy("model")
          .select([
            "model",
            sql<string>`count(*) FILTER (WHERE settled_at IS NOT NULL)`.as(
              "calls",
            ),
            // A call open longer than any call streams was lost with its
            // replica (ADR 0193): it is neither counted nor waited for.
            sql<string>`count(*) FILTER (WHERE settled_at IS NULL AND created_at > now() - (${MAX_OPEN_CALL_MINUTES} * interval '1 minute'))`.as(
              "open",
            ),
            sql<string>`coalesce(sum(input_tokens), 0)`.as("input"),
            sql<string>`coalesce(sum(cached_input_tokens), 0)`.as("cached"),
            sql<string>`coalesce(sum(cache_creation_tokens), 0)`.as("creation"),
            sql<string>`coalesce(sum(output_tokens), 0)`.as("output"),
            sql<string>`coalesce(sum(reasoning_tokens), 0)`.as("reasoning"),
            sql<string>`count(cost_usd)`.as("priced"),
            sql<string | null>`sum(cost_usd)`.as("cost"),
          ])
          .execute();
  const models = rows
    .map((row) => ({
      model: row.model,
      calls: Number(row.calls),
      inputTokens: Number(row.input),
      cachedInputTokens: Number(row.cached),
      cacheCreationTokens: Number(row.creation),
      outputTokens: Number(row.output),
      reasoningTokens: Number(row.reasoning),
      costUsd: row.cost === null ? null : Number(row.cost),
      unpricedCalls: Number(row.calls) - Number(row.priced),
    }))
    .filter((model) => model.calls > 0);
  const sum = (field: keyof Omit<ModelUsageTotals, "costUsd">) =>
    models.reduce((total, model) => total + model[field], 0);
  const priced = models.filter((model) => model.costUsd !== null);
  return {
    sessionId: args.sessionId,
    family: args.family,
    sessions: args.sessionIds.length,
    calls: sum("calls"),
    inputTokens: sum("inputTokens"),
    cachedInputTokens: sum("cachedInputTokens"),
    cacheCreationTokens: sum("cacheCreationTokens"),
    outputTokens: sum("outputTokens"),
    reasoningTokens: sum("reasoningTokens"),
    costUsd: priced.length
      ? priced.reduce((total, model) => total + (model.costUsd ?? 0), 0)
      : null,
    unpricedCalls: sum("unpricedCalls"),
    openCalls: rows.reduce((total, row) => total + Number(row.open), 0),
    models,
  };
}
