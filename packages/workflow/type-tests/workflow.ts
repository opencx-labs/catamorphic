import {
  type BatchFailurePolicy,
  type BatchOutput,
  type BoundaryContext,
  defineBatchStep,
  defineWorkflow,
  type WorkflowDefinition,
} from "../src/index.js";

type OrderInput = { orderId: string };
type PreparedOrder = { orderId: string; requestId: string };
type Approval = { approved: boolean };
type ApprovalState = { orderId: string; requestId: string };
type CompletedOrder = { orderId: string; completed: true };

const failurePolicy: BatchFailurePolicy = {
  mode: "continue",
  maxFailures: 10,
};
void failurePolicy;

interface InterfaceBatchInput {
  accountId: string;
}

defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      source: async ({ input }: { input: InterfaceBatchInput }) => ({
        config: { accountId: input.accountId },
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item,
    }),
  ],
}));

defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      failurePolicy: {
        mode: "fail_fast",
        // @ts-expect-error Batch failure policies reject unknown fields.
        reason: "invalid",
      },
      source: async ({ input }: { input: OrderInput }) => ({
        config: input,
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item,
    }),
  ],
}));

const childWorkflow = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<PreparedOrder>) => ({
        orderId: input.orderId,
        completed: true as const,
      }),
    }),
  ],
}));

const validWorkflow = defineWorkflow(({ defineBoundary }) => ({
  controls: { cancel: true },
  steps: [
    defineBoundary({
      retry: { maxAttempts: 3 },
      run: async ({ input }: BoundaryContext<OrderInput>) => ({
        orderId: input.orderId,
        requestId: `request-${input.orderId}`,
      }),
    }),
    defineBoundary({
      run: ({ input, pause }: BoundaryContext<PreparedOrder>) =>
        pause<Approval, ApprovalState>({
          timeout: "24h",
          state: input,
        }),
    }),
    defineBoundary({
      run: ({
        input,
        callWorkflow,
      }: BoundaryContext<
        | {
            reason: "resumed";
            value: Approval;
            state: ApprovalState;
          }
        | { reason: "timed_out"; state: ApprovalState }
      >) =>
        callWorkflow(childWorkflow, {
          input: {
            orderId: input.state.orderId,
            requestId: input.state.requestId,
          },
        }),
    }),
  ],
}));

const validAssignment: WorkflowDefinition<OrderInput, CompletedOrder> =
  validWorkflow;
void validAssignment;

const doubleItems = defineBatchStep({
  batch: { maxItems: 10, maxWaitMs: 100 },
  run: async ({
    items,
  }: {
    items: readonly { key: string; value: number }[];
  }) =>
    items.map(({ key, value }) => ({
      key,
      status: "succeeded" as const,
      result: value * 2,
    })),
});

const mixedWorkflow = defineWorkflow(({ defineBatch, defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ input }: BoundaryContext<{ accountId: string }>) => ({
        accountId: input.accountId,
        pageSize: 50,
      }),
    }),
    defineBatch({
      failurePolicy: { mode: "fail_fast" },
      source: async ({
        input,
      }: {
        input: { accountId: string; pageSize: number };
      }) => ({
        config: { accountId: input.accountId },
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { highWaterMark: 10 } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => doubleItems(item),
      sink: {
        initialize: async () => ({ written: 0 }),
        writeBatch: async ({ records }) => ({
          state: { written: records.length },
          acknowledgedKeys: records.map(({ key }) => key),
        }),
        finalize: async ({ state }) => ({
          url: `https://example.test/${state?.written ?? 0}.json`,
        }),
      },
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<BatchOutput<{ url: string }>>) => ({
        artifactUrl: input.artifact.url,
        total: input.summary.total,
      }),
    }),
  ],
}));

const mixedAssignment: WorkflowDefinition<
  { accountId: string },
  { artifactUrl: string; total: number }
> = mixedWorkflow;
void mixedAssignment;

