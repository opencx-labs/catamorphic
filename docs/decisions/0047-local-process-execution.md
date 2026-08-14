# 0047 — Sandboxless execution is a provider: `@catamorphic/local-process`

## Status

Accepted.

## Context

Internal-tools hosts run workflow code their own team authored and deployed.
For them a cloud sandbox adds infrastructure (an account, a worker, a
tunnel to reach anything on the host's network) without adding trust: the
code is already theirs. The INTEGRATION.md host-shape table has always
claimed a "light end" for every axis; execution's lightest end was missing.

The deciding constraint is what the trust statement actually is. Catamorphic
workflows are routinely **agent-written** — so "the code is ours" is only
defensible because of ADR 0040: every production run executes an immutable
deployed commit. The trust attaches to a reviewed deploy, not to whatever an
agent typed five minutes ago.

## Decision

**Sandboxless execution ships as `LocalProcessSandboxProvider` in
`@catamorphic/local-process` — an ordinary `SandboxProvider`, not a mode.**
Selecting it is a boot-time act in host code, which keeps it deliberate by
construction; nothing in core knows the difference.

- **Subprocess, never in-process.** Each "sandbox" is a directory; commands
  run via `spawn`. The harness contract (explicit env map, stdio supervisor
  protocol, timeouts, kill) already assumes a process boundary and carries
  over unchanged, including warm deployment runtimes over the same
  stdio supervisor protocol the microsandbox provider uses.
- **Explicit env only.** The child process env is exactly: a minimal exec
  base (`PATH`, a per-sandbox `HOME`, locale) plus what the executor passes
  (`CATAMORPHIC_*` + resolved bindings). It must never inherit
  `process.env` — that one-liner would leak every host secret into every
  workflow.
- **Virtual workspace root.** The provider advertises a stable
  `workspaceRoot` and maps it per sandbox onto
  `<root>/<sandboxId>/workspace`, so provider-agnostic callers keep building
  paths the same way they do for container providers.
- **Honest limits.** Timeouts are enforced; memory/CPU are not — a runaway
  workflow competes with the host process. Documented, not mitigated.

**Who may use it:** single-tenant / internal-tools shapes, and desktop-class
hosts. Multi-tenant hosts must not — one tenant's workflow could read
another's filesystem and the host's network. Guidance ships in
INTEGRATION.md; per-project provider selection for mixed-trust fleets is
deferred until a host needs it (ADR 0028's tenant execution policy is the
natural home).

To support a second stdio transport, the supervisor channel and runtime
provider logic move from `@catamorphic/microsandbox` into
`@catamorphic/sandbox` behind a small transport seam (`write`/`kill` plus a
stdout byte stream); the microsandbox provider adapts its exec stream, the
local provider adapts `child_process`.

## Consequences

- The lightest full host shape becomes: pglite (or host Postgres), local
  processes, filesystem storage, one tenant — zero cloud dependencies, and
  workflows reach host-local services (a PGlite fleet behind a loopback
  pg-gateway, internal APIs) with no ingress or tunnels.
- `bun` must be on the host's PATH; the runtime supervisor runs with it.
- The desktop app's e2e fake provider is no longer the only local
  implementation; production-grade local execution is a supported package.
