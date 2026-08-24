import type { Json } from "@catamorphic/db";

export type ConnectionPrincipalKind =
  | "member"
  | "project_service"
  | "tenant_service";
export type ConnectionStatus = "pending" | "ready" | "expired" | "revoked";
export type ConnectionRequirementPrincipal = "member" | "service" | "either";

export const CONNECTION_ALIAS_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

export function assertConnectionAlias(alias: string): void {
  if (!CONNECTION_ALIAS_PATTERN.test(alias)) {
    throw new Error(
      `Invalid connection alias '${alias}': use letters, numbers, underscores, and hyphens`,
    );
  }
}

export interface ConnectionRequirement {
  alias: string;
  principal?: ConnectionRequirementPrincipal;
  capabilities?: string[];
  optional?: boolean;
}

export interface ConnectionRecord {
  id: string;
  projectId: string | null;
  providerKind: string;
  principalKind: ConnectionPrincipalKind;
  ownerExternalUserId: string | null;
  label: string;
  status: ConnectionStatus;
  account: Json;
  scopes: string[];
  capabilities: string[];
  expiresAt: string | null;
  revision: number;
  createdAt: string;
  updatedAt: string;
}

export interface EnvironmentConnectionBinding {
  id: string;
  projectId: string;
  environment: string;
  alias: string;
  providerKind: string;
  principalKinds: ConnectionPrincipalKind[];
  serviceConnectionId: string | null;
  capabilities: string[];
  memberConnection: ConnectionBindingPrincipalStatus | null;
  serviceConnection: ConnectionBindingPrincipalStatus | null;
  createdAt: string;
  updatedAt: string;
}

export interface ConnectionBindingPrincipalStatus {
  connectionId: string | null;
  principalKind: ConnectionPrincipalKind;
  label: string;
  status: ConnectionStatus;
  account: Json;
  scopes: string[];
}

export interface ResolvedConnectionBinding {
  bindingId: string;
  connectionId: string;
  alias: string;
  providerKind: string;
  principalKind: ConnectionPrincipalKind;
  capabilities: readonly string[];
}

export function normalizeConnectionRequirement(
  requirement: string | ConnectionRequirement,
): ConnectionRequirement {
  return typeof requirement === "string" ? { alias: requirement } : requirement;
}

export function connectionMcpServerName(alias: string): string {
  assertConnectionAlias(alias);
  return `connection_${alias}`;
}
