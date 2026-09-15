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
with earlier inputs.

## Return one transition

\`pause\`, \`callWorkflow\`, \`documents\`, \`host\`, and \`connections\` are boundary
capabilities. Return a transition directly from the callback. Do not await it,
wrap it in a \`"use step"\` helper, invoke multiple transitions in one boundary,
or put it inside \`Promise.all\`. Its resolved result becomes the next boundary's
input. Ordinary step IO can still be awaited before returning a transition.

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
