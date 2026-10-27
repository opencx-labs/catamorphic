/** Agent guidance; shipped through the existing skill discovery surfaces. */
export const DURABLE_WORKFLOWS_SKILL = `---
name: durable-workflows
description: Design Catamorphic boundary retries and returned transitions for pauses, child workflows, host calls, documents, and brokered connections.
---

# Durable workflow boundaries

Use \`writing-workflows\` for the basic definition shape. This skill covers what
persists between invocations and how to continue after a transition. Every run
uses an immutable deployed revision; editing source does not change a running
workflow. Import the host's established wrapper or \`@catamorphic/workflow\`.

## Persistence and side effects

A boundary is one retry unit. If an attempt fails, every ordinary operation in
that callback can run again. A \`"use step"\` helper is not a separate checkpoint,
and an external write is not undone. Use stable business idempotency keys or
an idempotent destination. Split boundaries when independent continuation or
retry behavior is needed, not merely to add visual nodes.

Boundary inputs, outputs, pause state/values, and child inputs/outputs must be
JSON-compatible. Carry ids and data across boundaries, not resources or functions.
The output of one boundary becomes the next input; it does not implicitly merge
with earlier inputs. A returned call can carry state across, below.

## Attempt deadlines and cancellation

A boundary attempt has one five-minute budget from its persisted start. Its
callback and returned host, documents, or connection operation share that
absolute deadline. A recovered execution job retains it; a boundary-policy
retry starts a new attempt. Admission waiting happens before the clock starts.
A durable pause or child wait holds no execution timer after the boundary returns.

Host functions receive \`signal\` and the ISO \`deadlineAt\` in their first
context argument. Connection providers receive them with the invocation. Pass
\`signal\` into SDK/HTTP requests (for example \`fetch(url, { signal })\` or
an AWS SDK call's \`{ abortSignal: signal }\`) and check it before effects.
Cancellation and lease loss are observed through the existing job heartbeat;
worker shutdown aborts directly. The host stops awaiting an uncooperative async
provider, but it cannot preempt synchronous code or undo an accepted external
write. Late results cannot complete a canceled or superseded attempt.

Long cloud jobs should return their resource id promptly, then wait through
ordinary pauses, callbacks, or bounded polls. Use resource ledgers, idempotency
keys, and independent reconciliation for cleanup and uncertain external effects.

## Return one transition

\`pause\`, \`callWorkflow\`, \`documents\`, \`host\`, and \`connections\` are boundary
capabilities. Return a transition directly from the callback. Do not await it,
wrap it in a \`"use step"\` helper, invoke multiple transitions in one boundary,
or put it inside \`Promise.all\`. Its resolved result becomes the next boundary's
input, or with \`{ state }\` its \`result\` beside that state. Ordinary step IO
can still be awaited before returning a transition.

- \`pause\` retains optional state and waits for explicit resumption. With a
  timeout it resolves to \`reason: "resumed" | "timed_out"\`; handle both.
- \`callWorkflow(child, { input })\` invokes a static child definition and resolves
  to its output. Never return the definition itself or construct it inside \`run\`.
- Documents, host calls, and brokered connections execute under host-authorized
  access. \`caller\` is stamped by the host, never inferred from workflow input.
  Do not manufacture caller identity. Retrying an operation can reissue it;
  follow that capability's idempotency contract.
- Session calls are described by \`session-workflows\`, including queued remote
  receipts. A queued receipt is not proof the target action has completed.

## Approval with timeout and a child call

This executable example assumes an approval request has already been created.
Only an explicit positive approval invokes the child. The child records a result;
replace its body with the intended idempotent business operation.

\`\`\`typescript
import { type BoundaryContext, type PauseResult, defineWorkflow } from "@catamorphic/workflow";

type Order = { orderId: string; requestId: string };
type Approval = { approved: boolean };

/** @displayname Record approved order */
export const finishOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    /** @displayname Record approval */
    defineBoundary({
      run: ({ input }: BoundaryContext<Order>) => ({
        orderId: input.orderId,
        status: "approved",
      }),
    }),
  ],
}));

/** @displayname Wait for order approval */
export const approveOrder = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    /** @displayname Await approval */
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<Order>) =>
        pause<Approval, Order>({ timeout: "24h", state: input }),
    }),
    /** @displayname Apply approval decision */
    defineBoundary({
      run: ({ input, callWorkflow }: BoundaryContext<PauseResult<Approval, Order>>) => {
        if (input.reason === "timed_out") {
          return { orderId: input.state.orderId, status: "timed_out" };
        }
        if (!input.value.approved) {
          return { orderId: input.state.orderId, status: "rejected" };
        }
        return callWorkflow(finishOrder, { input: input.state });
      },
    }),
  ],
}));
\`\`\`

A pause without a timeout has no automatic timeout result. Cancellation is a
separate authenticated terminal control, declared with \`controls: { cancel: true }\`.
Do not invent \`context.cancel()\` or a cancelled \`PauseResult\` branch.

## Carry state across a call

A call's result alone reaches the next boundary. To keep what the call does
not return (the trigger's ids, a parsed plan, an earlier read), pass
\`{ state }\` as its second argument: the next boundary receives
\`{ result, state }\`, typed \`Carried<Result, State>\`. Every returned call
takes it: \`connections.*\`, \`host.*\`, \`documents.*\`, and
\`callWorkflow(child, { input, state })\`, as \`pause\` takes \`state\`. State is
JSON (checked at the call), at most 256 KiB, persisted with the run, and a
retried step runs the call again with the same state; any other key in that
argument is refused. Carry ids and the data later steps use, not whole
responses.

\`\`\`typescript
import { type BoundaryContext, type Carried, defineWorkflow } from "@catamorphic/workflow";

type Order = { orderId: string; customer: string };

/** @displayname Brief an order's customer */
export const briefOrder = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    /** @displayname Read the customer's notes */
    defineBoundary({
      run: ({ input, documents }: BoundaryContext<Order>) =>
        documents.read({ path: "store/customers/" + input.customer + "/notes.md" }, { state: input }),
    }),
    /** @displayname Write the brief */
    defineBoundary({
      run: ({ input, documents }: BoundaryContext<Carried<{ path: string; text?: string }, Order>>) =>
        documents.write({
          path: "store/orders/" + input.state.orderId + "/brief.md",
          text: "Order " + input.state.orderId + "\\n\\n" + (input.result.text ?? "").slice(0, 2000),
        }),
    }),
  ],
}));
\`\`\`

## Retry policy and diagnostics

Set \`retry: { maxAttempts: 3, backoff: { initial: "1s", maximum: "30s", multiplier: 2 } }\`
on a boundary when retries fit the operation. Bound IO timeouts separately.
Transient failures can justify retry; business rejection usually belongs in an
explicit result branch. Preserve a mutation's key across attempts.

Check the project's actual package version and generated types before working
around a missing export. Update a dependency to the host's supported version if
needed; never copy runtime helpers or silence type errors.

| Diagnostic | Correction |
| --- | --- |
| Boundary N resolves to a value that N+1 does not accept | Compare the resolved output with the next \`BoundaryContext<Input>\`, including every pause or child-result branch. |
| Input/output must be JSON-compatible | Replace non-persistable values with ids or JSON data. |
| Return callWorkflow instead of a workflow definition | Return \`callWorkflow(child, { input })\` from the boundary. |
| Unknown input or recursive inference | Annotate the callback's \`BoundaryContext<Input>\`; do not add generics to \`defineWorkflow\` as a workaround. |
| Trigger payload rejected by the first scope | Match the generated trigger payload and refresh its types through the host. |

Fix the earliest mismatch first; later errors often cascade. Validate with the
project checker, then exercise resumption, timeout/rejection, retries, and any
terminal control used by the workflow. See \`batch-workflows\` for per-item replay.
`;
