export const RUNTIME_HARNESS_SOURCE = `
const runId = process.env.CATAMORPHIC_RUN_ID ?? "";
const workflowName = process.env.CATAMORPHIC_WORKFLOW_NAME ?? "";
const workflowFile = process.env.CATAMORPHIC_WORKFLOW_FILE ?? "";
const triggerDataRaw = process.env.CATAMORPHIC_TRIGGER_DATA ?? "{}";

if (!runId || !workflowName || !workflowFile) {
  console.error(
    "Missing CATAMORPHIC_RUN_ID, CATAMORPHIC_WORKFLOW_NAME, or CATAMORPHIC_WORKFLOW_FILE",
  );
  process.exit(1);
}

const triggerData = JSON.parse(triggerDataRaw);
const stepLog = [];
const startedAt = new Date().toISOString();

globalThis.__catamorphicRunStep = async (nodeId, name, fn, input) => {
  const entry = {
    nodeId,
    name,
    status: "running",
    input,
    startedAt: new Date().toISOString(),
    completedAt: "",
  };
  stepLog.push(entry);
  try {
    const output = await fn(input);
    entry.status = "completed";
    entry.output = output;
    entry.completedAt = new Date().toISOString();
    return output;
  } catch (error) {
    entry.status = "failed";
    entry.error = error instanceof Error ? error.message : String(error);
    entry.completedAt = new Date().toISOString();
    throw error;
  }
};

function stringifyReport(report) {
  const seen = new WeakSet();
  return JSON.stringify(report, (_key, value) => {
    if (typeof value === "bigint") return value.toString();
    if (typeof value === "undefined") return null;
    if (value instanceof Error) {
      return { name: value.name, message: value.message, stack: value.stack };
    }
    if (typeof value === "object" && value !== null) {
      if (seen.has(value)) return "[Circular]";
      seen.add(value);
    }
    return value;
  });
}

function emit(report) {
  console.log("CATAMORPHIC_REPORT:" + stringifyReport(report));
}

function failRunningSteps(message) {
  const completedAt = new Date().toISOString();
  for (const entry of stepLog) {
    if (entry.status !== "running") continue;
    entry.status = "failed";
    entry.error = message;
    entry.completedAt = completedAt;
  }
}

async function run() {
  const path = await import("node:path");
  const modulePath = path.resolve(process.cwd(), workflowFile);
  const mod = await import(modulePath);
  const workflowFn = mod[workflowName];
  if (typeof workflowFn !== "function") {
    throw new Error("'" + workflowName + "' is not exported as a function");
  }

  const result = await workflowFn(triggerData);
  emit({
    runId,
    status: "completed",
    result,
    steps: stepLog,
    startedAt,
    completedAt: new Date().toISOString(),
  });
}

run().catch((error) => {
  failRunningSteps("Workflow ended before the step completed");
  emit({
    runId,
    status: "failed",
    error: error instanceof Error ? error.message : String(error),
    steps: stepLog,
    startedAt,
    completedAt: new Date().toISOString(),
  });
  process.exit(1);
});
`;
