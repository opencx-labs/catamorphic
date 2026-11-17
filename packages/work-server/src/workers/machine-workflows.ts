import type { CatamorphicCore } from "@catamorphic/core";
import type { Json } from "@catamorphic/db";
import { sql } from "kysely";
import {
  MachineProvisioningRefusedError,
  type MachineWorkflowRun,
  type MachineWorkflows,
} from "./machine-rules.js";

/** Who cancels a stuck create run, in its run history. */
const MACHINES_ACTOR = "work-machine-reconciler";

/**
 * `workflow` machine classes over core (ADR 0327): runs start through the
 * project's own enablement of the workflow, at its commit, in its
 * Environment and with what it was consented, as the project principal.
 * A member's enablement of the same workflow is never used.
 */
export class ProjectMachineWorkflows implements MachineWorkflows {
  constructor(
    private readonly deps: { core: CatamorphicCore; tenantId: string },
  ) {}

  async start(args: {
    project: string;
    workflow: string;
    kind: "machine.create" | "machine.destroy";
    input: Readonly<Record<string, unknown>>;
    correlationKey: string;
  }): Promise<void> {
    const { core } = this.deps;
    const enablement = await core.db
      .selectFrom("workflow_enablements as enablement")
      .innerJoin(
        "workflow_enablement_triggers as activation",
        "activation.enablement_id",
        "enablement.id",
      )
      .innerJoin(
        "trigger_definitions as definition",
        "definition.id",
        "activation.trigger_definition_id",
      )
      .select([
        "enablement.id",
        "enablement.commit_sha",
        "enablement.remote_branch",
        "enablement.environment_name",
        "enablement.owner_external_user_id",
        "activation.id as activation_id",
      ])
      .where("enablement.tenant_id", "=", this.deps.tenantId)
      .where("enablement.project_id", "=", args.project)
      .where("enablement.workflow_name", "=", args.workflow)
      .where("enablement.owner_kind", "=", "project")
      .where("enablement.status", "=", "active")
      .where(({ or, eb }) =>
        or([
          eb("enablement.expires_at", "is", null),
          eb("enablement.expires_at", ">", sql<Date>`now()`),
        ]),
      )
      .where("activation.status", "=", "active")
      .where("definition.trigger_kind", "=", args.kind)
      .orderBy("enablement.updated_at", "desc")
      .executeTakeFirst();
    if (!enablement)
      throw new MachineProvisioningRefusedError(
        `Project ${args.project} has no automation ${args.workflow} bound to ${args.kind} turned on for the project`,
      );
    const payload: Json = JSON.parse(JSON.stringify(args.input));
    const fired = await core.triggers.dispatchAtCommit({
      identity: {
        tenantId: this.deps.tenantId,
        externalUserId: enablement.owner_external_user_id ?? "",
      },
      projectId: args.project,
      commitSha: enablement.commit_sha,
      remoteBranch: enablement.remote_branch,
      environment: enablement.environment_name,
      kind: args.kind,
      payload,
      enablementIds: [enablement.id],
      activationIds: [enablement.activation_id],
      workflows: [args.workflow],
      mode: "async",
      correlationKey: args.correlationKey,
      onConflict: "ignore",
    });
    if (fired.runs.length === 0)
      throw new MachineProvisioningRefusedError(
        `Workflow ${args.workflow} did not start for ${args.kind}`,
      );
  }

  async latest(args: {
    project: string;
    workflow: string;
    correlationKey: string;
  }): Promise<MachineWorkflowRun | undefined> {
    const runs = this.deps.core.db
      .selectFrom("workflow_runs as run")
      .innerJoin(
        "workflow_enablements as enablement",
        "enablement.id",
        "run.workflow_enablement_id",
      )
      .where("run.project_id", "=", args.project)
      .where("run.workflow_name", "=", args.workflow)
      .where("run.correlation_key", "=", args.correlationKey)
      // Only the project's automation answers for its machines.
      .where("enablement.owner_kind", "=", "project");
    const run = await runs
      .select([
        "run.status",
        "run.result",
        "run.error",
        "run.cancel_reason",
        sql<number>`(extract(epoch from (now() - run.created_at)) * 1000)::float8`.as(
          "age_ms",
        ),
        sql<number>`(extract(epoch from (now() - coalesce(run.completed_at, run.updated_at))) * 1000)::float8`.as(
          "ended_for_ms",
        ),
      ])
      .orderBy("run.created_at", "desc")
      .limit(1)
      .executeTakeFirst();
    if (!run) return undefined;
    if (run.status === "completed")
      return { status: "completed", output: run.result };
    if (run.status === "failed" || run.status === "canceled") {
      const failed = await runs
        .select(sql<number>`count(*)::int`.as("count"))
        .where("run.status", "in", ["failed", "canceled"])
        .executeTakeFirst();
      return {
        status: "failed",
        error: run.error ?? run.cancel_reason ?? `the run was ${run.status}`,
        endedForMs: Number(run.ended_for_ms),
        failures: Number(failed?.count ?? 1),
      };
    }
    return { status: "active", ageMs: Number(run.age_ms) };
  }

  async cancel(args: {
    project: string;
    workflow: string;
    correlationKey: string;
    reason: string;
  }): Promise<void> {
    // The server acting as itself: no member's scope narrows it.
    await this.deps.core.runs.cancelByKey({
      identity: {
        tenantId: this.deps.tenantId,
        externalUserId: MACHINES_ACTOR,
      },
      projectId: args.project,
      workflowName: args.workflow,
      correlationKey: args.correlationKey,
      reason: args.reason,
    });
  }

  async record(args: {
    project: string;
    event: {
      source: string;
      kind: string;
      externalId: string;
      occurredAt: string;
      payload: { [key: string]: Json | undefined };
    };
  }): Promise<void> {
    await this.deps.core.projectEvents.append({
      projectId: args.project,
      ...args.event,
    });
  }
}
