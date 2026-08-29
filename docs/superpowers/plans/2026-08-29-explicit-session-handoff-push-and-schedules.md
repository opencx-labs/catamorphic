# Explicit session handoff, push, and schedules implementation plan

1. Add migration and integration tests for durable replication intents,
   mirrored authority leases, pending handoffs, notification events,
   per-device push subscriptions and deliveries, and schedule occurrences.
2. Implement the core session-replication outbox and explicit authority claim
   state machine. Make session reads project resumability, and block sends
   while a coordinated handoff is pending.
3. Extend the mirror and session APIs with acknowledged transcript watermarks,
   authority lease renewal, handoff eligibility, and idempotent resume. Update
   Zod schemas, Fastify routes, OpenAPI, generated clients, and React hooks.
4. Replace the desktop fire-and-forget mirror with the durable outbox worker.
   Add desktop eligibility and move IPC, the always-present top-right button,
   focusable disabled explanations, reconciliation, and focused unit/E2E
   coverage.
5. Implement the durable notification service and host-injected push
   transport. Add stock-server VAPID persistence and Web Push sending, plus
   subscription lifecycle and retry tests.
6. Add PWA push opt-in, service-worker display/click handling, and the paused
   marker plus resume action in the existing sessions list. Add unit and PWA
   E2E coverage. Remove the superseded no-Web-Push guidance.
7. Register the code-authored `schedule` trigger kind, materialize validated
   schedule bindings, and implement a leased occurrence worker that dispatches
   through `TriggersService`. Cover cron/timezone validation, coalesced
   misfires, overlap suppression, and duplicate claims.
8. Wire the schedule and notification workers into the desktop/stock hosts,
   update seeds and docs, and add OpenTelemetry attributes on sync, handoff,
   notification, and schedule hot paths.
9. Run migration/codegen, API generation, package builds, focused core/API/
   desktop/PWA/server tests, both desktop E2E modes, visual desktop and PWA
   checks, and finally `bun run check`. Review the complete uncommitted diff.
