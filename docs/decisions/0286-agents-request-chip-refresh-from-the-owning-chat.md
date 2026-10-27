# 0286: Agents request chip refresh from the owning chat

- **Status:** Accepted
- **Date:** 2026-10-27

## Context

After an agent merges a pull request, its chip can show the old state until the
next poll. Chips already belong to sources (ADR 0239), with their own queries,
loads, grants and failure handling. Chat presentation already crosses into the
detached dock.

## Decision

A deferred `workspace.refresh_chips` operation takes no input and binds the
project and session from its caller. It requests a refresh of that chat's chips
using a presentation nonce on the existing chat registration path. It neither
changes session metadata nor focuses or opens a chat. A missing caller
presentation returns an error. It uses the existing presentation admission
policy and adds no eager schema.

PR chips refetch their existing per-URL observers, bypassing freshness and hidden
polling. Custom sources rerun their existing load while visible, or when next
shown. No new source method, per-chip refresh code or runtime restart is needed.
The result acknowledges the request, not network completion.

## Consequences

Agents can request fresh chip data immediately after a mutation. Fetching,
authorization, cancellation and failure behavior stay with the owning source.
Unrelated PR queries do not refetch. Hidden custom sources still pause, and
failed reads retain their last good result.
