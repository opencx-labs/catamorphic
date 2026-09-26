# 0160 — The Work server is a package with typed hooks

- **Status:** Accepted
- **Date:** 2026-09-25
- **Refines:** 0059, 0071, 0159

## Context

The Work server composed the Catamorphic libraries inside `apps/server`, read
its settings from environment variables scattered across modules, and offered
two narrow injection points. A company that needs one custom piece (its own
sign-in for customers, a query classifier, an internal connection provider)
had to fork the app or rebuild the whole host from the lower-level SDK,
including auth, admission, machine setup, and every security default.

## Decision

The composition moves to `packages/work-server` (`@catamorphic/work-server`).
It exports `createWorkServer({ config, hooks })`, a typed `WorkServerConfig`,
and `workServerConfigFromEnv(env)` which parses the `WORK_*` variables
(ADR 0159) once, with validation. `apps/server` keeps only the process
concerns of the published image: environment parsing, mDNS, listening, and
signal handling.

Hooks extend the server without replacing its security model:

- `agentCapabilities` and `connectionProviders`, as before;
- `connectionGuards`, `directory`, and additional identity providers, added
  by the ADRs that introduce them;
- `projectSeeds`, to change starting files (doctrine, ADR 0049);
- `routes`, to mount additional host routes on the public application.

Hooks cannot remove token checks, admission, membership resolution, the
loopback-only operator listener, or fencing. Everything generic (Google
Workspace sign-in, directory deprovisioning, the connection gateway, guest
sharing) is built in and enabled by configuration, so most deployments use the
image unchanged. A company with custom code extends the image rather than
forking: a Dockerfile `FROM` the published image adds one `server.ts` that
calls `createWorkServer` with its hooks. Host tables use the `work_` prefix.

Considered: composing directly from `@catamorphic/server-sdk`. Rejected as the
default because every deployment would reimplement auth, admission, and setup
and drift from the audited path. It remains the route for hosts with their own
identity model (ADR 0053).

## Consequences

The image and custom servers run the same code. New Work server features land
as configuration plus an optional hook. The package is Work-specific product
composition; framework packages must never import it.
