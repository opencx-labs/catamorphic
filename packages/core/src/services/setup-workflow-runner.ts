import type { DB, Json } from "@catamorphic/db";
import type { Kysely } from "kysely";
import type { RunCoordinator } from "./run-coordinator.js";
import type { RunsService } from "./runs-service.js";
import type { SetupWorkflowOutcome } from "./workspace-setup.js";

/** How often a preparation looks at its setup run. */
const POLL_MS = 500;

/**
 * Run an Environment's setup workflow for one chat (ADR 0324) and wait for
 * it: through the workflow's active project enablement, so it runs as the
 * project with exactly the connections and permissions consented there
 * (ADRs 0068, 0158). A workflow no one enabled for the project fails the
 * setup, saying so. A run still going at the timeout, or when the turn
 * stops, is canceled.
 */
export async function runSetupWorkflow(input: {
  db: Kysely<DB>;
  runs: RunsService;
  coordinator: RunCoordinator;
  tenantId: string;
  projectId: string;
  workflowName: string;
  /** The chat and workspace build it sets up, stamped on the run. */
  setupFor: { sessionId: string; build: string };
  input: Json;
  timeoutMs: number;
  signal: AbortSignal;
}): Promise<SetupWorkflowOutcome> {
  const enablement = await input.db
    .selectFrom("workflow_enablements")
    .select(["id", "owner_external_user_id"])
    .where("tenant_id", "=", input.tenantId)
    .where("project_id", "=", input.projectId)
    .where("workflow_name", "=", input.workflowName)
    .where("owner_kind", "=", "project")
    .where("status", "=", "active")
    .orderBy("created_at", "desc")
    .executeTakeFirst();
  if (!enablement)
    return {
      status: "failed",
      timedOut: false,
      error: `The setup workflow ${input.workflowName} is not enabled for this project. Enable it as a project automation, so it runs with the permissions consented there.`,
    };
  const identity = {
    tenantId: input.tenantId,
    externalUserId: enablement.owner_external_user_id ?? "",
  };
  const run = await input.runs.triggerSetupRun({
    identity,
    projectId: input.projectId,
    workflowName: input.workflowName,
    input: input.input,
    enablementId: enablement.id,
    setupFor: input.setupFor,
  });
  const deadline = Date.now() + input.timeoutMs;
  const cancel = (reason: string) =>
    input.coordinator
      .cancel({ identity, runId: run.id, reason })
      .catch(() => undefined);
  for (;;) {
    const row = await input.db
      .selectFrom("workflow_runs")
      .select(["status", "error"])
      .where("id", "=", run.id)
      .executeTakeFirstOrThrow();
    if (row.status === "completed") return { status: "succeeded" };
    if (row.status === "failed" || row.status === "canceled")
      return {
        status: "failed",
        timedOut: false,
        error: `The setup workflow's run ${run.id} ${row.status === "canceled" ? "was canceled" : "failed"}${row.error ? `: ${row.error}` : ""}`,
      };
    if (input.signal.aborted) {
      await cancel("The turn it set up for stopped");
      return { status: "aborted" };
    }
    if (Date.now() >= deadline) {
      await cancel("Setup timed out");
      return {
        status: "failed",
        timedOut: true,
        error: `The setup workflow's run ${run.id} did not finish in time and was canceled.`,
      };
    }
    await new Promise<void>((resolve) => {
      const timer = setTimeout(resolve, POLL_MS);
      input.signal.addEventListener(
        "abort",
        () => {
          clearTimeout(timer);
          resolve();
        },
        { once: true },
      );
    });
  }
}
