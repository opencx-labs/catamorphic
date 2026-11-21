import type { NodeAccess } from "@catamorphic/sandbox";
import { z } from "zod";
import {
  MachineLabelsSchema,
  type MachinePrincipal,
  MachinePrincipalSchema,
  normalizePrincipals,
  RESERVED_LABELS,
  servesNobody,
  servesOneOwner,
} from "../machines/contract.js";

export { RESERVED_LABELS, servesNobody, servesOneOwner };

export const NodeLabelsSchema = MachineLabelsSchema;

/**
 * A machine's placement (ADRs 0167, 0347): the labels an Environment's
 * `pool` selects on, whom it is for (users, projects' own work, single
 * chat keys, or anyone when absent), and whether those it serves trust
 * each other. Control-plane state; a worker never declares it.
 */
export const WorkerPlacementSchema = z.strictObject({
  labels: NodeLabelsSchema.default({}),
  /** Who may place work here; left out, anyone. An empty list: nobody. */
  for: z.array(MachinePrincipalSchema).max(500).optional(),
  /**
   * The people this worker serves trust each other: process isolation is
   * acceptable although it serves more than one person.
   */
  trusted: z.boolean().default(false),
});

export interface WorkerPlacement {
  labels: Readonly<Record<string, string>>;
  /** Null: anyone whose role and Environment allow it. */
  for: readonly MachinePrincipal[] | null;
  trusted: boolean;
}

/** A parsed placement, with "anyone" as null and principals in order. */
export function workerPlacement(
  input: z.input<typeof WorkerPlacementSchema>,
): WorkerPlacement {
  const parsed = WorkerPlacementSchema.parse(input);
  return {
    labels: parsed.labels,
    for: parsed.for === undefined ? null : normalizePrincipals(parsed.for),
    trusted: parsed.trusted,
  };
}

/**
 * A worker's placement as the scheduler reads it. A machine that is not
 * `accepting` (the plan dropped it, it is stopping, stopped, resuming or
 * being reset, ADRs 0347, 0348) takes no new work and keeps serving the
 * Allocations it holds.
 */
export type ScheduledPlacement = WorkerPlacement & {
  accepting: boolean;
  admissionRevision: string | null;
};

export function nodeAccess(
  principals: readonly MachinePrincipal[] | null,
): NodeAccess {
  if (principals === null) return { everyone: true };
  const users: string[] = [];
  const projects: string[] = [];
  const keys: { project: string; key: string }[] = [];
  for (const principal of principals) {
    if ("user" in principal) users.push(principal.user);
    else if ("key" in principal)
      keys.push({ project: principal.project, key: principal.key });
    else projects.push(principal.project);
  }
  return { users, projects, keys };
}

const StoredPrincipals = z.array(MachinePrincipalSchema).nullable();

/** Stored placement, validated on the way out of the database. */
export function storedPlacement(row: {
  labels: unknown;
  serves: unknown;
  trusted: boolean;
}): WorkerPlacement {
  return {
    labels: NodeLabelsSchema.parse(row.labels),
    for: StoredPrincipals.parse(row.serves ?? null),
    trusted: row.trusted,
  };
}
