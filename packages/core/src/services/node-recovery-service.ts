import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type ExpressionBuilder,
  type Kysely,
  type Selectable,
  sql,
  type Transaction,
} from "kysely";
import type { Identity } from "../identity.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import {
  admissionPolicy,
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  EnvironmentPolicyInvalidError,
  type ExecutionEnvironmentsService,
} from "./execution-environments-service.js";
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
type RunOutcome = "moved" | "failed" | "waiting" | "released" | "skipped";

/**
 * Recovers the work of disposable nodes that are gone for good (ADR 0190):
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
    },
  ) {}

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
          .orderBy("lease_expires_at")
          .limit(Math.max(1, Math.min(args.limit ?? 20, 100)))
          .execute();
        const failures: unknown[] = [];
        for (const node of lost) {
          result.nodes += 1;
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
          await this.deps.coordinator.failRunTree({
            runId: run.id,
            error: `Its machine stopped and the run cannot continue elsewhere: ${reason}`,
          });
          await this.deps.db
            .updateTable("execution_allocations")
            .set({
              release_reason: "node_lost",
              capacity_released_at: sql`now()`,
            })
            .where("id", "=", allocation.id)
            .where("status", "=", "released")
            .execute();
          span.setAttribute("catamorphic.recovery.outcome", "failed");
          return "failed";
        };
        if (!run.external_user_id) return fail("the run has no owner");
        const identity: Identity = {
          tenantId: allocation.tenant_id,
          externalUserId: run.external_user_id,
        };
        const previous = await this.deps.allocations.get({
          identity,
          allocationId: allocation.id,
        });
        if (!previous) return "skipped";
        let admission: Awaited<
          ReturnType<ExecutionEnvironmentsService["admit"]>
        >;
        try {
          admission = await this.deps.environments.admit({
            identity,
            projectId: allocation.project_id,
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
      // The sandbox and the harness's own session died with the machine;
      // the next turn starts both again, as after an idle release.
      await trx
        .updateTable("agent_sessions")
        .set({ sandbox_id: null, provider_session_id: null })
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

/** Lock an Allocation still active on the lost node, or report it moved on. */
async function lockLostAllocation(args: {
  trx: Transaction<DB>;
  allocation: AllocationRow;
  nodeId: string;
}): Promise<boolean> {
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
