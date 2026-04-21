import type { DB } from "@catamorphic/db";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import { ProjectNotFoundError } from "./projects-service.js";

type RunRow = Selectable<DB["workflow_runs"]>;
type StepRow = Selectable<DB["workflow_run_steps"]>;

export type RunStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "cancelled";

export type StepStatus =
  | "pending"
  | "running"
  | "completed"
  | "failed"
  | "skipped";

export interface Run {
  id: string;
  projectId: string;
  workflowName: string;
  commitSha: string;
  isTest: boolean;
  status: RunStatus;
  triggerData: unknown;
  result: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
  createdAt: string;
}

export interface RunStep {
  id: string;
  runId: string;
  nodeId: string;
  name: string;
  status: StepStatus;
  input: unknown;
  output: unknown;
  error: string | null;
  startedAt: string | null;
  completedAt: string | null;
}

export interface RunDetail extends Run {
  steps: RunStep[];
}

export interface ListRunsInput {
  workflowName?: string;
  limit?: number;
  offset?: number;
}

export interface ListRunsResult {
  items: Run[];
  total: number;
}

export class RunNotFoundError extends Error {
  constructor(readonly runId: string) {
    super(`Run '${runId}' not found`);
    this.name = "RunNotFoundError";
  }
}

/**
 * Read-only view over `workflow_runs` + `workflow_run_steps`. Run creation +
 * execution currently lives in `PlaygroundExecutor` and the playground route;
 * a `trigger(...)` method is phase 2 (see plan).
 */
export class RunsService {
  constructor(private readonly db: Kysely<DB>) {}

  async get(identity: Identity, runId: string): Promise<RunDetail> {
    const run = await this.db
      .selectFrom("workflow_runs")
      .innerJoin("projects", "projects.id", "workflow_runs.project_id")
      .where("workflow_runs.id", "=", runId)
      .where("projects.tenant_id", "=", identity.tenantId)
      .selectAll("workflow_runs")
      .executeTakeFirst();

    if (!run) throw new RunNotFoundError(runId);

    const steps = await this.db
      .selectFrom("workflow_run_steps")
      .where("run_id", "=", runId)
      .selectAll()
      .orderBy("started_at", "asc")
      .execute();

    return { ...mapRun(run), steps: steps.map(mapStep) };
  }

  async list(
    identity: Identity,
    projectId: string,
    input: ListRunsInput = {},
  ): Promise<ListRunsResult> {
    await this.requireProject(identity, projectId);

    const limit = input.limit ?? 50;
    const offset = input.offset ?? 0;

    let query = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", projectId);

    if (input.workflowName) {
      query = query.where("workflow_name", "=", input.workflowName);
    }

    const rows = await query
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(limit)
      .offset(offset)
      .execute();

    let countQuery = this.db
      .selectFrom("workflow_runs")
      .where("project_id", "=", projectId);
    if (input.workflowName) {
      countQuery = countQuery.where("workflow_name", "=", input.workflowName);
    }
    const total = await countQuery
      .select((eb) => eb.fn.countAll<number>().as("count"))
      .executeTakeFirstOrThrow()
      .then((r) => Number(r.count));

    return { items: rows.map(mapRun), total };
  }

  private async requireProject(
    identity: Identity,
    projectId: string,
  ): Promise<void> {
    const row = await this.db
      .selectFrom("projects")
      .where("id", "=", projectId)
      .where("tenant_id", "=", identity.tenantId)
      .select("id")
      .executeTakeFirst();
    if (!row) throw new ProjectNotFoundError(projectId);
  }
}

function mapRun(row: RunRow): Run {
  return {
    id: row.id,
    projectId: row.project_id,
    workflowName: row.workflow_name,
    commitSha: row.commit_sha,
    isTest: row.is_test,
    status: row.status as RunStatus,
    triggerData: row.trigger_data,
    result: row.result,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
    createdAt: row.created_at.toISOString(),
  };
}

function mapStep(row: StepRow): RunStep {
  return {
    id: row.id,
    runId: row.run_id,
    nodeId: row.node_id,
    name: row.name,
    status: row.status as StepStatus,
    input: row.input,
    output: row.output,
    error: row.error,
    startedAt: row.started_at?.toISOString() ?? null,
    completedAt: row.completed_at?.toISOString() ?? null,
  };
}
