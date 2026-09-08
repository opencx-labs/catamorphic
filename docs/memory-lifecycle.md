# Memory ownership and limits

Hosts can stay open for days and projects can be parent directories containing
large repositories. Reading a workflow graph must not snapshot those repositories
or load media files. Workflow and trigger readers select TypeScript and workspace
manifests before reading contents. Working-copy snapshots respect hierarchical
Git ignores, retain tracked files, and can exclude nested repositories.

Bulk project snapshots read eight files at a time. Defaults are 8 MiB per file
and 64 MiB per snapshot, configurable through `FileReadOptions`. Native checkout
text snapshots keep their existing selection of UTF-8 files up to 2 MiB; binary
files remain available through the byte APIs. Oversized reads
fail explicitly; files are never silently truncated. Historical Git reads still
depend on the Git backend to materialize an individual blob before the snapshot
budget can be checked. Diff readers compare object IDs before reading contents.

Resource owners release failed MCP connections, terminal window listeners,
stopped sandbox environments, stopped worker handles, and removed profile
watchers and clients. Runtime records belong to their physical sandbox and are
released when it stops or is destroyed. Concurrent runtime starts share one
pending operation. Supervisor event writes apply transport backpressure instead
of growing an unchecked promise queue.

Agent runtime event delivery uses one replay window per session, with defaults of
2,048 events and 2 MiB, configurable with `eventBuffer`. A slow or reconnecting
subscriber whose cursor expired receives an error and must replay the host's
persisted events before resubscribing. Subscription abort and iterator return
stop delivery independently of the session. Stopping a session releases its live
state; only the latest 16 stopped replay windows remain available.

Supervisor receipts have a 32 MiB aggregate retention budget alongside the
existing count limit. Individual invocations have an 8 MiB input/event/output
budget. Queue admission and event subscriber counts are bounded. Oversized
invocations fail explicitly rather than losing replay events. Prepared workflow
sources have a 64 MiB aggregate cache budget; catalog caches expire and are
bounded by count and bytes.

Guest app clients accept `{ signal, requestTimeoutMs }`. The default host response
deadline is five minutes. Aborting a call releases the guest's pending state and
does not cancel a workflow on its host. For durable waits, use `start()` and
`run.result({ signal })`; each poll has its own response deadline. Pending guest
requests are capped at 128 and each request payload at 1 MiB.

Regression tests exercise repeated create/stop/remove cycles, failed discovery,
late connection completion, expired cursors, slow subscribers, cache eviction,
and sparse large files. They use mocks or temporary repositories and do not
require starting Electron or a server. The full repository merge gate runs in CI.
