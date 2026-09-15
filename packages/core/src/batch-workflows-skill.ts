/** Paged processing guidance shipped as the existing batch-workflows skill. */
export const BATCH_WORKFLOWS_SKILL = `---
name: batch-workflows
description: Author persisted paged collections with Catamorphic defineBatch, per-item replay, physical batch steps, and idempotent sinks.
---

# Paged batch workflows

Use a batch scope for persisted per-item progress, bounded collection processing,
or resumable output. For a small array in one request, a loop in a boundary is
usually enough. Use \`writing-workflows\` for the enclosing workflow shape and
\`durable-workflows\` for ordinary boundary transitions.

## Three responsibilities

| Phase | Contract |
| --- | --- |
| \`source\` | Bind input to a source; initialize a snapshot/cursor and read bounded pages with stable unique keys. |
| \`process\` | Describe one item's computation. Ordinary step functions run per item; exported batch steps can coalesce compatible calls. |
| Optional \`sink\` | Persist terminal outcomes in retryable chunks, acknowledge written keys, and finalize an artifact. |

Import \`defineWorkflow\`, \`BatchSource\`, and any batching helpers from the host's
established wrapper or \`@catamorphic/workflow\`. \`defineBatch\` belongs to the
workflow builder; \`defineBatchStep\` is a package-level export. Do not create local
runtime copies or treat physical batch steps as separate workflows/checkpoints.

## Executable paging example

This small snapshot fixture makes paging and keyed outcomes testable. For a real
large source, replace the copied array with a stable remote snapshot/cursor; do
not load the entire dataset into workflow input. The normalizer illustrates the
batch-step contract; use physical batching only when the actual operation benefits.

\`\`\`typescript
import { type BatchSource, defineBatchStep, defineWorkflow, skipBatchItem } from "@catamorphic/workflow";

type RecordInput = { id: string; value: string };
type Config = { records: RecordInput[] };

export const recordsSource: BatchSource<Config, RecordInput, number, Config> = {
  consistency: "snapshot",
  async initialize({ config }) {
    return { snapshot: config, cursor: 0, estimatedCount: config.records.length };
  },
  async readPage({ snapshot, cursor = 0, limit }) {
    const page = snapshot.records.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      items: page.map((record) => ({ key: record.id, value: record })),
      nextCursor,
      done: nextCursor >= snapshot.records.length,
    };
  },
};

/**
 * @displayname Normalize records
 * @param record - @displayname Record | @description Record to normalize
 */
export const normalizeRecords = defineBatchStep<
  { record: RecordInput },
  { value: string }
>({
  batch: { maxItems: 50, maxWaitMs: 500, maxBytes: 128_000 },
  async run({ items }) {
    return items.map(({ key, value }) => ({
      key,
      status: "succeeded",
      result: { value: value.record.value.trim() },
    }));
  },
});

/**
 * @displayname Process records
 * @param records - @displayname Records | @description Snapshot with unique record ids
 */
export const processRecords = defineWorkflow(({ defineBatch }) => ({
  steps: [
    /** @displayname Normalize each record */
    defineBatch({
      source: ({ input }: { input: Config }) => ({ source: recordsSource, config: input }),
      process: async ({ item }: { key: string; item: RecordInput }) => {
        if (item.value.trim() === "") {
          skipBatchItem({ reason: "Record value is empty" });
        }
        return normalizeRecords({ record: item });
      },
    }),
  ],
}));
\`\`\`

## Replay and boundedness

- Choose the source's actual consistency: \`snapshot\`, \`bounded\`, or \`best_effort\`.
  Do not claim snapshot semantics for a changing live query without a snapshot.
- \`readPage\` must be a side-effect-free read. It can replay after a crash; do not
  mark records consumed or advance an external offset as a side effect of reading.
  Honor \`limit\`, supply a next cursor while \`done\` is false, and ensure it advances.
- Keys identify records across retries and pages. Reject duplicates in the source;
  do not use array offsets when a stable record id exists.
- Export physical batch steps so workers can address them by name. Call them only
  inside \`process\`; direct calls outside orchestration throw. Match results by key,
  never position. Return exactly one \`succeeded\`, \`failed\`, or \`skipped\` outcome per
  input key. Failed outcomes use \`error: { message, retryable }\`.
- Set \`maxItems\`, \`maxWaitMs\`, and optionally \`maxBytes\` to match the provider.
  Mark transient failures retryable; do not retry permanent business rejection.
  Completed step results replay when an item resumes. Keep keys and ordinary IO
  idempotent, and do not depend on process-local state surviving a resume.

## Sinks and verification

A sink implements \`writeBatch({ chunkKey, records, state, context })\` and
\`finalize({ state, summary, context })\`; \`initialize\` is optional. Records include
keyed outcomes, including failures and skips. Persist only intended outcomes and
acknowledge each durably handled key in \`acknowledgedKeys\`.

Use the destination's deduplication or an idempotency key derived from \`chunkKey\`
or the record's stable identity. A crash after a write but before acknowledgement
must not duplicate effects. Keep JSON state bounded: store a cursor or artifact
identifier instead of collecting every item key in memory. A sink threading state
is serial; \`concurrency > 1\` requires a stateless sink independent of chunk order.
\`finalize\` returns the artifact; it may also retry.

Verify empty input, page replay, the final partial page, duplicate keys, shuffled
outcomes, skipped/permanently failed items, retryable failures, and sink replay
as applicable. Preserve source identity and policies when editing an existing run's
replacement. Check and deploy a new revision through the normal lifecycle flow.
`;
