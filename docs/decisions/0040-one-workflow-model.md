# 0040 — One workflow model

## Status

Accepted. Supersedes [0013](0013-test-and-production-run-modes.md) (test and
production run modes).

## Context

Since ADR 0001 there were two ways to author a workflow: an exported async
function carrying the exact `"use workflow"` directive, and an exported
`defineWorkflow(({ defineBoundary, defineBatch }) => ({ steps: [...] }))`
value. ADR 0026 unified them into one public Workflow and Run model, but the
split survived underneath as two parser paths, two execution shapes, two sets
of docs and examples, and a `test`/`production` run-mode discriminator: plain
functions could run against the author's mutable dev tree via a dedicated
`test-runs` endpoint, while defineWorkflow workflows required a deployed
commit and rejected test triggering with a capability error.

The original justification for plain functions — a cheap request-response
form that runs "as normal code" — stopped being structural once ADR 0039's
sync trigger-firing path landed: any workflow now runs inline in the caller's
request until its first durable wait, so a workflow with no pause, retry
backoff, rate-limit deferral, batch scope, or child call settles inline
regardless of how it was authored. Meanwhile every newer surface leaned the
other way: trigger bindings (`triggers: [trigger(...)]`) parse only from
defineWorkflow, the app contract exposes typed workflow entries, and static
introspection (`canSuspend`, capabilities, graphs) is computed from the
builder structure. Plain workflows were the odd form out, and test runs were
the only reason runs had modes at all.

## Decision

**There is one authoring form and one provenance rule: every workflow is an
exported `defineWorkflow` value, and every run executes a deployed commit.**

- Plain `"use workflow"` functions are removed from the parser, the execution
  transform, the runtime, and all docs and templates. `"use step"` functions
  survive as the home of IO and business operations, called from boundary
  `run` bodies and batch `process` callbacks.
- Mutable-source test runs are removed with them: the `POST
  /projects/:id/workflows/:name/test-runs` endpoint, `runs.triggerTest`, the
  test-secret split, and the `mode` discriminator are gone. Migration
  history deleted the dev-only test-run rows (greenfield) and dropped
  `workflow_runs.mode`; that final shape is now part of the first-release
  baseline accepted by ADR 0084. Provenance is uniform: every run records the
  deployed commit and artifact it executed.
- Inline request-response is a property of execution, not an authoring form.
  The sync trigger-firing path (ADR 0039) runs any workflow inline until its
  first durable wait; the parser's `canSuspend` tells embedders statically
  which workflows are guaranteed to settle inline.
- The app contract collapses to a single `Workflow<T>` type from
  `@catamorphic/app` (replacing the `PlainWorkflow<T>` / `DurableWorkflow<T>`
  pair of ADR 0037). The generated client exposes both invocation shapes on
  every entry: `.call(input)` waits for the terminal output — a workflow with
  no pause, retry, rate-limit, batch, or child settles inline — and
  `.start(input)` returns a pollable run handle (`poll()`, `result()`).
- `WorkflowCapabilities` loses `persistedContinuation` — every workflow has
  it — and is now `{ batchProcessing, cancellation }`.
- Version bumps make the break explicit end to end: the runtime supervisor
  protocol is v8 (`RUNTIME_PROTOCOL_VERSION = 8`) and the execution
  transform is v4 (`EXECUTION_TRANSFORM_VERSION = "execution-transform-v4"`),
  so stale deployment artifacts rebuild rather than half-run.

Keeping plain functions as sugar that compiles to a single boundary was
rejected: it preserves the double documentation surface and the "which form
am I reading" question without buying any capability the one-boundary
defineWorkflow spelling lacks. Keeping test runs for defineWorkflow was
rejected because a persisted-continuation run against a mutable tree cannot
be resumed honestly once the tree changes — the deploy step is what makes a
run's provenance and its continuation coherent.

## Consequences

- One parser path, one execution transform, one set of examples. Editor
  iteration is "deploy, then run" — deploys are cheap commits, and the sync
  path keeps short workflows request-response fast.
- ADR 0013 is superseded. ADRs 0001, 0015, 0026, 0027, 0036, 0037, and 0039
  carry pointwise wording updates where they described plain functions or
  test runs; their decisions otherwise stand.
- Docs and skills that taught "plain first, defineWorkflow when you need
  continuation" now teach one model: boundaries hold orchestration, steps
  hold IO, batches hold collections.
