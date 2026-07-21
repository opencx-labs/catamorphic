import { WORKFLOW_PACKAGE_VERSION } from "@catamorphic/workflow";

export interface ProjectTemplate {
  id: string;
  name: string;
  description: string;
  defaultWorkflow: string;
  files: Record<string, string>;
}

const SHARED_TSCONFIG = `{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "esModuleInterop": true,
    "noEmit": true
  },
  "include": ["src"]
}`;

const pkg = ({
  name,
  dependencies,
}: {
  name: string;
  dependencies?: Record<string, string>;
}) =>
  JSON.stringify(
    {
      name,
      version: "1.0.0",
      private: true,
      type: "module",
      ...(dependencies ? { dependencies } : {}),
    },
    null,
    2,
  );

export const BATCH_WORKFLOW_SKILL_PATH =
  ".agents/skills/batch-workflows/SKILL.md";

/**
 * Per-project agent skills seeded into every project (templates and blank
 * ones alike). Skills live in the project repo under
 * `.agents/skills/<name>/SKILL.md` (Agent Skills spec) so they are versioned
 * with the code, scoped per project, and read by coding agents from the dev
 * sandbox checkout.
 */
export const SEED_SKILLS: Record<string, string> = {
  ".agents/skills/writing-workflows/SKILL.md": `---
name: writing-workflows
description: Writes and edits regular and batch Catamorphic workflows. Use when creating workflows, adding steps, changing workflow logic, or choosing between single-run and durable item processing.
---

# Writing Workflows

## Determine the workflow kind first

Inspect the existing export before editing it and preserve its kind unless the
user explicitly requests a conversion.

- **Regular workflow:** an exported async function containing
  \`"use workflow"\`. Use for one request, event, entity, or orchestration run.
- **Batch workflow:** an exported \`defineBatchWorkflow({ source, process,
  sink? })\`. Use for many durable items that need paging, bounded concurrency,
  physical batching, retries, progress, pause/resume, or resumable output.

Do not add \`"use workflow"\` to a batch definition. Do not wrap a regular
workflow in \`defineBatchWorkflow\` merely to process an array supplied in one
request.

## Shared rules

1. Every workflow and step takes one destructured object parameter.
2. Every UI-facing workflow, step, and parameter has JSDoc metadata with
   \`@displayname\`; steps may also use \`@icon\`.
3. Keep orchestration code simple: awaited calls, \`if\`/\`else\`, loops, and
   \`Promise.all\`. The visual graph is derived from this structure.
4. Put IO and business operations in steps. Keep workflow bodies declarative.

## Regular workflows

\`\`\`typescript
/**
 * @displayname Greet User
 * @description Send a greeting to a user
 */
export async function greetUser({ email }: { email: string }) {
  "use workflow";
  await sendGreeting({ to: email });
  return { status: "sent" };
}

/**
 * @displayname Send Greeting
 * @icon mail
 * @param to - @displayname Recipient | @description Email address to send to
 */
async function sendGreeting({ to }: { to: string }) {
  "use step";
}
\`\`\`

## Batch workflows

Read [the batch workflow skill](../batch-workflows/SKILL.md) before creating or
substantially editing a batch workflow.

Key rules:

- The source emits stable, unique item keys and uses a durable cursor.
- \`process\` describes one logical item. Regular \`"use step"\` calls still
  execute per item.
- Use an exported \`defineBatchStep\` only when an operation benefits from
  physically coalescing multiple items. Return exactly one keyed outcome for
  every input key.
- Batch-step failures declare whether they are retryable. Never depend on input
  order when matching outcomes.
- Sinks must tolerate retries, acknowledge keys, and finalize from persisted
  state.
- Use \`skipBatchItem({ reason })\` for intentionally ignored items.
- Preserve source keys, replay behavior, and existing batch policies when
  editing.
`,
  [BATCH_WORKFLOW_SKILL_PATH]: `---
name: batch-workflows
description: Creates and edits durable Catamorphic batch workflows with paged sources, per-item processing, physical batch steps, retries, and idempotent sinks. Use when a workflow handles many items or mentions batches, bulk processing, imports, exports, backfills, or large collections.
---

# Batch Workflows

## Authoring contract

Inspect the project's imports and \`package.json\` before adding a batch
workflow:

- If the host provides a workflow wrapper package, import only the primitives
  that wrapper exposes.
- Otherwise add \`@catamorphic/workflow\` as an explicit dependency and import
  the primitives from it.
- Never create or copy a local \`src/batch.ts\` implementation.

A batch workflow has three phases:

1. \`source\` binds trigger input to a paged source.
2. \`process\` describes one logical item and may suspend at exported batch
   steps.
3. \`sink\` optionally writes terminal item outcomes in idempotent chunks and
   returns a final artifact.

## Workflow skeleton

\`\`\`typescript
import {
  defineBatchStep,
  defineBatchWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";

interface RecordInput {
  id: string;
  value: string;
}

const recordsSource = {
  consistency: "snapshot",
  async initialize({ config }: { config: { prefix?: string } }) {
    return {
      snapshot: { capturedAt: new Date().toISOString() },
      cursor: 0,
      estimatedCount: undefined,
    };
  },
  async readPage({
    cursor = 0,
    limit,
  }: {
    cursor?: number;
    limit: number;
  }) {
    const records: readonly RecordInput[] = [];
    const page = records.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      items: page.map((record) => ({ key: record.id, value: record })),
      nextCursor,
      done: nextCursor >= records.length,
    };
  },
};

/**
 * @displayname Enrich Records
 * @icon sparkles
 */
export const enrichRecords = defineBatchStep<
  { record: RecordInput },
  { enrichedValue: string }
>({
  batch: { maxItems: 50, maxWaitMs: 500, maxBytes: 128_000 },
  async run({ items }) {
    return items.map(({ key, value }) => ({
      key,
      status: "succeeded",
      result: { enrichedValue: value.record.value.trim() },
    }));
  },
});

const resultSink = {
  async initialize() {
    const writtenKeys: readonly string[] = [];
    return { writtenKeys };
  },
  async writeBatch({ records, state = { writtenKeys: [] } }) {
    const acknowledgedKeys = records.map((record) => record.key);
    return {
      state: {
        writtenKeys: [...new Set([...state.writtenKeys, ...acknowledgedKeys])],
      },
      acknowledgedKeys,
    };
  },
  async finalize({ state = { writtenKeys: [] }, summary }) {
    return { writtenKeys: state.writtenKeys, summary };
  },
};

/**
 * @displayname Process Records
 * @description Process a durable collection of records
 */
export const processRecords = defineBatchWorkflow({
  source: ({ input }: { input: { prefix?: string } }) => ({
    source: recordsSource,
    config: { prefix: input.prefix },
  }),
  process: async ({ item }: { key: string; item: RecordInput }) => {
    if (item.value.trim() === "") {
      skipBatchItem({ reason: "Record value is empty" });
    }
    return enrichRecords({ record: item });
  },
  sink: resultSink,
});
\`\`\`

## Source rules

- \`initialize\` captures a stable snapshot and initial cursor.
- \`readPage\` honors \`limit\`, returns stable keys, and advances the cursor.
- If \`done\` is false, return a next cursor.
- Never use array indexes as keys when the source has a durable identifier.

## Batch-step rules

- Export every \`defineBatchStep\`; workers target the export by name.
- \`maxItems\` bounds cohort size, \`maxWaitMs\` bounds collection delay, and
  \`maxBytes\` bounds serialized input size.
- Return one outcome per input key: \`succeeded\`, \`failed\`, or \`skipped\`.
- Mark transient failures \`retryable: true\`; permanent failures should not be
  retried.
- Keep outputs deterministic for the same item attempt. The coordinator replays
  completed steps when resuming an item.

## Sink rules

- Treat \`writeBatch\` as retryable and idempotent.
- Deduplicate by item key or chunk key before producing external side effects.
- Return every durably written key in \`acknowledgedKeys\`.
- Keep sink state JSON-serializable.
- \`finalize\` returns the artifact shown to the host application.
`,
};

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "welcome-user",
    name: "Welcome New User",
    description: "Onboard a new user with welcome email and follow-up",
    defaultWorkflow: "welcomeUser",
    files: {
      "package.json": pkg({ name: "welcome-user" }),
      "tsconfig.json": SHARED_TSCONFIG,
      ...SEED_SKILLS,
      "src/welcome.ts": `/**
 * @displayname Welcome New User
 * @description Onboard a new user with welcome email and follow-up
 */
export async function welcomeUser({
  email,
  name,
}: {
  email: string;
  name: string;
}) {
  "use workflow";

  const user = await createUser({ email, name });
  await sendWelcomeEmail({ to: user.email, name: user.name });

  if (user.plan === "premium") {
    await assignPremiumBenefits({ userId: user.id });
  }

  await sleep("7 days");
  await sendFollowUpEmail({ to: user.email });

  return { status: "complete", userId: user.id };
}

/**
 * @displayname Create User
 * @icon user-plus
 * @param email - @displayname Email Address | @description The user's primary email
 * @param name - @displayname Full Name | @description The user's display name
 */
async function createUser({ email, name }: { email: string; name: string }) {
  "use step";
  return { id: "usr_1", email, name, plan: "premium" };
}

/**
 * @displayname Send Welcome Email
 * @icon mail
 */
async function sendWelcomeEmail({ to, name }: { to: string; name: string }) {
  "use step";
}

/**
 * @displayname Assign Premium Benefits
 * @icon crown
 */
async function assignPremiumBenefits({ userId }: { userId: string }) {
  "use step";
}

/**
 * @displayname Send Follow-up Email
 * @icon mail
 */
async function sendFollowUpEmail({ to }: { to: string }) {
  "use step";
}

function sleep(_duration: string) {}
`,
    },
  },
  {
    id: "order-processing",
    name: "Order Processing",
    description:
      "Process an e-commerce order with parallel fulfillment and notifications",
    defaultWorkflow: "processOrder",
    files: {
      "package.json": pkg({ name: "order-processing" }),
      "tsconfig.json": SHARED_TSCONFIG,
      ...SEED_SKILLS,
      "src/process-order.ts": `/**
 * @displayname Process Order
 * @description Process an e-commerce order end-to-end
 */
export async function processOrder({
  orderId,
  items,
  customerId,
}: {
  orderId: string;
  items: string[];
  customerId: string;
}) {
  "use workflow";

  const order = await validateOrder({ orderId, items });

  if (order.total > 500) {
    await flagForReview({ orderId, reason: "High value order" });
    await sleep("30 minutes");
  }

  const payment = await chargePayment({ orderId, amount: order.total });

  if (payment.status === "failed") {
    await notifyCustomer({ customerId, message: "Payment failed" });
    return { status: "payment_failed", orderId };
  }

  const [shipment] = await Promise.all([
    (async () => {
      const shipResult = await createShipment({ orderId, items });
      await notifyWarehouse({ shipmentId: shipResult.trackingId });
      return shipResult;
    })(),
    generateInvoice({ orderId, amount: order.total }),
  ]);

  for (const item of items) {
    await updateInventory({ itemId: item, delta: -1 });
  }

  await notifyCustomer({ customerId, message: "Order shipped!" });
  return { status: "complete", orderId, trackingId: shipment.trackingId };
}

/** @displayname Validate Order @icon shield */
async function validateOrder({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { orderId, items, total: 750, valid: true };
}

/** @displayname Flag for Review @icon search */
async function flagForReview({ orderId, reason }: { orderId: string; reason: string }) {
  "use step";
}

/** @displayname Charge Payment @icon zap */
async function chargePayment({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { status: "success", transactionId: "txn_123" };
}

/** @displayname Create Shipment @icon globe */
async function createShipment({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { trackingId: "TRACK_123" };
}

/** @displayname Notify Warehouse @icon truck */
async function notifyWarehouse({ shipmentId }: { shipmentId: string }) {
  "use step";
}

/** @displayname Generate Invoice @icon file */
async function generateInvoice({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { invoiceUrl: "https://example.com/invoice/123" };
}

/** @displayname Update Inventory @icon database */
async function updateInventory({ itemId, delta }: { itemId: string; delta: number }) {
  "use step";
}

/** @displayname Notify Customer @icon bell */
async function notifyCustomer({ customerId, message }: { customerId: string; message: string }) {
  "use step";
}

function sleep(_duration: string) {}
`,
    },
  },
  {
    id: "data-pipeline",
    name: "Data Sync Pipeline",
    description:
      "ETL pipeline with parallel extraction, transformation, and loading",
    defaultWorkflow: "dataSyncPipeline",
    files: {
      "package.json": pkg({ name: "data-pipeline" }),
      "tsconfig.json": SHARED_TSCONFIG,
      ...SEED_SKILLS,
      "src/pipeline.ts": `import { extractFromSource } from "./steps/extract";
import { validateSchema, transformData } from "./steps/transform";
import { loadToDatabase, verifySync } from "./steps/load";
import { acquireLock, releaseLock, sendAlert } from "./steps/infra";

/**
 * @displayname Data Sync Pipeline
 * @description Extract, transform, and load data from multiple sources in parallel
 */
export async function dataSyncPipeline({
  sources,
  targetDb,
}: {
  sources: string[];
  targetDb: string;
}) {
  "use workflow";

  await acquireLock({ resource: targetDb });

  const [usersData, ordersData, productsData] = await Promise.all([
    extractFromSource({ source: "users-api", format: "json" }),
    extractFromSource({ source: "orders-db", format: "csv" }),
    extractFromSource({ source: "products-s3", format: "parquet" }),
  ]);

  for (const source of sources) {
    await validateSchema({ source, strict: true });
  }

  const transformed = await transformData({
    datasets: ["users", "orders", "products"],
    rules: "deduplicate,normalize,enrich",
  });

  if (transformed.errors > 0) {
    await sendAlert({ channel: "slack", message: "Transform errors detected" });
  }

  await loadToDatabase({ targetDb, batchSize: 1000 });
  await sleep("5 minutes");
  await verifySync({ targetDb, expectedCount: transformed.rowCount });
  await releaseLock({ resource: targetDb });

  return { status: "synced", rows: transformed.rowCount };
}

function sleep(_duration: string) {}
`,
      "src/steps/extract.ts": `/**
 * @displayname Extract from Source
 * @icon database
 */
export async function extractFromSource({ source, format }: { source: string; format: string }) {
  "use step";
  return { rows: 10000, source };
}
`,
      "src/steps/transform.ts": `/**
 * @displayname Validate Schema
 * @icon shield
 */
export async function validateSchema({ source, strict }: { source: string; strict: boolean }) {
  "use step";
}

/**
 * @displayname Transform Data
 * @icon code
 */
export async function transformData({ datasets, rules }: { datasets: string[]; rules: string }) {
  "use step";
  return { rowCount: 25000, errors: 0 };
}
`,
      "src/steps/load.ts": `/**
 * @displayname Load to Database
 * @icon database
 */
export async function loadToDatabase({ targetDb, batchSize }: { targetDb: string; batchSize: number }) {
  "use step";
}

/**
 * @displayname Verify Sync
 * @icon shield
 */
export async function verifySync({ targetDb, expectedCount }: { targetDb: string; expectedCount: number }) {
  "use step";
}
`,
      "src/steps/infra.ts": `/**
 * @displayname Acquire Lock
 * @icon settings
 */
export async function acquireLock({ resource }: { resource: string }) {
  "use step";
}

/**
 * @displayname Release Lock
 * @icon settings
 */
export async function releaseLock({ resource }: { resource: string }) {
  "use step";
}

/**
 * @displayname Send Alert
 * @icon bell
 */
export async function sendAlert({ channel, message }: { channel: string; message: string }) {
  "use step";
}
`,
    },
  },
  {
    id: "support-routing",
    name: "Support Ticket Routing",
    description:
      "Route incoming support tickets based on priority with nested branching",
    defaultWorkflow: "routeSupportTicket",
    files: {
      "package.json": pkg({ name: "support-routing" }),
      "tsconfig.json": SHARED_TSCONFIG,
      ...SEED_SKILLS,
      "src/route-ticket.ts": `/**
 * @displayname Route Support Ticket
 * @description Route incoming support tickets to the right team based on priority level
 */
export async function routeSupportTicket({
  ticketId,
  priority,
  customerEmail,
}: {
  ticketId: string;
  priority: string;
  customerEmail: string;
}) {
  "use workflow";

  const ticket = await lookupTicket({ ticketId });

  if (ticket.priority === "critical") {
    await escalateToManager({ ticketId: ticket.id, reason: "Critical priority" });

    if (ticket.isVIP) {
      await assignDedicatedAgent({ ticketId: ticket.id });
      await notifyAccountManager({ ticketId: ticket.id });
    } else {
      await addToEscalationQueue({ ticketId: ticket.id });
    }
  } else if (ticket.priority === "high") {
    await assignToSenior({ ticketId: ticket.id });
  } else {
    await addToQueue({ ticketId: ticket.id, queue: "general" });
  }

  await sendAcknowledgment({ to: customerEmail, ticketId: ticket.id });
  return { status: "routed", ticketId: ticket.id };
}

/** @displayname Look Up Ticket @icon search */
async function lookupTicket({ ticketId }: { ticketId: string }) {
  "use step";
  return { id: ticketId, priority: "critical", subject: "Server down", isVIP: true, customerId: "cust_1" };
}

/** @displayname Escalate to Manager @icon alert-triangle */
async function escalateToManager({ ticketId, reason }: { ticketId: string; reason: string }) {
  "use step";
}

/** @displayname Assign Dedicated Agent @icon star */
async function assignDedicatedAgent({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Notify Account Manager @icon bell */
async function notifyAccountManager({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Add to Escalation Queue @icon alert-circle */
async function addToEscalationQueue({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Assign to Senior @icon user-check */
async function assignToSenior({ ticketId }: { ticketId: string }) {
  "use step";
}

/** @displayname Add to Queue @icon inbox */
async function addToQueue({ ticketId, queue }: { ticketId: string; queue: string }) {
  "use step";
}

/** @displayname Send Acknowledgment @icon mail */
async function sendAcknowledgment({ to, ticketId }: { to: string; ticketId: string }) {
  "use step";
}
`,
    },
  },
  {
    id: "customer-feedback-analysis",
    name: "Customer Feedback Analysis",
    description:
      "Analyze seeded customer feedback in durable batches and produce a summary artifact",
    defaultWorkflow: "analyzeCustomerFeedback",
    files: {
      "package.json": pkg({
        name: "customer-feedback-analysis",
        dependencies: {
          "@catamorphic/workflow": WORKFLOW_PACKAGE_VERSION,
        },
      }),
      "tsconfig.json": SHARED_TSCONFIG,
      ...SEED_SKILLS,
      "src/customer-feedback.ts": `import {
  type BatchConsistency,
  defineBatchStep,
  defineBatchWorkflow,
  skipBatchItem,
} from "@catamorphic/workflow";

interface Feedback {
  id: string;
  rating: number;
  comment: string;
}

interface NormalizedFeedback extends Feedback {
  normalizedComment: string;
}

interface FeedbackAnalysis {
  sentiment: "positive" | "neutral" | "negative";
  topic: "product" | "support" | "pricing";
}

const COMMENTS: readonly string[] = [
  "The product is fast and delightful.",
  "Support took too long to reply.",
  "Great value for the price.",
  "The product works as expected.",
  "Pricing is confusing and expensive.",
  "Support solved my issue immediately.",
];

const FEEDBACK_SOURCE_CONSISTENCY: BatchConsistency = "snapshot";

const SEEDED_FEEDBACK: readonly Feedback[] = Array.from(
  { length: 320 },
  (_, index) => ({
    id: \`fb-\${String(index + 1).padStart(3, "0")}\`,
    rating: (index % 5) + 1,
    comment: index > 0 && index % 79 === 0 ? "" : COMMENTS[index % COMMENTS.length] ?? "",
  }),
);

const feedbackSource = {
  consistency: FEEDBACK_SOURCE_CONSISTENCY,
  async initialize({
    config,
  }: {
    config: { minimumRating: number };
  }) {
    const matching = SEEDED_FEEDBACK.filter(
      (feedback) => feedback.rating >= config.minimumRating,
    );
    return {
      snapshot: { highWaterMark: matching.length },
      cursor: 0,
      estimatedCount: matching.length,
    };
  },
  async readPage({
    config,
    snapshot,
    cursor = 0,
    limit,
  }: {
    config: { minimumRating: number };
    snapshot: { highWaterMark: number };
    cursor?: number;
    limit: number;
  }) {
    const matching = SEEDED_FEEDBACK.filter(
      (feedback) => feedback.rating >= config.minimumRating,
    ).slice(0, snapshot.highWaterMark);
    const page = matching.slice(cursor, cursor + limit);
    const nextCursor = cursor + page.length;
    return {
      items: page.map((feedback) => ({
        key: feedback.id,
        value: feedback,
      })),
      nextCursor,
      done: nextCursor >= matching.length,
    };
  },
};

/**
 * @displayname Classify Feedback
 * @icon messages-square
 */
export const classifyFeedback = defineBatchStep<
  { feedback: NormalizedFeedback },
  FeedbackAnalysis
>({
  batch: { maxItems: 32, maxWaitMs: 250, maxBytes: 64_000 },
  async run({ items }) {
    return items.map(({ key, value, attempt }) => {
      if (key === "fb-042" && attempt === 1) {
        return {
          key,
          status: "failed",
          error: {
            message: "Seeded transient classifier failure",
            retryable: true,
          },
        };
      }
      const text = value.feedback.normalizedComment;
      const sentiment =
        value.feedback.rating >= 4
          ? "positive"
          : value.feedback.rating <= 2
            ? "negative"
            : "neutral";
      const topic = text.includes("support")
        ? "support"
        : text.includes("price") || text.includes("pricing")
          ? "pricing"
          : "product";
      return { key, status: "succeeded", result: { sentiment, topic } };
    });
  },
});

const summarySink = {
  async initialize() {
    const results: { key: string; sentiment: string; topic: string }[] = [];
    return { results };
  },
  async writeBatch({
    records,
    state = { results: [] },
  }: {
    records: readonly {
      key: string;
      outcome: {
        status: string;
        result?: FeedbackAnalysis;
      };
    }[];
    state?: {
      results: { key: string; sentiment: string; topic: string }[];
    };
  }) {
    const written = records.flatMap((record) =>
      record.outcome.status === "succeeded" && record.outcome.result
        ? [{ key: record.key, ...record.outcome.result }]
        : [],
    );
    const retained = state.results.filter(
      (result) => !written.some((candidate) => candidate.key === result.key),
    );
    return {
      state: { results: [...retained, ...written] },
      acknowledgedKeys: records.map((record) => record.key),
    };
  },
  async finalize({
    state = { results: [] },
    summary,
  }: {
    state?: {
      results: { key: string; sentiment: string; topic: string }[];
    };
    summary: {
      total: number;
      succeeded: number;
      failed: number;
      skipped: number;
    };
  }) {
    const rows = state.results.map(
      (result) =>
        \`\${result.key},\${result.sentiment},\${result.topic}\`,
    );
    return {
      fileName: "customer-feedback-analysis.csv",
      contentType: "text/csv",
      content: ["key,sentiment,topic", ...rows].join("\\n"),
      summary,
    };
  },
};

/**
 * @displayname Analyze Customer Feedback
 * @description Classify seeded customer feedback in efficient physical batches
 */
export const analyzeCustomerFeedback = defineBatchWorkflow({
  source: ({
    input,
  }: {
    input: { minimumRating?: number };
  }) => ({
    source: feedbackSource,
    config: { minimumRating: input.minimumRating ?? 1 },
  }),
  process: async ({
    item,
  }: {
    key: string;
    item: Feedback;
  }) => {
    const validation = await validateFeedback({ feedback: item });
    if (!validation.valid) {
      skipBatchItem({ reason: validation.reason });
    }
    const normalized = await normalizeFeedback({ feedback: item });
    return classifyFeedback({ feedback: normalized });
  },
  sink: summarySink,
});

/**
 * @displayname Validate Feedback
 * @icon badge-check
 * @param feedback - @displayname Customer Feedback | @description Seeded feedback to validate
 */
async function validateFeedback({
  feedback,
}: {
  feedback: Feedback;
}): Promise<{ valid: true } | { valid: false; reason: string }> {
  "use step";
  if (feedback.comment.trim() === "") {
    return { valid: false, reason: "Feedback comment is empty" };
  }
  return { valid: true };
}

/**
 * @displayname Normalize Feedback
 * @icon wand-sparkles
 * @param feedback - @displayname Customer Feedback | @description Raw seeded feedback record
 */
async function normalizeFeedback({
  feedback,
}: {
  feedback: Feedback;
}): Promise<NormalizedFeedback> {
  "use step";
  return {
    ...feedback,
    normalizedComment: feedback.comment.trim().toLowerCase(),
  };
}
`,
    },
  },
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
