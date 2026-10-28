import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  sql,
  type Transaction,
} from "kysely";
import {
  type Identity,
  identityCovers,
  isProjectPrincipal,
  mayUseProject,
  projectPrincipalIdentity,
} from "../identity.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import {
  AuthenticationRequiredError,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
} from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import {
  admissionPolicy,
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  EnvironmentPolicyInvalidError,
  type ExecutionEnvironmentsService,
  placementOwner,
} from "./execution-environments-service.js";
import type {
  PlacementWaitsService,
  PlacementWaitTarget,
} from "./placement-waits.js";
import type { RunCoordinator } from "./run-coordinator.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";

const tracer = getTracer("@catamorphic/core");

/**
 * How long after its lease lapsed a disposable node counts as lost. A
 * process whose lease lapsed can never renew it; the grace gives it time to
 * notice and stop before its work starts elsewhere. A node that released
 * its lease on stop needs none.
 */
export const LOST_NODE_GRACE_MS = 30_000;

/** What one recovery pass did (ADR 0190). */
export interface NodeRecoveryResult {
  /** Lost nodes examined. */
  nodes: number;
  /** Workflow runs given a new Allocation on a live machine. */
  movedRuns: number;
  /** Workflow runs failed because their Environment can no longer place them. */
  failedRuns: number;
  /** Chats whose workspace was released; their next turn is admitted again. */
  releasedChats: number;
  /** Runs waiting for a machine to come online or free a slot. */
  waitingRuns: number;
  /** Lost nodes deleted once none of their work was left on them. */
  deletedNodes: number;
}

type AllocationRow = Selectable<DB["execution_allocations"]>;
type RunOutcome =
  | "moved"
  | "failed"
  | "waiting"
  | "released"
  | "skipped"
  | "stuck";

/**
 * Reconciles workflow placement across durable waits (ADR 0289), and
 * recovers the work of disposable nodes that are gone for good (ADR 0190):
 * a control-plane replica that stopped, or whose lease lapsed past the
 * grace period, never registers again. Any host may run a pass; row locks
 * on each Allocation and node keep two passes from acting twice.
 *
 * - A workflow run gets a new Allocation in its own Environment on a live
 *   machine. Its sandbox is rebuilt there from the deployed artifact and its
 *   step journal carries on; a step whose outcome was uncertain behaves as
 *   after a restart on the same machine.
 * - A chat's Allocation is released with reason `node_lost`; its next turn
 *   is admitted again and restores the workspace from its session branch
 *   (ADR 0173).
 * - Allocation-scoped deployment runtimes and connection grants go with the
 *   released Allocation, and the node row is deleted once nothing active is
 *   left on it, which returns its capacity.
 */