const noSinkWorkflow = defineWorkflow(({ defineBatch, defineBoundary }) => ({
  steps: [
    defineBatch({
      source: async ({ input }: { input: { accountId: string } }) => ({
        config: input,
        source: {
          consistency: "bounded" as const,
          initialize: async () => ({ snapshot: { highWaterMark: 10 } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => ({ doubled: item * 2 }),
    }),
    defineBoundary({
      run: ({ input }: BoundaryContext<BatchOutput>) => input.summary,
    }),
  ],
}));

const noSinkAssignment: WorkflowDefinition<
  { accountId: string },
  { total: number; succeeded: number; failed: number; skipped: number }
> = noSinkWorkflow;
void noSinkAssignment;

defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      // @ts-expect-error Batch failure policy mode is checked.
      failurePolicy: { mode: "stop" },
      source: async ({ input }: { input: OrderInput }) => ({
        config: input,
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item,
    }),
  ],
}));

defineWorkflow(({ defineBatch }) => ({
  steps: [
    defineBatch({
      failurePolicy: {
        mode: "continue",
        // @ts-expect-error Batch maxFailures must be a number.
        maxFailures: "one",
      },
      source: async ({ input }: { input: OrderInput }) => ({
        config: input,
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item,
    }),
  ],
}));

defineWorkflow(({ defineBoundary }) =>
  // @ts-expect-error Step 1 returns a number, but step 2 requires a string.
  ({
    steps: [
      defineBoundary({
        run: ({ input }: BoundaryContext<OrderInput>) => input.orderId.length,
      }),
      defineBoundary({
        run: ({ input }: BoundaryContext<string>) => input.length,
      }),
    ],
  }),
);

defineWorkflow(({ defineBatch, defineBoundary }) =>
  // @ts-expect-error A batch summary does not satisfy the next boundary input.
  ({
    steps: [
      defineBatch({
        source: async ({ input }: { input: OrderInput }) => ({
          config: input,
          source: {
            consistency: "snapshot" as const,
            initialize: async () => ({ snapshot: { at: "now" } }),
            readPage: async () => ({ items: [], done: true }),
          },
        }),
        process: async ({ item }: { item: number }) => item,
      }),
      defineBoundary({
        run: ({ input }: BoundaryContext<{ value: string }>) => input.value,
      }),
    ],
  }),
);

defineWorkflow(({ defineBoundary }) => ({
  steps: [
    // @ts-expect-error Return callWorkflow(workflow, { input }) instead.
    defineBoundary({
      run: ({ input }: BoundaryContext<OrderInput>) =>
        input.orderId ? childWorkflow : childWorkflow,
    }),
  ],
}));

defineWorkflow(({ defineBoundary }) => ({
  steps: [
    // @ts-expect-error Date values are not JSON-compatible boundary inputs.
    defineBoundary({
      run: ({ input }: BoundaryContext<{ createdAt: Date }>) => ({
        createdAt: input.createdAt.toISOString(),
      }),
    }),
  ],
}));

defineWorkflow(({ defineBoundary }) => ({
  steps: [
    // @ts-expect-error Boundary outputs must be JSON-compatible.
    defineBoundary({
      run:
        ({ input }: BoundaryContext<OrderInput>) =>
        () =>
          input.orderId,
    }),
  ],
}));

defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: ({ callWorkflow }: BoundaryContext<OrderInput>) =>
        callWorkflow(childWorkflow, {
          // @ts-expect-error Child workflow input is checked at the call site.
          input: { orderId: "order-1" },
        }),
    }),
  ],
}));

defineWorkflow(({ defineBatch }) => ({
  steps: [
    // @ts-expect-error Batch source input must be JSON-compatible.
    defineBatch({
      source: async ({ input }: { input: { createdAt: Date } }) => ({
        config: { createdAt: input.createdAt.toISOString() },
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => item,
    }),
  ],
}));

defineWorkflow(({ defineBatch }) => ({
  steps: [
    // @ts-expect-error Batch process results must be JSON-compatible.
    defineBatch({
      source: async ({ input }: { input: OrderInput }) => ({
        config: input,
        source: {
          consistency: "snapshot" as const,
          initialize: async () => ({ snapshot: { at: "now" } }),
          readPage: async () => ({ items: [], done: true }),
        },
      }),
      process: async ({ item }: { item: number }) => new Date(item),
    }),
  ],
}));

defineWorkflow(() =>
  // @ts-expect-error Every workflow step must use a builder definition.
  ({
    steps: [async () => ({ done: true })],
  }),
);
