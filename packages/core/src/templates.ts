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

const pkg = (name: string) =>
  JSON.stringify(
    { name, version: "1.0.0", private: true, type: "module" },
    null,
    2,
  );

/**
 * Per-project agent skills seeded into every project (templates and blank
 * ones alike). Skills live in the project repo under
 * `.agents/skills/<name>/SKILL.md` (Agent Skills spec) so they are versioned
 * with the code, scoped per project, and discovered by coding agents (e.g.
 * Flue) from the dev sandbox checkout.
 */
export const SEED_SKILLS: Record<string, string> = {
  ".agents/skills/writing-workflows/SKILL.md": `---
name: writing-workflows
description: How to write and edit Catamorphic workflows in this project. Use when creating a new workflow, adding steps, or restructuring workflow logic.
---

# Writing Workflows

Workflows are plain TypeScript functions marked with the \`"use workflow"\`
directive and exported from files under \`src/\`. Steps are async functions
marked with \`"use step"\`.

Rules:

1. Every workflow and step takes a **single destructured object parameter**.
2. Every workflow, step, and parameter has JSDoc metadata with a
   \`@displayname\` (short action phrases for steps, descriptive labels for
   parameters).
3. Keep workflow bodies simple and linear: awaited step calls, \`if\`/\`else\`
   branches, \`for\` loops, and \`Promise.all\` for parallel work. The visual
   graph is derived from this structure.
4. Steps do the real work (API calls, DB access). Workflows only orchestrate.

Example:

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
`,
};

export const TEMPLATES: ProjectTemplate[] = [
  {
    id: "welcome-user",
    name: "Welcome New User",
    description: "Onboard a new user with welcome email and follow-up",
    defaultWorkflow: "welcomeUser",
    files: {
      "package.json": pkg("welcome-user"),
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
      "package.json": pkg("order-processing"),
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
      "package.json": pkg("data-pipeline"),
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
      "package.json": pkg("support-routing"),
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
];

export function findTemplate(id: string): ProjectTemplate | undefined {
  return TEMPLATES.find((t) => t.id === id);
}
