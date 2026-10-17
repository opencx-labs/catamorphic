import type { ApiClient } from "./deps.js";

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * A module's `work.call` (ADR 0234): run a project workflow and wait for
 * its output, under the run's own authorization and audit. A plain fetch,
 * as the React hooks run workflows: the client cannot infer a body that
 * mixes recursive JSON with siblings.
 */
export async function callProjectWorkflow({
  apiClient,
  projectId,
  workflow,
  input,
}: {
  apiClient: ApiClient;
  projectId: string;
  workflow: string;
  input: unknown;
}): Promise<unknown> {
  const response = await apiClient.fetch(
    `${apiClient.baseUrl}/api/projects/${encodeURIComponent(projectId)}/workflows/${encodeURIComponent(workflow)}/calls`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // Inside the two minutes main gives Work to answer a module.
      body: JSON.stringify({ input: input ?? {}, budgetMs: 100_000 }),
    },
  );
  const outcome: unknown = await response.json().catch(() => null);
  if (!response.ok || !isRecord(outcome))
    throw new Error(
      isRecord(outcome) && typeof outcome.error === "string"
        ? outcome.error
        : `Could not run ${workflow}.`,
    );
  if (outcome.status === "failed")
    throw new Error(
      typeof outcome.error === "string" ? outcome.error : `${workflow} failed.`,
    );
  if (outcome.status === "suspended")
    throw new Error(
      `${workflow} is waiting (run ${String(outcome.runId)}); a source needs a workflow that finishes.`,
    );
  return outcome.output;
}
