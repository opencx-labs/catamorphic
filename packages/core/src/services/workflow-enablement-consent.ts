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
        bindingId: connection.bindingId,
        connectionId: connection.connectionId,
        providerKind: connection.providerKind,
        principalKind: connection.principalKind,
        capabilities: [...connection.capabilities].sort(),
      })),
    capabilities: [...input.capabilities].sort(),
  };
  return createHash("sha256").update(canonical(value)).digest("hex");
}
