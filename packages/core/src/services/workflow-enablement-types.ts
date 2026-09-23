import type { ConnectionPrincipalKind } from "./connection-types.js";

export type WorkflowEnablementStatus = "active" | "suspended" | "disabled";

/**
 * Who an enablement acts for (ADR 0156): one member, with their own
 * authority, or the project's team, running as the team principal with
 * the connections a builder consented to.
 */
export type WorkflowEnablementOwner =
  | { type: "member"; externalUserId: string }
  | { type: "team" };

export interface WorkflowEnablementConnection {
  alias: string;
  bindingId: string;
  connectionId: string;
  providerKind: string;
  principalKind: ConnectionPrincipalKind;
  capabilities: string[];
}

export interface WorkflowEnablementTrigger {
  id: string;
  definitionId: string;
  kind: string;
  config: unknown;
  status: "active" | "paused";
}

export interface WorkflowEnablement {
  id: string;
  projectId: string;
  workflowName: string;
  deploymentArtifactId: string;
  commitSha: string;
  remoteBranch: string;
  environment: string;
  owner: WorkflowEnablementOwner;
  connections: WorkflowEnablementConnection[];
  capabilities: string[];
  consentDigest: string;
  status: WorkflowEnablementStatus;
  suspensionReason: string | null;
  updateAvailable: boolean;
  temporary: boolean;
  expiresAt: string | null;
  revision: number;
  triggers: WorkflowEnablementTrigger[];
  createdAt: string;
  updatedAt: string;
}

export interface WorkflowEnablementPreview {
  projectId: string;
  workflowName: string;
  deploymentArtifactId: string;
  deploymentArtifactDigest: string;
  commitSha: string;
  remoteBranch: string;
  environment: string;
  owner: WorkflowEnablementOwner;
  connections: WorkflowEnablementConnection[];
  capabilities: string[];
  consentDigest: string;
  triggerCount: number;
  triggers: Array<{ kind: string; config: unknown }>;
  connectionLabels: Record<string, string>;
}

export type WorkflowEnablementSuspensionReason =
  | "member_removed"
  | "workflow_denied"
  | "environment_denied"
  | "connection_unavailable"
  | "connection_permission_denied"
  | "connection_capability_changed"
  | "expired";

export interface RevalidatedWorkflowEnablement {
  enablement: WorkflowEnablement;
  ownerIdentity: import("../identity.js").Identity;
}