export class NodeRecoveryService {
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      environments: ExecutionEnvironmentsService;
      allocations: ExecutionAllocationsService;
      coordinator: RunCoordinator;
      connections?: ConnectionAdmissionService;
      waits: PlacementWaitsService;
      /**
       * A member's identity as the host resolves it now, or null when they
       * may no longer act (ADR 0053): the same resolver unattended work uses.
       */
      resolveOwner: (args: {
        tenantId: string;
        projectId: string;
        externalUserId: string;
      }) => Promise<Identity | null>;
    },
  ) {}

  /**
   * Reconcile physical placement with durable work (ADR 0289). Called after
   * jobs settle and on the worker's maintenance pass, so a crashed worker
   * cannot leave an idle reservation or a resumed root stranded.
   */
  async reconcileWorkflowWaits(
    args: { runId?: string; limit?: number } = {},
  ): Promise<void> {
    await withSpan(
      { tracer, name: "workflow.reconcile_wait_capacity", attributes: {} },
      async () => {
        const selected = args.runId
          ? await this.deps.db
              .selectFrom("workflow_runs")
              .select("allocation_id")
              .where("id", "=", args.runId)
              .executeTakeFirst()
          : undefined;
        if (args.runId && !selected?.allocation_id) return;
        const rows = await this.deps.db
          .selectFrom("execution_allocations as allocation")
          .innerJoin(
            "workflow_runs as root",
            "root.id",
            "allocation.root_workload_id",
          )
          .leftJoin(
            "placement_waits as wait",
            "wait.root_workload_id",
            "root.id",
          )
          .selectAll("allocation")
          .whereRef("root.allocation_id", "=", "allocation.id")
          .where("root.status", "in", [
            "pending",
            "running",
            "waiting",
            "paused",
          ])
          .where("allocation.workload_kind", "=", "workflow")
          .$if(selected?.allocation_id !== undefined, (query) =>
            query.where("allocation.id", "=", selected?.allocation_id ?? ""),
          )
          .where(
            sql<boolean>`NOT EXISTS (${allocationJobs(this.deps.db, "allocation.id").where("job.status", "=", "running")})`,
          )
          .where(
            sql<boolean>`NOT EXISTS (${this.deps.db
              .selectFrom("active_run_invocations as invocation")
              .innerJoin(
                "workflow_runs as run",
                "run.id",
                "invocation.workflow_run_id",
              )
              .select("invocation.invocation_id")
              .where("run.allocation_id", "=", sql<string>`allocation.id`)})`,
          )
          .where(sql<boolean>`(
            (allocation.status = 'active' AND allocation.worker_node_id IS NOT NULL AND NOT EXISTS (${runnableAllocationJobs(this.deps.db, "allocation.id")})) OR
            (allocation.status = 'released' AND allocation.release_reason = 'idle'
              AND (allocation.worker_node_id IS NULL OR allocation.capacity_released_at IS NOT NULL)
              AND EXISTS (${runnableAllocationJobs(this.deps.db, "allocation.id")}))
          )`)
          .where((eb) =>
            eb.or([
              eb("wait.retry_at", "is", null),
              eb("wait.retry_at", "<=", sql<Date>`now()`),
            ]),
          )
          .orderBy("wait.last_tried_at", (order) => order.asc().nullsFirst())
          .orderBy("allocation.created_at")
          .limit(args.limit ?? 100)
          .execute();
        const failures: unknown[] = [];
        for (const allocation of rows) {
          try {
            if (allocation.status === "active")
              await this.parkRun({ allocation });
            else await this.readmitRun({ allocation });
          } catch (error) {
            failures.push(error);
          }
        }
        if (failures.length)
          throw new AggregateError(
            failures,
            "Workflow capacity reconciliation failed",
          );
      },
    );
  }

  private async parkRun(args: { allocation: AllocationRow }): Promise<void> {
    const { allocation } = args;
    await this.deps.db.transaction().execute(async (trx) => {
      if (!(await lockWorkflowAllocation({ trx, allocation }))) return;
      // Job claimers take a share lock on this Allocation. With its exclusive
      // lock held, no new compute can pass the fence after this check.
      const work = await workflowAllocationWork({
        trx,
        allocationId: allocation.id,
      });
      if (work.running || work.runnable || work.invocations) return;
      await trx
        .updateTable("execution_allocations")
        .set({
          status: "released",
          release_reason: "idle",
          released_at: sql`now()`,
        })
        .where("id", "=", allocation.id)
        .where("status", "=", "active")
        .execute();
      await trx
        .updateTable("connection_capability_grants")
        .set({ revoked_at: sql`now()` })
        .where("allocation_id", "=", allocation.id)
        .where("revoked_at", "is", null)
        .execute();
    });
  }

  private async readmitRun(args: { allocation: AllocationRow }): Promise<void> {
    const { allocation } = args;
    if (allocation.worker_node_id && !allocation.capacity_released_at) return;
    const root = await this.deps.db
      .selectFrom("workflow_runs")
      .selectAll()
      .where("id", "=", allocation.root_workload_id)
      .executeTakeFirst();
    if (!root?.external_user_id || root.allocation_id !== allocation.id) return;
    const work = await workflowAllocationWork({
      trx: this.deps.db,
      allocationId: allocation.id,
    });
    if (!work.runnable || work.running || work.invocations) return;
    const fail = async (error: string) => {
      await this.deps.db.transaction().execute(async (trx) => {
        if (!(await lockWorkflowAllocation({ trx, allocation }))) return;
        await this.deps.coordinator.failRunTree({
          runId: root.id,
          error: `The workflow cannot resume: ${error}`,
          trx,
        });
      });
    };
    const mechanics: Identity = {
      tenantId: allocation.tenant_id,
      externalUserId: root.external_user_id,
    };
    const previous = await this.deps.allocations.get({
      identity: mechanics,
      allocationId: allocation.id,
    });
    if (!previous) return;
    // A host-issued root is deliberately outside membership resolution. A
    // project automation keeps its original consent, never its enabler's grants.
    const identity = isProjectPrincipal(root.external_user_id)
      ? projectPrincipalIdentity({
          tenantId: allocation.tenant_id,
          projectId: allocation.project_id,
          environment: allocation.environment_name,
          workflowName: root.workflow_name,
          connections: previous.policy.connections,
          permissions: Array.isArray(root.caller_project_permissions)
            ? root.caller_project_permissions.flatMap((value) =>
                typeof value === "object" &&
                value !== null &&
                !Array.isArray(value) &&
                typeof value.permission === "string"
                  ? [value.permission]
                  : [],
              )
            : [],
        })
      : root.caller_scope === null
        ? mechanics
        : await this.deps.resolveOwner({
            ...mechanics,
            projectId: allocation.project_id,
          });
    if (
      !identity ||
      identity.tenantId !== mechanics.tenantId ||
      identity.externalUserId !== mechanics.externalUserId ||
      !mayUseProject(identity, allocation.project_id) ||
      !identityCovers(identity, {
        kind: "workflow",
        projectId: allocation.project_id,
        name: root.workflow_name,
      })
    ) {
      await fail("its owner may no longer run this workflow");
      return;
    }
    try {
      const snapshot = previous.policy.connections ?? [];
      const connectionAdmission = this.deps.connections;
      if (snapshot.length && !connectionAdmission)
        throw new Error("Connection providers are not configured");
      const connections =
        snapshot.length && connectionAdmission
          ? await connectionAdmission.admitSnapshot({
              identity,
              projectId: allocation.project_id,
              environment: allocation.environment_name,
              snapshot,
            })
          : [];
      // Losing a selected capability cannot turn a continuation into a weaker
      // or differently credentialed operation without the author knowing.
      if (
        snapshot.some((binding) =>
          binding.capabilities.some(
            (capability) =>
              !connections
                .find((current) => current.alias === binding.alias)
                ?.capabilities.includes(capability),
          ),
        )
      )
        throw new ConnectionPermissionDeniedError();
      const placement = await this.deps.environments.admitOrWait({
        identity,
        projectId: allocation.project_id,
        owner: placementOwner(root.external_user_id),
        environment: allocation.environment_name,
        requirements: { workload: "workflow" },
        always: true,
      });
      if ("wait" in placement) {
        await this.recordWorkflowWait({ allocation, target: placement.wait });
        return;
      }
      const { admission } = placement;
      try {
        await this.deps.db.transaction().execute(async (trx) => {
          if (!(await lockWorkflowAllocation({ trx, allocation }))) return;
          const current = await workflowAllocationWork({
            trx,
            allocationId: allocation.id,
          });
          if (!current.runnable || current.running || current.invocations)
            return;
          const next = await this.deps.allocations.create({
            identity,
            projectId: allocation.project_id,
            environmentName: admission.environmentName,
            workloadKind: "workflow",
            rootWorkloadId: root.id,
            workerNodeId: admission.runtime.workerNodeId,
            policy: admissionPolicy({
              admission,
              connections,
              workflowEnablementId: previous.policy.workflowEnablementId,
            }),
            transaction: trx,
          });
          await trx
            .updateTable("workflow_runs")
            .set({ allocation_id: next.id, updated_at: sql`now()` })
            .where("allocation_id", "=", allocation.id)
            .execute();
        });
      } catch (error) {
        if (!(error instanceof EnvironmentCapacityError)) throw error;
        await this.recordWorkflowWait({
          allocation,
          target: { ...admission.wait, reason: "capacity" },
        });
      }
    } catch (error) {
      if (
        error instanceof EnvironmentCapacityError ||
        error instanceof EnvironmentBindingUnavailableError
      )
        return;
      // Policy and connection refusals are definitive. Unexpected failures
      // (database/transport) must be retried by maintenance, not fail the run.
      if (
        error instanceof EnvironmentNotFoundError ||
        error instanceof EnvironmentAccessDeniedError ||
        error instanceof EnvironmentIncompatibleError ||
        error instanceof EnvironmentPolicyInvalidError ||
        error instanceof AuthenticationRequiredError ||
        error instanceof ConnectionPermissionDeniedError ||
        error instanceof ConnectionUnavailableError ||
        error instanceof ConnectionNotFoundError
      ) {
        await fail(error.message);
        return;
      }
      throw error;
    }
  }

  private async recordWorkflowWait(args: {
    allocation: AllocationRow;
    target: PlacementWaitTarget;
  }): Promise<void> {
    await this.deps.db.transaction().execute(async (trx) => {
      if (!(await lockWorkflowAllocation({ trx, allocation: args.allocation })))
        return;
      const current = await workflowAllocationWork({
        trx,
        allocationId: args.allocation.id,
      });
      if (!current.runnable || current.running || current.invocations) return;
      await this.deps.waits.record({
        tenantId: args.allocation.tenant_id,
        projectId: args.allocation.project_id,
        workloadKind: "workflow",
        rootWorkloadId: args.allocation.root_workload_id,
        target: args.target,
        limitMinutes: null,
        transaction: trx,
      });
    });
  }

  async recoverLostNodes(args: {
    /** Only nodes of this authority: the host's own deployment. */
    authorityId: string;
    /** Only these nodes, for a host recovering the node it just released. */
    nodeIds?: readonly string[];
    graceMs?: number;
    limit?: number;
  }): Promise<NodeRecoveryResult> {
    return withSpan(
      {
        tracer,
        name: "worker.recover_lost_nodes",
        attributes: { "catamorphic.authority.id": args.authorityId },
      },
      async (span) => {
        const result: NodeRecoveryResult = {
          nodes: 0,
          movedRuns: 0,
          failedRuns: 0,
          releasedChats: 0,
          waitingRuns: 0,
          deletedNodes: 0,
        };
        if (args.nodeIds?.length === 0) return result;
        const graceMs = args.graceMs ?? LOST_NODE_GRACE_MS;
        const lost = await this.deps.db
          .selectFrom("worker_nodes")
          .select(["id", "tenant_id"])
          .where("authority_id", "=", args.authorityId)
          .$if(args.nodeIds !== undefined, (query) =>
            query.where("id", "in", [...(args.nodeIds ?? [])]),
          )
          .where((eb) => isLost(eb, graceMs))
          // Nodes looked at longest ago first, so nodes whose work cannot
          // move yet never starve newer ones.
          .orderBy("recovery_attempted_at", (order) => order.asc().nullsFirst())
          .orderBy("lease_expires_at")
          .limit(Math.max(1, Math.min(args.limit ?? 20, 100)))
          .execute();
        const failures: unknown[] = [];
        for (const node of lost) {
          result.nodes += 1;
          await this.deps.db
            .updateTable("worker_nodes")
            .set({ recovery_attempted_at: sql`now()` })
            .where("id", "=", node.id)
            .execute();
          const allocations = await this.deps.db
            .selectFrom("execution_allocations")
            .selectAll()
            .where("worker_node_id", "=", node.id)
            .where("status", "=", "active")
            .orderBy("created_at")
            .execute();
          let remaining = 0;
          for (const allocation of allocations) {
            try {
              const outcome =
                allocation.workload_kind === "workflow"
                  ? await this.moveRun({ allocation, nodeId: node.id })
                  : await this.releaseWorkload({
                      allocation,
                      nodeId: node.id,
                    });
              if (outcome === "moved") result.movedRuns += 1;
              if (outcome === "failed") result.failedRuns += 1;
              if (outcome === "released") result.releasedChats += 1;
              if (outcome === "waiting") {
                result.waitingRuns += 1;
                remaining += 1;
              }
              if (outcome === "stuck") remaining += 1;
            } catch (error) {
              remaining += 1;
              failures.push(error);
            }
          }
          if (
            remaining === 0 &&
            (await this.deleteNode({ nodeId: node.id, graceMs }))
          )
            result.deletedNodes += 1;
        }
        span.setAttributes({
          "catamorphic.recovery.nodes": result.nodes,
          "catamorphic.recovery.moved_runs": result.movedRuns,
          "catamorphic.recovery.failed_runs": result.failedRuns,
          "catamorphic.recovery.released_chats": result.releasedChats,
          "catamorphic.recovery.waiting_runs": result.waitingRuns,
          "catamorphic.recovery.deleted_nodes": result.deletedNodes,
        });
        if (failures.length > 0)
          throw new AggregateError(
            failures,
            `Recovering lost machines failed for ${failures.length} workload(s): ${String(failures[0])}`,
          );
        return result;
      },
    );
  }

  /**
   * Give a workflow run on a lost node a new Allocation in its own
   * Environment. A run no machine can take now waits for the next pass; one
   * its Environment can no longer place at all fails with the reason.
   */
  private async moveRun(args: {
    allocation: AllocationRow;
    nodeId: string;
  }): Promise<RunOutcome> {
    const { allocation } = args;
    return withSpan(
      {
        tracer,
        name: "worker.recover_run",
        attributes: {
          "catamorphic.worker.id": args.nodeId,
          "catamorphic.allocation.id": allocation.id,
          "catamorphic.run.id": allocation.root_workload_id,
          "catamorphic.project.id": allocation.project_id,
          "catamorphic.tenant.id": allocation.tenant_id,
        },
      },
      async (span) => {
        const run = await this.deps.db
          .selectFrom("workflow_runs")
          .select(["id", "status", "external_user_id"])
          .where("id", "=", allocation.root_workload_id)
          .executeTakeFirst();
        if (!run || ["completed", "failed", "canceled"].includes(run.status)) {
          // A finished run no longer needs a machine.
          const outcome = await this.releaseWorkload(args);
          span.setAttribute("catamorphic.recovery.outcome", outcome);
          return outcome;
        }
        const fail = async (reason: string): Promise<RunOutcome> => {
          // Only while the Allocation is still on the lost node: another
          // pass may have moved the run in the meantime.
          const failed = await this.deps.db
            .transaction()
            .execute(async (trx) => {
              if (!(await lockLostAllocation({ trx, ...args }))) return false;
              await this.deps.coordinator.failRunTree({
                runId: run.id,
                error: `Its machine stopped and the run cannot continue elsewhere: ${reason}`,
                trx,
              });
              await retireAllocation({ trx, allocationId: allocation.id });
              return true;
            });
          const outcome = failed ? "failed" : "skipped";
          span.setAttribute("catamorphic.recovery.outcome", outcome);
          return outcome;
        };
        if (!run.external_user_id) return fail("the run has no owner");
        // The run's owner as they are now, placed as readmission places a
        // chat (ADR 0167, 0173): a project automation as the project, a
        // member with their current access.
        const identity = isProjectPrincipal(run.external_user_id)
          ? projectPrincipalIdentity({
              tenantId: allocation.tenant_id,
              projectId: allocation.project_id,
              environment: allocation.environment_name,
            })
          : await this.deps.resolveOwner({
              tenantId: allocation.tenant_id,
              projectId: allocation.project_id,
              externalUserId: run.external_user_id,
            });
        if (!identity)
          return fail("its owner may no longer run work in this project");
        const previous = await this.deps.allocations.get({
          identity,
          allocationId: allocation.id,
        });
        if (!previous) {
          // Nothing to rebuild the run from: keep the node (and say so)
          // rather than dropping the run silently.
          console.warn(
            `[catamorphic] Run ${run.id} on lost machine ${args.nodeId} has an unreadable Allocation ${allocation.id}; leaving it for an operator`,
          );
          span.setAttribute("catamorphic.recovery.outcome", "stuck");
          return "stuck";
        }
        let admission: Awaited<
          ReturnType<ExecutionEnvironmentsService["admit"]>
        >;
        try {
          admission = await this.deps.environments.admit({
            identity,
            projectId: allocation.project_id,
            owner: placementOwner(run.external_user_id),
            environment: allocation.environment_name,
            requirements: { workload: "workflow" },
          });
        } catch (error) {
          if (
            error instanceof EnvironmentBindingUnavailableError ||
            error instanceof EnvironmentCapacityError
          ) {
            span.setAttribute("catamorphic.recovery.outcome", "waiting");
            return "waiting";
          }
          if (
            error instanceof EnvironmentNotFoundError ||
            error instanceof EnvironmentAccessDeniedError ||
            error instanceof EnvironmentIncompatibleError ||
            error instanceof EnvironmentPolicyInvalidError
          )
            return fail(error.message);
          throw error;
        }
        try {
          const moved = await this.deps.db
            .transaction()
            .execute(async (trx) => {
              if (!(await lockLostAllocation({ trx, ...args }))) return false;
              await retireAllocation({ trx, allocationId: allocation.id });
              const next = await this.deps.allocations.create({
                identity,
                projectId: allocation.project_id,
                environmentName: admission.environmentName,
                workloadKind: "workflow",
                rootWorkloadId: allocation.root_workload_id,
                ...(admission.runtime.workerNodeId
                  ? { workerNodeId: admission.runtime.workerNodeId }
                  : {}),
                // What the run was admitted with stays: its connections and
                // enablement. The new machine's binding replaces the old.
                policy: admissionPolicy({
                  admission,
                  connections: previous.policy.connections ?? [],
                  ...(previous.policy.workflowEnablementId
                    ? {
                        workflowEnablementId:
                          previous.policy.workflowEnablementId,
                      }
                    : {}),
                }),
                transaction: trx,
              });
              // Child runs share their root's Allocation.
              await trx
                .updateTable("workflow_runs")
                .set({ allocation_id: next.id, updated_at: sql`now()` })
                .where("allocation_id", "=", allocation.id)
                .execute();
              span.setAttribute("catamorphic.allocation.next_id", next.id);
              if (next.workerNodeId)
                span.setAttribute(
                  "catamorphic.recovery.worker_id",
                  next.workerNodeId,
                );
              return true;
            });
          span.setAttribute(
            "catamorphic.recovery.outcome",
            moved ? "moved" : "skipped",
          );
          return moved ? "moved" : "skipped";
        } catch (error) {
          // The chosen machine filled up in the meantime.
          if (error instanceof EnvironmentCapacityError) {
            span.setAttribute("catamorphic.recovery.outcome", "waiting");
            return "waiting";
          }
          throw error;
        }
      },
    );
  }

  /** Release a lost node's Allocation for a workload that is not a live run. */
  private async releaseWorkload(args: {
    allocation: AllocationRow;
    nodeId: string;
  }): Promise<RunOutcome> {
    return this.deps.db.transaction().execute(async (trx) => {
      if (!(await lockLostAllocation({ trx, ...args }))) return "skipped";
      await retireAllocation({ trx, allocationId: args.allocation.id });
      // The sandbox and any runner in it died with the machine;
      // the next turn starts both again, as after an idle release.
      await trx
        .updateTable("agent_sessions")
        .set({ sandbox_id: null })
        .where("allocation_id", "=", args.allocation.id)
        .execute();
      return "released";
    });
  }

  /**
   * Delete a lost node once nothing active is left on it. Its released
   * Allocations stop counting against it: their sandboxes died with it.
   */
  private async deleteNode(args: {
    nodeId: string;
    graceMs: number;
  }): Promise<boolean> {
    return this.deps.db.transaction().execute(async (trx) => {
      const node = await trx
        .selectFrom("worker_nodes")
        .select("id")
        .where("id", "=", args.nodeId)
        .where((eb) => isLost(eb, args.graceMs))
        .where(({ not, exists, selectFrom }) =>
          not(
            exists(
              selectFrom("execution_allocations")
                .select("id")
                .where("worker_node_id", "=", args.nodeId)
                .where("status", "=", "active"),
            ),
          ),
        )
        .forUpdate()
        .skipLocked()
        .executeTakeFirst();
      if (!node) return false;
      await trx
        .updateTable("execution_allocations")
        .set({ capacity_released_at: sql`now()` })
        .where("worker_node_id", "=", args.nodeId)
        .where("capacity_released_at", "is", null)
        .execute();
      await trx
        .deleteFrom("worker_nodes")
        .where("id", "=", args.nodeId)
        .execute();
      return true;
    });
  }
}

