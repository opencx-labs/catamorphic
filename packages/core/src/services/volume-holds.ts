import type { DB } from "@catamorphic/db";
import type { SandboxVolume } from "@catamorphic/sandbox";
import { type ExpressionBuilder, type Kysely, sql } from "kysely";
import type {
  EnvironmentSandboxVolume,
  ExecutionAllocation,
} from "./execution-allocations-service.js";

/*
 * Exclusive volumes (ADR 0208): a Docker data root or a database directory
 * is mounted into one sandbox at a time on its machine. The hold lives in
 * Postgres beside the Allocation whose sandbox mounts it, so every replica
 * sees it, and it ends with that sandbox (migration 051's trigger, on
 * capacity release or, for a machine that keeps its own sandboxes, on
 * release). A sandbox created while another holds the key gets an empty
 * temporary volume that goes away with it; a released holder on a worker
 * that runs nothing is destroyed first (`allocationSandboxProvider`).
 */

/**
 * The machine an Allocation's sandbox runs on, as holds name it: its worker
 * node, a member's runner (`client:<runner id>`), or else its binding.
 */
export function volumeHoldNode(
  allocation: Pick<ExecutionAllocation, "workerNodeId" | "bindingId">,
): string {
  if (allocation.workerNodeId) return allocation.workerNodeId;
  const [kind, runnerId] = allocation.bindingId.split(":");
  if (kind === "client" && runnerId) return `client:${runnerId}`;
  return `binding:${allocation.bindingId}`;
}

/**
 * Whether a hold's Allocation may still have its sandbox: active, or
 * released on a worker node whose cleanup has not destroyed it yet.
 */
function holderLive(eb: ExpressionBuilder<DB, "volume_holds">) {
  return eb.exists(
    eb
      .selectFrom("execution_allocations as holder")
      .select("holder.id")
      .whereRef("holder.id", "=", "volume_holds.allocation_id")
      .where("holder.capacity_released_at", "is", null)
      .where((holder) =>
        holder.or([
          holder("holder.status", "=", "active"),
          holder("holder.worker_node_id", "is not", null),
        ]),
      ),
  );
}

/**
 * The volumes an Allocation's sandbox is created with. Each exclusive one
 * is held for the Allocation on its machine; a key another live sandbox
 * holds comes back `temporary`. Holding again for the same Allocation
 * keeps its hold, so a sandbox created again keeps its volumes.
 */
export async function holdVolumes(args: {
  db: Kysely<DB>;
  allocation: Pick<
    ExecutionAllocation,
    "id" | "workerNodeId" | "bindingId" | "policy"
  >;
}): Promise<SandboxVolume[]> {
  const volumes = args.allocation.policy.sandbox?.volumes ?? [];
  const node = volumeHoldNode(args.allocation);
  const result: SandboxVolume[] = [];
  for (const volume of volumes) {
    const mounted = sandboxVolume(volume);
    if (!volume.exclusive) {
      result.push(mounted);
      continue;
    }
    const held = await args.db
      .insertInto("volume_holds")
      .values({
        node,
        volume_key: volume.key,
        allocation_id: args.allocation.id,
      })
      .onConflict((conflict) =>
        conflict
          .columns(["node", "volume_key"])
          .doUpdateSet({
            allocation_id: (eb) => eb.ref("excluded.allocation_id"),
            created_at: sql<Date>`now()`,
          })
          // Taken over only from an Allocation whose sandbox is gone.
          .where((eb) =>
            eb.or([
              eb(
                "volume_holds.allocation_id",
                "=",
                eb.ref("excluded.allocation_id"),
              ),
              eb.not(holderLive(eb)),
            ]),
          ),
      )
      .returning("allocation_id")
      .executeTakeFirst();
    result.push(
      held?.allocation_id === args.allocation.id
        ? mounted
        : { ...mounted, temporary: true },
    );
  }
  return result;
}

function sandboxVolume(volume: EnvironmentSandboxVolume): SandboxVolume {
  return {
    key: volume.key,
    path: volume.path,
    ...(volume.exclusive ? { exclusive: true } : {}),
    ...(volume.sizeMb ? { sizeMb: volume.sizeMb } : {}),
  };
}

/**
 * The exclusive volumes an Allocation's sandbox got empty and temporary:
 * those it does not hold. Holds are taken only when the sandbox is created,
 * so an Allocation that did not get one never gets it later.
 */
export async function temporaryVolumes(args: {
  db: Kysely<DB>;
  allocation: Pick<
    ExecutionAllocation,
    "id" | "workerNodeId" | "bindingId" | "policy"
  >;
}): Promise<EnvironmentSandboxVolume[]> {
  const exclusive = (args.allocation.policy.sandbox?.volumes ?? []).filter(
    (volume) => volume.exclusive,
  );
  if (exclusive.length === 0) return [];
  const held = await args.db
    .selectFrom("volume_holds")
    .select("volume_key")
    .where("node", "=", volumeHoldNode(args.allocation))
    .where("allocation_id", "=", args.allocation.id)
    .execute();
  const keys = new Set(held.map((row) => row.volume_key));
  return exclusive.filter((volume) => !keys.has(volume.key));
}

/**
 * Remove holds whose sandbox is gone; the trigger normally removes them
 * first. Returns how many were removed.
 */
export async function sweepVolumeHolds(args: {
  db: Kysely<DB>;
  /** Only this machine's holds. */
  node?: string;
}): Promise<number> {
  const removed = await args.db
    .deleteFrom("volume_holds")
    .$if(args.node !== undefined, (query) =>
      query.where("node", "=", args.node ?? ""),
    )
    .where((eb) => eb.not(holderLive(eb)))
    .executeTakeFirst();
  return Number(removed.numDeletedRows);
}

/**
 * What the agent is told when its workspace got an empty temporary copy
 * of an exclusive volume because another workspace of the same owner on
 * the machine holds it (ADR 0208).
 */
export function temporaryVolumesNote(input: {
  volumes: ReadonlyArray<Pick<EnvironmentSandboxVolume, "name" | "path">>;
  /** The project's own chats share the project's volumes. */
  projectChat: boolean;
}): string | undefined {
  const { volumes } = input;
  if (volumes.length === 0) return undefined;
  const names = volumes.map((volume) => volume.name);
  const listed =
    names.length === 1
      ? `the ${names[0]} volume`
      : `the ${names.slice(0, -1).join(", ")} and ${names.at(-1)} volumes`;
  const paths = volumes.map((volume) => volume.path).join(", ");
  const holder = input.projectChat
    ? "Another of this project's chats"
    : "Another chat of yours";
  const one = volumes.length === 1;
  return `[Workspace] ${holder} on this machine holds ${listed}, so this workspace has ${one ? "an empty one" : "empty ones"} at ${paths} that ${one ? "goes" : "go"} away with it.`;
}
