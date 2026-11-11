# 0310: Cloudflare sandboxes use native containers

- **Status:** Accepted
- **Date:** 2026-11-11
- **Amends:** [0004](0004-cloudflare-first-infrastructure.md),
  [0008](0008-vendor-plugin-packages.md)

## Context

Cloudflare Sandbox SDK 1.x replaces the upstream Sandbox class, HTTP bridge and
warm pool with native Durable Object container execution. Updating the package
alone removes the APIs our bridge imports. The host-facing SandboxProvider
contract already expresses the execution and storage operations we need.

## Decision

Keep `CloudflareSandboxProvider` as the injected host HTTP client and implement
its small bridge in our Worker. The `NativeSandbox` Durable Object operates
`ctx.container` directly. SDK `Files` handles file IO with an exactly matching
`sandbox-shim` image. Exec gets argv, cwd and environment as native options.
GNU timeout owns each command's process group; deadlines and request cancellation
stop that group. GNU timeout owns the deadline without a Worker timer. Abort
listeners are removed when the native process exits, so cancellation cannot
signal a finished process. Our HTTP
response retains bounded SSE output with the native exit code.
Files are staged and renamed after a complete upload. Workspace hydration streams
a tar archive into native exec.

Start one container lazily per sandbox id, select the `lite` instance and Internet
access explicitly, restore the ten-minute inactivity timeout after object
restarts, and destroy immediately when the host releases the sandbox. Existing
Environment and Allocation admission stays authoritative. Remove the warm pool
and its cron configuration from the replacement. Native scheduling requires a new
Durable Object class and namespace. Deploy a separately named Worker and Container
application with `NativeSandbox`; never change the existing application's policy
or attach its old namespace to the replacement. The existing Worker remains
available until an operator drains and retires it.

## Consequences

Hosts keep the same provider injection and HTTP sandbox operations. Per-command
environment data replaces the old intermediate session routes. Package and shim
versions move together; Bun and Node in the image remain independently pinned.
Native scheduling has no legacy `max_instances` field. A provider URL cutover
requires draining/releasing existing allocations through the old provider and
preserving files that cannot be rebuilt. Neither Durable Object storage nor
container files move between namespaces; the old policy cannot transfer a
container snapshot. Hosts restart against the replacement URL and create fresh
allocations. Request signals are explicitly enabled on the Worker. Tests cover
the provider, lifetime cleanup and real local child-process cancellation without
credentialed Cloudflare calls.