/**
 * A disposable node that will never renew again: it released its lease on
 * stop (which also disabled it), or its lease lapsed more than the grace
 * period ago.
 */
function isLost(eb: ExpressionBuilder<DB, "worker_nodes">, graceMs: number) {
  return eb.and([
    eb("disposable", "=", true),
    eb("lease_expires_at", "<=", sql<Date>`now()`),
    eb.or([
      eb("enabled", "=", false),
      eb(
        "lease_expires_at",
        "<=",
        sql<Date>`now() - make_interval(secs => ${graceMs / 1_000})`,
      ),
    ]),
  ]);
}

/**
 * Lock an Allocation still active on the lost node, or report it moved on.
 * Its workload's rows are locked first, in the order the run coordinator
 * (a run, then its tree, then its Allocation) and chats (the session, then
 * its Allocation) take them, so recovery never deadlocks with them.
 */
async function lockLostAllocation(args: {
  trx: Transaction<DB>;
  allocation: AllocationRow;
  nodeId: string;
}): Promise<boolean> {
  const { allocation, trx } = args;
  if (allocation.workload_kind === "workflow") {
    await trx
      .selectFrom("workflow_runs")
      .select("id")
      .where("id", "=", allocation.root_workload_id)
      .forUpdate()
      .execute();
    await trx
      .selectFrom("workflow_runs")
      .select("id")
      .where("allocation_id", "=", allocation.id)
      .where("id", "!=", allocation.root_workload_id)
      .orderBy("id")
      .forUpdate()
      .execute();
  } else {
    await trx
      .selectFrom("agent_sessions")
      .select("id")
      .where("allocation_id", "=", allocation.id)
      .orderBy("id")
      .forUpdate()
      .execute();
  }
  const row = await args.trx
    .selectFrom("execution_allocations")
    .select("id")
    .where("id", "=", args.allocation.id)
    .where("worker_node_id", "=", args.nodeId)
    .where("status", "=", "active")
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  return Boolean(row);
}

