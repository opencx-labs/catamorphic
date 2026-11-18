import type { DB } from "@catamorphic/db";
import { type MachineDisk, outOfDiskReason } from "@catamorphic/sandbox";
import type { Kysely, Transaction } from "kysely";
import { diskFreshSql, machineDiskOf } from "./worker-capacity.js";

/**
 * The recent disk report of the machine an Allocation is on (ADR 0335),
 * or undefined: no Allocation, a machine that reports none, or a report
 * too old to speak for it now.
 */
export async function allocationDisk(args: {
  db: Kysely<DB> | Transaction<DB>;
  allocationId?: string | null;
  /**
   * Or a chat, whose workspace may be another's (a shared subsession's,
   * ADR 0322).
   */
  sessionId?: string;
  /** Or the machine itself. */
  nodeId?: string | null;
}): Promise<MachineDisk | undefined> {
  const fresh = (row: { disk: unknown; fresh: boolean } | undefined) =>
    row?.fresh ? machineDiskOf(row.disk) : undefined;
  if (args.nodeId) {
    const node = await args.db
      .selectFrom("worker_nodes")
      .select(["disk", diskFreshSql.as("fresh")])
      .where("id", "=", args.nodeId)
      .executeTakeFirst();
    return fresh(node);
  }
  const allocationId =
    args.allocationId ??
    (args.sessionId
      ? await sessionAllocation({ db: args.db, sessionId: args.sessionId })
      : undefined);
  if (!allocationId) return undefined;
  const row = await args.db
    .selectFrom("execution_allocations as allocation")
    .innerJoin("worker_nodes", "worker_nodes.id", "allocation.worker_node_id")
    .select(["worker_nodes.disk", diskFreshSql.as("fresh")])
    .where("allocation.id", "=", allocationId)
    .executeTakeFirst();
  return fresh(row);
}

/** The Allocation holding a chat's workspace: its own, or its sharer's. */
async function sessionAllocation(args: {
  db: Kysely<DB> | Transaction<DB>;
  sessionId: string;
}): Promise<string | undefined> {
  const chat = await args.db
    .selectFrom("agent_sessions")
    .select(["allocation_id", "workspace_session_id"])
    .where("id", "=", args.sessionId)
    .executeTakeFirst();
  if (chat?.allocation_id) return chat.allocation_id;
  if (!chat?.workspace_session_id) return undefined;
  const owner = await args.db
    .selectFrom("agent_sessions")
    .select("allocation_id")
    .where("id", "=", chat.workspace_session_id)
    .executeTakeFirst();
  return owner?.allocation_id ?? undefined;
}

/**
 * Why a failure in an Allocation's workspace happened, when the disk is
 * to blame (ADR 0335): its machine is under its floor, or the output says
 * a write found no room. Undefined otherwise, and when the lookup fails:
 * a reason is an explanation, never in the way of recording the failure.
 */
export async function outOfDiskFor(args: {
  db: Kysely<DB> | Transaction<DB>;
  allocationId?: string | null;
  sessionId?: string;
  nodeId?: string | null;
  texts: ReadonlyArray<string | null | undefined>;
}): Promise<string | undefined> {
  const disk = await allocationDisk(args).catch(() => undefined);
  return outOfDiskReason({ ...(disk ? { disk } : {}), texts: args.texts });
}

/** A failure's text with its out-of-disk reason first, once. */
export function withOutOfDisk(
  error: string,
  reason: string | undefined,
): string {
  return reason && !error.startsWith(reason) ? `${reason} ${error}` : error;
}
