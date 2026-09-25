import type { NodeAccess } from "@catamorphic/sandbox";
import { z } from "zod";

/** Labels the Work server sets on every node itself (ADR 0167). */
export const RESERVED_LABELS = ["node", "plane"] as const;

export const NodeLabelsSchema = z
  .record(
    z
      .string()
      .regex(
        /^[a-z0-9][a-z0-9._-]{0,62}$/,
        "Label names are lowercase letters, digits, dots, dashes",
      ),
    z.string().min(1).max(128),
  )
  .refine(
    (labels) => RESERVED_LABELS.every((key) => !(key in labels)),
    `The server sets ${RESERVED_LABELS.join(" and ")} itself`,
  );

/**
 * Whose work a worker takes: everyone, or named people and directory groups
 * by email. Control-plane state; a worker never declares it.
 */
export const WorkerAccessSchema = z.union([
  z.strictObject({ everyone: z.literal(true) }),
  z
    .strictObject({
      people: z.array(z.email().toLowerCase()).max(500).default([]),
      groups: z.array(z.email().toLowerCase()).max(100).default([]),
    })
    .refine(
      (access) => access.people.length + access.groups.length > 0,
      "Name at least one person or group, or use { everyone: true }",
    ),
]);
export type WorkerAccess = z.output<typeof WorkerAccessSchema>;

export const WorkerPlacementSchema = z.strictObject({
  labels: NodeLabelsSchema.default({}),
  access: WorkerAccessSchema.default({ everyone: true }),
  /**
   * The people this worker serves trust each other: process isolation is
   * acceptable although it serves more than one person.
   */
  trusted: z.boolean().default(false),
});
export type WorkerPlacement = z.output<typeof WorkerPlacementSchema>;

export function nodeAccess(access: WorkerAccess): NodeAccess {
  return "everyone" in access
    ? { everyone: true }
    : { users: access.people, groups: access.groups };
}

/** One named person and no groups: nobody else's work lands here. */
export function servesOnePerson(access: WorkerAccess): boolean {
  return (
    !("everyone" in access) &&
    access.people.length === 1 &&
    access.groups.length === 0
  );
}

/** Stored placement, validated on the way out of the database. */
export function storedPlacement(row: {
  labels: unknown;
  access: unknown;
  trusted: boolean;
}): WorkerPlacement {
  return WorkerPlacementSchema.parse({
    labels: row.labels,
    access: row.access,
    trusted: row.trusted,
  });
}
