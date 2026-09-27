import type { Json } from "@catamorphic/db";
import type { Identity } from "../identity.js";

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

/** Names of service connections, like provider kinds. */
export const CONNECTION_NAME_PATTERN = /^[a-z0-9][a-z0-9._-]{0,62}$/;

export interface ConnectionRecord {
  id: string;
  projectId: string | null;
  providerKind: string;
  principalKind: ConnectionPrincipalKind;
  /** A service connection's name, which Environment bindings refer to. */
  name: string | null;
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

/**
 * One connection alias an Environment declares in `.work/project.json`
 * (ADR 0172): the provider that backs it, whose authority it accepts, the
 * named service connection that supplies service authority, and the
 * capabilities it narrows to. Committed, so access changes are reviewed
 * like code.
 */
export interface EnvironmentConnectionBinding {
  provider: string;
  principal: ConnectionRequirementPrincipal;
  /** A service connection's name; required when `principal` is `service`. */
  service?: string;
  /** Narrows what the alias may do; absent keeps the connection's own. */
  capabilities?: readonly string[];
}

/** Resolves the bindings of one project Environment, alias to binding. */
export type ConnectionBindingSource = (args: {
  identity: Identity;
  projectId: string;
  environment: string;
}) => Promise<Readonly<Record<string, EnvironmentConnectionBinding>>>;

/** The connection principals a binding's `principal` accepts. */
export function bindingPrincipalKinds(
  principal: ConnectionRequirementPrincipal,
): ConnectionPrincipalKind[] {
  if (principal === "member") return ["member"];
  if (principal === "service") return ["project_service", "tenant_service"];
  return ["member", "project_service", "tenant_service"];
}

export interface ResolvedConnectionBinding {
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
