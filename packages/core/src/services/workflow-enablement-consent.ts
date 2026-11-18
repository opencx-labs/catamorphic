import { createHash } from "node:crypto";
import type {
  WorkflowEnablementConnection,
  WorkflowEnablementOwner,
} from "./workflow-enablement-types.js";

function canonical(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonical).join(",")}]`;
  return `{${Object.entries(value)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonical(item)}`)
    .join(",")}}`;
}

/** Stable digest of every authority-bearing choice shown to the owner. */
export function workflowEnablementConsentDigest(input: {
  projectId: string;
  workflowName: string;
  deploymentArtifactDigest: string;
  environment: string;
  owner: WorkflowEnablementOwner;
  connections: readonly WorkflowEnablementConnection[];
  capabilities: readonly string[];
  permissions: readonly string[];
}): string {
  const value = {
    projectId: input.projectId,
    workflowName: input.workflowName,
    deploymentArtifactDigest: input.deploymentArtifactDigest,
    environment: input.environment,
    owner: input.owner,
    connections: [...input.connections]
      .sort((left, right) => left.alias.localeCompare(right.alias))
      .map((connection) => ({
        alias: connection.alias,
        connectionId: connection.connectionId,
        providerKind: connection.providerKind,
        principalKind: connection.principalKind,
        capabilities: [...connection.capabilities].sort(),
      })),
    capabilities: [...input.capabilities].sort(),
    permissions: [...input.permissions].sort(),
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}

/**
 * Everything an owner agreed to except the code itself (ADR 0330): the
 * Environment, connections, capabilities and permissions, what starts the
 * workflow (each trigger's kind, configuration and filters, and whether
 * workflows may record its project kind) and the secret
 * names its runs receive. A following enablement moves to a new revision
 * only while this stays the same, so a merge cannot add a public webhook, a
 * broader filter, a frequent schedule or a new secret without consent.
 */
export function workflowEnablementAuthorityDigest(input: {
  projectId: string;
  workflowName: string;
  environment: string;
  owner: WorkflowEnablementOwner;
  connections: readonly WorkflowEnablementConnection[];
  capabilities: readonly string[];
  permissions: readonly string[];
  triggers: ReadonlyArray<{
    kind: string;
    config: unknown;
    projectKind?: string;
    where?: unknown;
    /** Workflows may record the project kind's events (ADR 0326). */
    recordable?: true;
  }>;
  secrets: readonly string[];
}): string {
  const base = workflowEnablementConsentDigest({
    ...input,
    deploymentArtifactDigest: "",
  });
  return createHash("sha256")
    .update(
      canonical({
        base,
        triggers: input.triggers.map((trigger) => ({
          kind: trigger.kind,
          config: trigger.config ?? null,
          projectKind: trigger.projectKind ?? null,
          where: trigger.where ?? null,
          // Only when set, so digests of kinds that never opted in stay.
          ...(trigger.recordable ? { recordable: true } : {}),
        })),
        secrets: [...input.secrets].sort(),
      }),
    )
    .digest("hex");
}