/**
 * Release an Allocation whose machine is gone: its capacity went with the
 * machine, and its grants and deployment runtimes end with it.
 */
async function retireAllocation(args: {
  trx: Transaction<DB>;
  allocationId: string;
}): Promise<void> {
  await args.trx
    .updateTable("execution_allocations")
    .set({
      status: "released",
      released_at: sql`now()`,
      release_reason: "node_lost",
      capacity_released_at: sql`now()`,
    })
    .where("id", "=", args.allocationId)
    .execute();
  await args.trx
    .updateTable("connection_capability_grants")
    .set({ revoked_at: sql`now()` })
    .where("allocation_id", "=", args.allocationId)
    .where("revoked_at", "is", null)
    .execute();
  await args.trx
    .deleteFrom("deployment_runtimes")
    .where("binding_id", "=", args.allocationId)
    .execute();
}

/** Root, sharing children, then Allocation: the coordinator's lock order. */
async function lockWorkflowAllocation(args: {
  trx: Transaction<DB>;
  allocation: AllocationRow;
}): Promise<boolean> {
  const root = await args.trx
    .selectFrom("workflow_runs")
    .select(["id", "allocation_id", "status"])
    .where("id", "=", args.allocation.root_workload_id)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  if (
    !root ||
    root.allocation_id !== args.allocation.id ||
    !["pending", "running", "waiting", "paused"].includes(root.status)
  )
    return false;
  const children = await args.trx
    .selectFrom("workflow_runs")
    .select("id")
    .where("allocation_id", "=", args.allocation.id)
    .where("id", "!=", root.id)
    .orderBy("id")
    .execute();
  for (const child of children) {
    const locked = await args.trx
      .selectFrom("workflow_runs")
      .select("id")
      .where("id", "=", child.id)
      .forUpdate()
      .skipLocked()
      .executeTakeFirst();
    if (!locked) return false;
  }
  const allocation = await args.trx
    .selectFrom("execution_allocations")
    .select("id")
    .where("id", "=", args.allocation.id)
    .where("status", "=", args.allocation.status)
    .forUpdate()
    .skipLocked()
    .executeTakeFirst();
  return Boolean(allocation);
}

