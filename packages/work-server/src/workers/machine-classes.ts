import fs from "node:fs";
import { z } from "zod";

/** Machine class and rule names: lowercase letters, digits, dashes. */
export const MachineName = z
  .string()
  .regex(/^[a-z0-9][a-z0-9-]{0,30}$/, "Use lowercase letters, digits, dashes");

/** Labels Work sets on Hetzner resources itself. */
const RESERVED_HETZNER_LABELS = ["work-machine", "work-server-id"];

/** Hetzner Cloud label keys and values (an optional `prefix/` on keys). */
const HetznerLabels = z
  .record(
    z
      .string()
      .regex(
        /^([a-z0-9]([-a-z0-9.]*[a-z0-9])?\/)?[A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?$/,
        "Hetzner label names are letters, digits, dashes, underscores and dots",
      ),
    z
      .string()
      .regex(
        /^([A-Za-z0-9]([-A-Za-z0-9_.]{0,61}[A-Za-z0-9])?)?$/,
        "Hetzner label values are at most 63 letters, digits, dashes, underscores and dots",
      ),
  )
  .refine(
    (labels) => RESERVED_HETZNER_LABELS.every((key) => !(key in labels)),
    `Work sets ${RESERVED_HETZNER_LABELS.join(" and ")} itself`,
  );

/**
 * A Hetzner Cloud server per machine (ADR 0204). The API token is
 * `WORK_HETZNER_TOKEN`, never part of the class.
 */
export const HetznerCloudClassSchema = z.strictObject({
  platform: z.literal("hetzner-cloud"),
  /** `cpx41`, `ccx33`, ... */
  serverType: z.string().min(1).max(64),
  /** `fsn1`, `nbg1`, `hel1`, `ash`, `hil`, `sin`. */
  location: z.string().min(1).max(64),
  /** An image name such as `ubuntu-24.04`, or an image id. */
  image: z.string().min(1).max(128),
  /** SSH key names or ids for root. */
  sshKeys: z
    .array(z.union([z.string().min(1).max(128), z.number().int().positive()]))
    .max(50)
    .optional(),
  /** Firewall ids. */
  firewalls: z.array(z.number().int().positive()).max(10).optional(),
  /** Private network ids. */
  networks: z.array(z.number().int().positive()).max(10).optional(),
  /** Extra labels on the server, for the project's own bookkeeping. */
  labels: HetznerLabels.optional(),
  /** Keep a snapshot of the disk when the machine is destroyed. */
  snapshot: z.boolean().default(false),
});

/** Machines the operator enrolled into a pool with this class label. */
export const PoolClassSchema = z.strictObject({ platform: z.literal("pool") });

/** Machines the `machineProvisioner` hook creates and destroys. */
export const CustomClassSchema = z.strictObject({
  platform: z.literal("custom"),
});

export const MachineClassSchema = z.discriminatedUnion("platform", [
  HetznerCloudClassSchema,
  PoolClassSchema,
  CustomClassSchema,
]);
export type MachineClass = z.output<typeof MachineClassSchema>;
export type MachinePlatform = MachineClass["platform"];

/** `WORK_MACHINES_CONFIG`: the machine classes rules may name. */
export const MachinesConfigSchema = z.strictObject({
  classes: z.record(MachineName, MachineClassSchema),
});
export type MachinesConfig = z.output<typeof MachinesConfigSchema>;

/** Read and validate the machines file; errors name the file. */
export function machinesConfigFromFile(file: string): MachinesConfig {
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (error) {
    throw new Error(
      `WORK_MACHINES_CONFIG (${file}) is not readable JSON: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
  const parsed = MachinesConfigSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new Error(
      `WORK_MACHINES_CONFIG (${file}): ${
        issue
          ? `${issue.path.join(".") || "file"}: ${issue.message}`
          : "invalid machine classes"
      }`,
    );
  }
  return parsed.data;
}

/**
 * Check machine classes against what the server has: a Hetzner token for
 * `hetzner-cloud` classes and a provisioner for `custom` ones. Returns the
 * reason a server cannot start with them, if any.
 */
export function machineClassesProblem(args: {
  classes: Readonly<Record<string, MachineClass>>;
  hetznerToken: boolean;
  provisioner: boolean;
}): string | undefined {
  for (const [name, machineClass] of Object.entries(args.classes)) {
    if (machineClass.platform === "hetzner-cloud" && !args.hetznerToken)
      return `Machine class '${name}' is on Hetzner Cloud: set WORK_HETZNER_TOKEN to a Hetzner Cloud API token with read and write access`;
    if (machineClass.platform === "custom" && !args.provisioner)
      return `Machine class '${name}' is custom: extend the Work server with the machineProvisioner hook, or use hetzner-cloud or pool`;
  }
  return undefined;
}
