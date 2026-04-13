export interface SampleProject {
  name: string;
  description: string;
  files: Record<string, string>;
  defaultWorkflow: string;
}

const SHARED_PACKAGE_JSON = ({ name }: { name: string }) => `{
  "name": "${name}",
  "version": "1.0.0",
  "private": true,
  "type": "module"
}`;

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

export const SAMPLE_PROJECTS: Record<string, SampleProject> = {
  "welcome-user": {
    name: "Welcome New User",
    description: "Onboard a new user with welcome email and follow-up",
    defaultWorkflow: "welcomeUser",
    files: {
      "package.json": SHARED_PACKAGE_JSON({ name: "welcome-user" }),
      "tsconfig.json": SHARED_TSCONFIG,
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

function sleep(duration: string) {}
`,
    },
  },

  "order-processing": {
    name: "Order Processing",
    description:
      "Process an e-commerce order with parallel fulfillment and notifications",
    defaultWorkflow: "processOrder",
    files: {
      "package.json": SHARED_PACKAGE_JSON({ name: "order-processing" }),
      "tsconfig.json": SHARED_TSCONFIG,
      "src/process-order.ts": `/**
 * @displayname Process Order
 * @description Process an e-commerce order end-to-end with payment, fulfillment, and notifications
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

  const [shipment, invoice] = await Promise.all([
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

/**
 * @displayname Validate Order
 * @icon shield
 * @param orderId - @displayname Order ID | @description Unique order identifier
 * @param items - @displayname Items | @description List of item IDs in the order
 */
async function validateOrder({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { orderId, items, total: 750, valid: true };
}

/**
 * @displayname Flag for Review
 * @icon search
 */
async function flagForReview({ orderId, reason }: { orderId: string; reason: string }) {
  "use step";
}

/**
 * @displayname Charge Payment
 * @icon zap
 * @param orderId - @displayname Order ID
 * @param amount - @displayname Amount | @description Payment amount in cents
 */
async function chargePayment({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { status: "success", transactionId: "txn_123" };
}

/**
 * @displayname Create Shipment
 * @icon globe
 */
async function createShipment({ orderId, items }: { orderId: string; items: string[] }) {
  "use step";
  return { trackingId: "TRACK_123" };
}

/**
 * @displayname Notify Warehouse
 * @icon truck
 */
async function notifyWarehouse({ shipmentId }: { shipmentId: string }) {
  "use step";
}

/**
 * @displayname Generate Invoice
 * @icon file
 */
async function generateInvoice({ orderId, amount }: { orderId: string; amount: number }) {
  "use step";
  return { invoiceUrl: "https://example.com/invoice/123" };
}

/**
 * @displayname Update Inventory
 * @icon database
 * @param itemId - @displayname Item ID
 * @param delta - @displayname Quantity Change | @description Positive to add, negative to subtract
 */
async function updateInventory({ itemId, delta }: { itemId: string; delta: number }) {
  "use step";
}

/**
 * @displayname Notify Customer
 * @icon bell
 */
async function notifyCustomer({ customerId, message }: { customerId: string; message: string }) {
  "use step";
}

function sleep(duration: string) {}
`,
    },
  },

  "data-pipeline": {
    name: "Data Sync Pipeline",
    description:
      "ETL pipeline with parallel extraction, transformation, and loading",
    defaultWorkflow: "dataSyncPipeline",
    files: {
      "package.json": SHARED_PACKAGE_JSON({ name: "data-pipeline" }),
      "tsconfig.json": SHARED_TSCONFIG,
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

function sleep(duration: string) {}
`,
      "src/steps/extract.ts": `/**
 * @displayname Extract from Source
 * @icon database
 * @param source - @displayname Data Source | @description Source system identifier
 * @param format - @displayname Format | @description Data format (json, csv, parquet)
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
 * @param datasets - @displayname Datasets | @description List of dataset names to transform
 * @param rules - @displayname Rules | @description Comma-separated transformation rules
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

  "support-routing": {
    name: "Support Ticket Routing",
    description:
      "Route incoming support tickets based on priority with nested branching",
    defaultWorkflow: "routeSupportTicket",
    files: {
      "package.json": SHARED_PACKAGE_JSON({ name: "support-routing" }),
      "tsconfig.json": SHARED_TSCONFIG,
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

  /** @displayname Ticket Details */
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

/**
 * @displayname Look Up Ticket
 * @icon search
 * @param ticketId - @displayname Ticket ID | @description The support ticket identifier
 */
async function lookupTicket({ ticketId }: { ticketId: string }) {
  "use step";
  return { id: ticketId, priority: "critical", subject: "Server down", isVIP: true, customerId: "cust_1" };
}

/**
 * @displayname Escalate to Manager
 * @icon alert-triangle
 * @param ticketId - @displayname Ticket ID
 * @param reason - @displayname Reason | @description Why the ticket is being escalated
 */
async function escalateToManager({ ticketId, reason }: { ticketId: string; reason: string }) {
  "use step";
}

/**
 * @displayname Assign Dedicated Agent
 * @icon star
 * @param ticketId - @displayname Ticket ID
 */
async function assignDedicatedAgent({ ticketId }: { ticketId: string }) {
  "use step";
}

/**
 * @displayname Notify Account Manager
 * @icon bell
 * @param ticketId - @displayname Ticket ID
 */
async function notifyAccountManager({ ticketId }: { ticketId: string }) {
  "use step";
}

/**
 * @displayname Add to Escalation Queue
 * @icon alert-circle
 * @param ticketId - @displayname Ticket ID
 */
async function addToEscalationQueue({ ticketId }: { ticketId: string }) {
  "use step";
}

/**
 * @displayname Assign to Senior
 * @icon user-check
 * @param ticketId - @displayname Ticket ID
 */
async function assignToSenior({ ticketId }: { ticketId: string }) {
  "use step";
}

/**
 * @displayname Add to Queue
 * @icon inbox
 * @param ticketId - @displayname Ticket ID
 * @param queue - @displayname Queue Name | @description Target queue for the ticket
 */
async function addToQueue({ ticketId, queue }: { ticketId: string; queue: string }) {
  "use step";
}

/**
 * @displayname Send Acknowledgment
 * @icon mail
 * @param to - @displayname Recipient Email
 * @param ticketId - @displayname Ticket ID
 */
async function sendAcknowledgment({ to, ticketId }: { to: string; ticketId: string }) {
  "use step";
}
`,
    },
  },
};

export function findWorkflowFile({
  files,
  workflowName,
}: {
  files: Record<string, string>;
  workflowName: string;
}): string | null {
  for (const [path, content] of Object.entries(files)) {
    if (!path.endsWith(".ts") && !path.endsWith(".tsx")) continue;
    const fnPattern = new RegExp(
      `(?:export\\s+)?async\\s+function\\s+${workflowName}\\s*\\(`,
    );
    if (fnPattern.test(content) && content.includes('"use workflow"')) {
      return path;
    }
  }
  return null;
}
