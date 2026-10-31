# 0298 - Provider retries are turn state

- **Status:** Accepted
- **Date:** 2026-10-31

## Context

Harnesses can retry model requests while a turn remains running. Claude reports
retry counts and a delay; Codex reports whether it will retry and its error, but
not a retry deadline. Plain activity text and discarded diagnostics lose this
distinction, so a chat can appear to be thinking while its provider is unavailable.

## Decision

Adapters emit explicit `provider.retrying` and `provider.resumed` runner events.
The existing turn log persists nullable `Turn.providerRetry`, including the
provider error, reported counts, and a retry deadline only when a delay is known.
The adapter timestamps the deadline when it observes the retry, so delayed frame
ingestion cannot extend it. Unknown values remain null. New main-thread model output proves recovery; stream
start, tool output, usage updates, and unrelated child activity do not. Attempt
replacement and turn finalization clear this state.

Provider retries remain within their attempt. Core's scheduled attempt retries
keep `Turn.retryAt` and their existing `retrySafe` gate. Neither silence nor retry
metadata authorizes replay. Client/server connectivity remains a separate fact.

Chat presents a concise summary only for classified failures and preserves the
provider's message visibly, including unclassified errors. Retry, recovery, and
error transitions use the timeline's existing motion and presence primitives.

## Consequences

Reopening or mirroring a chat preserves a provider wait without a parallel state
store. The runner and session contracts change together, with no compatibility
layer. Codex gets an honest indeterminate retry status rather than invented
counts or timing. Tests cover false recovery signals and animation interruption.
