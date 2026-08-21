# 0057 — Agent usage and cost: transcript-scanned page, per-turn usage in metadata

- **Status:** Accepted
- **Date:** 2026-08-21
- **Builds on:** 0038 (coding-agent registry), 0044 (turn-settled metadata)
- **Inspired by:** t3 Code's usage subsystem (see `memory reference_t3_code.md`
  and the 2026-08-21 gap study) — the same design premise, independently
  implemented against our harness stack.

## Context

The desktop reports nothing about consumption: no token counts, no cost, no
context-window occupancy. Every harness already tells us — the Claude Code
SDK's `result` message carries `usage`, `total_cost_usd`, and per-model
`contextWindow`; Codex's `turn.completed` carries token counters; the AI SDK
exposes `totalUsage` — and we discard all of it. Separately, the provider
CLIs keep complete local session transcripts (`<claude-home>/projects/**.jsonl`,
`<codex-home>/sessions/**.jsonl`) that record usage for **every** session on
the machine, including terminal sessions Catamorphic never saw.

Two sources, two different strengths, and they don't overlap cleanly:

- **Live stream** (this app's turns only): Claude reports cost and context
  window here and nowhere else; Codex reports plain counters.
- **On-disk transcripts** (the whole machine): Claude JSONL has usage but no
  cost; Codex rollouts have usage, `model_context_window`, and rate-limit
  state. History survives app restarts and includes CLI usage.

## Decision

**Two independent capture paths, one vocabulary.**

1. **Per-turn usage rides the turn.** `AgentEvent` gains a `"usage"` type
   carrying an `AgentTurnUsage` snapshot (token counters split
   uncached/cached/cache-creation/output/reasoning, optional harness-reported
   `costUsd`, optional `contextTokens`/`contextWindow`). Each harness emits at
   most one per turn, right before `done`. The sessions service strips usage
   events out of the persisted step-log `events` (they are accounting, not
   activity) and stamps the snapshot as `metadata.usage` on the settled
   assistant message. Because chat state reaches the renderer by polling
   session messages, this needs no new IPC: the composer's context meter reads
   the last assistant reply's `metadata.usage`.

2. **The usage page scans the CLIs' own transcripts.** A desktop-main scanner
   (pure parsers in their own modules, unit-tested; filesystem walk + cache in
   a service, mirroring `auth-health.ts`) reads every transcript root this
   machine has: the machine defaults `~/.claude` and `~/.codex` (used by
   `local`- and `api-key`-auth agents and by the user's own terminal sessions)
   plus each `account`-auth agent's isolated home under `agent-homes/`.
   Deliberately whole-machine — the page answers "what did I spend", not
   "what did this app spend" — and the UI says so.

**Parsing rules** (each guards a real overcount, measured by t3/ccusage):

- Claude writes one JSONL record per assistant *content block*, each
  repeating the whole `usage` object — dedupe on `message.id:requestId`
  globally across files (resumed/forked sessions copy records forward), or
  totals run ~2.4x high.
- Codex `token_count` events: use `last_token_usage` deltas, drop consecutive
  duplicates (signature compare), carry the model forward from
  `turn_context`, count only the first `session_meta` (forks replay
  ancestors'), and suppress the fork-copy burst (leading records < 1s apart
  after a forked/subagent `session_meta`) or totals run ~1.85x high.
- Codex `input_tokens` includes the cached portion; subtract. Claude's does
  not. `reasoning_output_tokens` is a subset of output — never added to
  totals, never priced separately.

**Pricing** comes from LiteLLM's published price table, fetched at most daily
and cached on disk; no rate is checked into the repo. Unknown or ambiguous
models (`<synthetic>`, bare family names) stay in token totals and price at
zero, and the page reports the unpriced share instead of guessing. Cost is
labeled an API-equivalent estimate: subscription billing is separate.
Cache savings = cached reads × (input rate − cache-read rate).

**Cache**: parsed records are cached per file keyed on `(size, mtime,
provider)` in one JSON blob under the profile's data dir. A read failure is
never cached as empty; a corrupt row invalidates its whole file entry; a
cache version bump invalidates everything whenever parser semantics change.

**Surfaces**: a `usage` workspace tab (palette: "Usage", singleton like
Settings) with range picker (24h/7/30/90 days), cost/tokens toggle, a
hand-rolled SVG chart (layered per-provider areas from a shared zero
baseline, never stacked), provider split, model table, cache savings. And a
small context ring in the chat composer fed by `metadata.usage`, danger-red
past 90% occupancy.

## Consequences

- No schema change: `agent_messages.metadata` already exists and already
  reaches the renderer at the working-turn poll cadence.
- The scanner never touches `packages/core` — transcript layout is a
  desktop/CLI concern, so it lives in `apps/desktop/src/main/`.
- ai-sdk turns stamp `metadata.usage` too, but have no on-disk transcripts;
  the page covers claude-code and codex.
- The context meter is exact for Claude Code (occupancy + window reported
  live). Codex's SDK stream reports no context window, so its meter shows
  occupancy only when a window is known from transcripts later; v1 renders
  the ring only when both numbers exist.
- Deferred: per-subagent token attribution, rate-limit/quota gauges (Codex
  rollouts already carry `rate_limits`), an app-only scope filter (join
  transcript session ids to `agent_sessions.provider_session_id`), and
  multi-machine merge (rides the 0055 server direction).
