import type { RunHandle, RunStatus, RuntimeAdapter } from "./types.js";

/**
 * Placeholder adapter for Vercel Workflow SDK with Postgres World.
 * Will be implemented when @workflow/world-postgres is integrated.
 */
export class VercelWorkflowAdapter implements RuntimeAdapter {
  private connectionString: string;

  constructor({ connectionString }: { connectionString: string }) {
    this.connectionString = connectionString;
  }

  async startRun({
    workflowId,
    code,
    triggerData,
  }: {
    workflowId: string;
    code: string;
    triggerData: unknown;
  }): Promise<RunHandle> {
    // TODO: integrate with Vercel Workflow SDK + graphile-worker
    throw new Error(
      `Not yet implemented. Would start workflow ${workflowId} with code length ${code.length} and trigger ${JSON.stringify(triggerData)} using ${this.connectionString}`,
    );
  }

  async getRun({ runId }: { runId: string }): Promise<RunStatus> {
    throw new Error(`Not yet implemented. Would get run ${runId}`);
  }

  async listRuns({ workflowId }: { workflowId: string }): Promise<RunStatus[]> {
    throw new Error(`Not yet implemented. Would list runs for ${workflowId}`);
  }

  async cancelRun({ runId }: { runId: string }): Promise<void> {
    throw new Error(`Not yet implemented. Would cancel run ${runId}`);
  }
}
