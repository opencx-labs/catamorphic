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
  /** What Git through the gateway may reach with this alias (ADR 0175). */
  git?: ConnectionGitPolicy;
  /** Which models, and how much, this alias serves sandboxes (ADR 0180). */
  model?: ConnectionModelPolicy;
}

/**
 * Git policy of one alias, enforced by the gateway (ADR 0175).
 * `repositories` are remote paths below the provider's base URL
 * (`org/repo`); absent allows only the project's linked remote. `push`
 * lists branch patterns a push may update (`work/*`, or a full ref such as
 * `refs/tags/v*`); absent allows `work/*`. A remote's default branch and
 * deletions are never allowed, and nothing is pushed without `git:write`.
 */
export interface ConnectionGitPolicy {
  repositories?: readonly string[];
  push?: readonly string[];
}

/** Capabilities of every connection whose provider serves Git (ADR 0175). */
export const GIT_CAPABILITIES = ["git:read", "git:write"] as const;

/**
 * Model policy of one alias, enforced by the gateway's model routes (ADR
 * 0180). `allow` lists model id patterns (`claude-*`); absent allows any
 * model the key reaches. Spending rules are guards (ADR 0183).
 */
export interface ConnectionModelPolicy {
  allow?: readonly string[];
}

/** The capability of a connection whose provider is a model API (ADR 0180). */
export const MODEL_CAPABILITY = "model";

/**
 * Capabilities of a connection whose provider is an HTTP API (ADRs 0162,
 * 0212): the methods a binding may use, lowercase. Agents call them as
 * connection tools; code in sandboxes sends them through the gateway's
 * HTTP route, where `get` also allows HEAD.
 */
export const HTTP_METHOD_CAPABILITIES = [
  "get",
  "post",
  "put",
  "patch",
  "delete",
] as const;

/** Whether `capability` is an HTTP method a binding may use (ADR 0212). */
export function isHttpMethodCapability(capability: string): boolean {
  return HTTP_METHOD_CAPABILITIES.some((method) => method === capability);
}

/**
 * Capabilities the gateway serves as protocols (Git, model APIs) rather
 * than as MCP tools: an alias holding only these is not offered to agents
 * as a connection MCP server.
 */
export function isProtocolCapability(capability: string): boolean {
  return capability.startsWith("git:") || capability === MODEL_CAPABILITY;
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
  git?: ConnectionGitPolicy;
  model?: ConnectionModelPolicy;
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
