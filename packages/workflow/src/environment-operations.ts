import type { TransitionCall } from "./workflow.js";

/** One fill of an Environment cache on one machine (ADR 0334). */
export interface CacheFill {
  id: string;
  environment: string;
  cache: string;
  /** The machine whose copy it fills; null until it is placed. */
  machine: string | null;
  status: "queued" | "running" | "succeeded" | "failed" | "evicted";
  reason: "requested" | "first-use";
  /** The published revision it fills from; null fills the current one. */
  commit: string | null;
  generation: number | null;
  attempts: number;
  sizeBytes: number | null;
  error: string | null;
  createdAt: string;
  finishedAt: string | null;
  lastUsedAt: string | null;
}

/**
 * The project's Environments (ADR 0334), caller-bound like every host call.
 * A run fills a cache only when its workflow declared `caches:write`.
 */
export interface EnvironmentHostOperations {
  /**
   * Fill an Environment cache with the command it declares, in a fresh
   * sandbox holding a revision published from main: on every machine
   * holding a copy, or on one when none does. Fills of one cache on one
   * machine never overlap; a request while one waits joins it. Answers at
   * once with the fills it queued; each publishes its cache only when it
   * succeeds.
   */
  fillCache: TransitionCall<
    {
      environment: string;
      cache: string;
      /** A revision Work published from main; the current one by default. */
      commit?: string;
      idempotencyKey: string;
    },
    { fills: CacheFill[] }
  >;
}