async function workflowAllocationWork(args: {
  trx: Kysely<DB>;
  allocationId: string;
}) {
  const runs = args.trx
    .selectFrom("workflow_runs")
    .select("id")
    .where("allocation_id", "=", args.allocationId);
  const running = await args.trx
    .selectFrom("execution_jobs")
    .select("id")
    .where("workflow_run_id", "in", runs)
    .where("status", "=", "running")
    .limit(1)
    .executeTakeFirst();
  const invocations = await args.trx
    .selectFrom("active_run_invocations")
    .select("invocation_id")
    .where("workflow_run_id", "in", runs)
    .limit(1)
    .executeTakeFirst();
  const runnable = await args.trx
    .selectFrom("execution_jobs as job")
    .innerJoin("workflow_runs as run", "run.id", "job.workflow_run_id")
    .select("job.id")
    .where("run.allocation_id", "=", args.allocationId)
    .where("run.status", "in", ["pending", "running", "waiting"])
    .where("job.status", "=", "pending")
    .where("job.kind", "!=", "durable_pause_timeout")
    .where("job.available_at", "<=", sql<Date>`clock_timestamp()`)
    .limit(1)
    .executeTakeFirst();
  return {
    running: Boolean(running),
    runnable: Boolean(runnable),
    invocations: Boolean(invocations),
  };
}

function allocationJobs(db: Kysely<DB>, allocationId: string) {
  return db
    .selectFrom("execution_jobs as job")
    .innerJoin("workflow_runs as run", "run.id", "job.workflow_run_id")
    .select("job.id")
    .where("run.allocation_id", "=", sql<string>`${sql.ref(allocationId)}`);
}

function runnableAllocationJobs(db: Kysely<DB>, allocationId: string) {
  return allocationJobs(db, allocationId)
    .where("run.status", "in", ["pending", "running", "waiting"])
    .where("job.status", "=", "pending")
    .where("job.kind", "!=", "durable_pause_timeout")
    .where("job.available_at", "<=", sql<Date>`clock_timestamp()`);
}
