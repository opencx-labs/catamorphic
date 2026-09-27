import { createHash, randomBytes } from "node:crypto";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import {
  hasControlPlanePermission,
  identityMayUseConnection,
} from "../identity.js";
import type {
  AuthorizationChallenge,
  ConnectionAuthorizationResult,
  ConnectionProviderRegistry,
} from "./connection-providers.js";
import type {
  ConnectionBindingSource,
  ConnectionPrincipalKind,
  ConnectionRecord,
  ConnectionRequirementPrincipal,
  ConnectionStatus,
  EnvironmentConnectionBinding,
  ResolvedConnectionBinding,
} from "./connection-types.js";
import {
  bindingPrincipalKinds,
  CONNECTION_NAME_PATTERN,
} from "./connection-types.js";
import type { CredentialVault } from "./credential-vault.js";
import { requireTenantProject } from "./projects-service.js";
import { toJson } from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");

type ConnectionRow = Selectable<DB["connections"]>;

export class ConnectionNotFoundError extends Error {
  constructor() {
    super("Connection not found");
    this.name = "ConnectionNotFoundError";
  }
}

export class ConnectionPermissionDeniedError extends Error {
  constructor() {
    super("Connection permission denied");
    this.name = "ConnectionPermissionDeniedError";
  }
}

/** Another live service connection in the same scope has this name. */
export class ConnectionNameTakenError extends Error {
  constructor(readonly connectionName: string) {
    super(`A service connection named '${connectionName}' already exists`);
    this.name = "ConnectionNameTakenError";
  }
}

export class AuthenticationRequiredError extends Error {
  constructor(
    readonly environment: string,
    readonly requirements: readonly {
      alias: string;
      providerKind: string;
      principalKinds: ConnectionPrincipalKind[];
    }[],
  ) {
    super("Authentication is required before this workload can start");
    this.name = "AuthenticationRequiredError";
  }
}

export class ConnectionUnavailableError extends Error {
  constructor(
    readonly alias: string,
    message = "Connection is unavailable",
    readonly connectionId?: string,
  ) {
    super(`${message}: ${alias}`);
    this.name = "ConnectionUnavailableError";
  }
}

export interface ConnectionAuditEvent {
  id: string;
  projectId: string | null;
  connectionId: string | null;
  allocationId: string | null;
  actorExternalUserId: string | null;
  eventType: string;
  outcome: string;
  action: string | null;
  argumentsDigest: string | null;
  metadata: Json;
  createdAt: string;
}

export interface ConnectionBindingPrincipalStatus {
  connectionId: string | null;
  principalKind: ConnectionPrincipalKind;
  label: string;
  status: ConnectionStatus;
  account: Json;
  scopes: string[];
}

/**
 * One alias an Environment declares, as its caller sees it: the committed
 * binding plus whether the caller's own and the service authority are ready.
 */
export interface EnvironmentConnectionStatus {
  environment: string;
  alias: string;
  provider: string;
  principal: ConnectionRequirementPrincipal;
  /** The service connection's name; shown to connection administrators. */
  service: string | null;
  capabilities: string[] | null;
  memberConnection: ConnectionBindingPrincipalStatus | null;
  serviceConnection: ConnectionBindingPrincipalStatus | null;
}

export class ConnectionsService {
  private readonly db: Kysely<DB>;
  private readonly vault: CredentialVault;
  private readonly providers: ConnectionProviderRegistry;
  private readonly bindings: ConnectionBindingSource;
  private readonly onMemberConnectionReady?: (
    identity: Identity,
  ) => Promise<void>;
  private readonly onConnectionUnavailable?: (input: {
    identity: Identity;
    connectionId: string;
  }) => Promise<void>;

  constructor(args: {
    db: Kysely<DB>;
    vault: CredentialVault;
    providers: ConnectionProviderRegistry;
    /** The committed (and host-supplied) bindings of an Environment. */
    bindings: ConnectionBindingSource;
    onMemberConnectionReady?: (identity: Identity) => Promise<void>;
    onConnectionUnavailable?: (input: {
      identity: Identity;
      connectionId: string;
    }) => Promise<void>;
  }) {
    this.db = args.db;
    this.vault = args.vault;
    this.providers = args.providers;
    this.bindings = args.bindings;
    this.onMemberConnectionReady = args.onMemberConnectionReady;
    this.onConnectionUnavailable = args.onConnectionUnavailable;
  }

  providerCatalog(): Array<{ kind: string; displayName: string }> {
    return this.providers.list().map((provider) => ({
      kind: provider.kind,
      displayName: provider.displayName,
    }));
  }

  /** Start a member's authorization of one Environment alias. */
  async beginAuthorization(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
    redirectUri: string;
  }): Promise<{ authorizationId: string; challenge: AuthorizationChallenge }> {
    if (
      !identityMayUseConnection(
        args.identity,
        args.projectId,
        args.environment,
        args.alias,
      )
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const binding = await this.requireBinding(args);
    if (!bindingPrincipalKinds(binding.principal).includes("member")) {
      throw new ConnectionUnavailableError(
        args.alias,
        "This binding does not accept member authorization",
      );
    }
    const current = await this.db
      .selectFrom("member_connection_attachments as attachment")
      .innerJoin(
        "connections as connection",
        "connection.id",
        "attachment.connection_id",
      )
      .where("attachment.tenant_id", "=", args.identity.tenantId)
      .where("attachment.project_id", "=", args.projectId)
      .where("attachment.environment_name", "=", args.environment)
      .where("attachment.alias", "=", args.alias)
      .where("attachment.external_user_id", "=", args.identity.externalUserId)
      .where("connection.provider_kind", "=", binding.provider)
      .where("connection.principal_kind", "=", "member")
      .where("connection.status", "!=", "revoked")
      .select("connection.id")
      .executeTakeFirst();
    return this.startAttempt({
      identity: args.identity,
      providerKind: binding.provider,
      projectId: args.projectId,
      redirectUri: args.redirectUri,
      target: {
        environment: args.environment,
        alias: args.alias,
        reauthorizeConnectionId: current?.id ?? null,
      },
    });
  }

  /**
   * An administrator authorizes (or re-authorizes, which rotates) a named
   * service connection through its provider's ordinary challenge.
   */
  async beginServiceAuthorization(args: {
    identity: Identity;
    connectionId: string;
    redirectUri: string;
  }): Promise<{ authorizationId: string; challenge: AuthorizationChallenge }> {
    if (!hasControlPlanePermission(args.identity, "connections:write")) {
      throw new ConnectionPermissionDeniedError();
    }
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (
      connection.principal_kind === "member" ||
      connection.status === "revoked"
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    return this.startAttempt({
      identity: args.identity,
      providerKind: connection.provider_kind,
      projectId: connection.project_id ?? undefined,
      redirectUri: args.redirectUri,
      target: { serviceConnectionId: connection.id },
    });
  }

  /**
   * Start authorizing (or re-authorizing) the caller's personal connection
   * to a provider (ADR 0177): their own account, used for repository import,
   * sync, and pull requests in every project they work in.
   */
  async beginPersonalAuthorization(args: {
    identity: Identity;
    providerKind: string;
    redirectUri: string;
  }): Promise<{ authorizationId: string; challenge: AuthorizationChallenge }> {
    if (!this.providers.get(args.providerKind)) {
      throw new Error(`Unknown connection provider '${args.providerKind}'`);
    }
    const current = await this.personal(args);
    return this.startAttempt({
      identity: args.identity,
      providerKind: args.providerKind,
      redirectUri: args.redirectUri,
      target: { personal: true, reauthorizeConnectionId: current?.id ?? null },
    });
  }

  /**
   * Store a personal connection from authorization completed by the host
   * (or by a personal attempt), replacing the caller's current one.
   */
  async savePersonal(args: {
    identity: Identity;
    providerKind: string;
    authorized: ConnectionAuthorizationResult;
    label?: string;
  }): Promise<ConnectionRecord> {
    const provider = this.providers.get(args.providerKind);
    if (!provider) {
      throw new Error(`Unknown connection provider '${args.providerKind}'`);
    }
    const current = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("tenant_id", "=", args.identity.tenantId)
      .where("principal_kind", "=", "member")
      .where("owner_external_user_id", "=", args.identity.externalUserId)
      .where("provider_kind", "=", args.providerKind)
      .where("project_id", "is", null)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    if (current) {
      const row = await this.replaceCredential({
        identity: args.identity,
        current,
        authorized: args.authorized,
      });
      await this.audit({
        identity: args.identity,
        connectionId: current.id,
        eventType: "connection.rotated",
        outcome: "allowed",
      });
      return row;
    }
    const ref = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.authorized.material,
    });
    try {
      const row = await this.db
        .insertInto("connections")
        .values({
          tenant_id: args.identity.tenantId,
          project_id: null,
          provider_kind: args.providerKind,
          principal_kind: "member",
          owner_external_user_id: args.identity.externalUserId,
          label: args.label ?? provider.displayName,
          status: "ready",
          credential_ref: ref.id,
          account_summary: toJson(args.authorized.account ?? {}),
          scopes: toJson(args.authorized.scopes ?? []),
          capabilities: toJson(args.authorized.capabilities ?? []),
          expires_at: args.authorized.expiresAt ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit({
        identity: args.identity,
        connectionId: row.id,
        eventType: "connection.created",
        outcome: "allowed",
        metadata: { personal: true },
      });
      return mapConnection(row);
    } catch (cause) {
      await this.vault.delete({ tenantId: args.identity.tenantId, ref });
      throw cause;
    }
  }

  /** The caller's live personal connection to a provider, ready or not. */
  async personal(args: {
    identity: Identity;
    providerKind: string;
  }): Promise<ConnectionRecord | undefined> {
    const row = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("tenant_id", "=", args.identity.tenantId)
      .where("principal_kind", "=", "member")
      .where("owner_external_user_id", "=", args.identity.externalUserId)
      .where("provider_kind", "=", args.providerKind)
      .where("project_id", "is", null)
      .where("status", "!=", "revoked")
      .executeTakeFirst();
    return row ? mapConnection(row) : undefined;
  }

  /**
   * The caller's own ready connection to a provider for one project: one
   * they authorized in the project, else their personal one. A lapsed
   * access token still counts; the caller refreshes it before use.
   */
  async ownConnection(args: {
    identity: Identity;
    projectId?: string;
    providerKind: string;
  }): Promise<ConnectionRecord | undefined> {
    const rows = await this.db
      .selectFrom("connections")
      .selectAll()
      .where("tenant_id", "=", args.identity.tenantId)
      .where("principal_kind", "=", "member")
      .where("owner_external_user_id", "=", args.identity.externalUserId)
      .where("provider_kind", "=", args.providerKind)
      .where("status", "=", "ready")
      .where((eb) =>
        args.projectId
          ? eb.or([
              eb("project_id", "=", args.projectId),
              eb("project_id", "is", null),
            ])
          : eb("project_id", "is", null),
      )
      .orderBy("updated_at", "desc")
      .execute();
    const chosen =
      rows.find((row) => row.project_id !== null) ??
      rows.find((row) => row.project_id === null);
    return chosen ? mapConnection(chosen) : undefined;
  }

  /**
   * A live service connection by name: the project's own first, then the
   * tenant's (ADR 0172). Without a project, only the tenant's.
   */
  async serviceConnection(args: {
    tenantId: string;
    projectId?: string;
    name: string;
  }): Promise<ConnectionRecord | undefined> {
    const row = args.projectId
      ? await this.findService({
          tenantId: args.tenantId,
          projectId: args.projectId,
          name: args.name,
        })
      : await this.db
          .selectFrom("connections")
          .selectAll()
          .where("tenant_id", "=", args.tenantId)
          .where("name", "=", args.name)
          .where("principal_kind", "=", "tenant_service")
          .where("status", "!=", "revoked")
          .executeTakeFirst();
    return row ? mapConnection(row) : undefined;
  }

  async authorizationStatus(args: {
    identity: Identity;
    state: string;
  }): Promise<{ status: string }> {
    const attempt = await this.db
      .selectFrom("connection_authorization_attempts")
      .select(["status", "expires_at"])
      .where("tenant_id", "=", args.identity.tenantId)
      .where("external_user_id", "=", args.identity.externalUserId)
      .where("state_hash", "=", hashBearer(args.state))
      .executeTakeFirst();
    if (!attempt)
      throw new ConnectionUnavailableError(
        "authorization",
        "Authorization not found",
      );
    return {
      status:
        attempt.status !== "completed" &&
        attempt.expires_at.getTime() <= Date.now()
          ? "expired"
          : attempt.status,
    };
  }

  async completeAuthorization(args: {
    identity: Identity;
    state: string;
    callback: Readonly<Record<string, string>>;
  }): Promise<ConnectionRecord> {
    const attempt = await this.db
      .updateTable("connection_authorization_attempts")
      .set({ status: "completing" })
      .where("tenant_id", "=", args.identity.tenantId)
      .where("external_user_id", "=", args.identity.externalUserId)
      .where("state_hash", "=", hashBearer(args.state))
      .where("status", "=", "pending")
      .where("expires_at", ">", new Date())
      .returningAll()
      .executeTakeFirst();
    if (!attempt)
      throw new ConnectionUnavailableError("authorization", "Attempt expired");
    const subject =
      attempt.alias ?? attempt.service_connection_id ?? attempt.provider_kind;
    const provider = this.providers.get(attempt.provider_kind);
    const completeAuthorization = provider?.completeAuthorization;
    if (
      !completeAuthorization ||
      (attempt.service_connection_id &&
        !hasControlPlanePermission(args.identity, "connections:write"))
    ) {
      await this.finishAttempt({
        identity: args.identity,
        attempt,
        status: "canceled",
      });
      throw completeAuthorization
        ? new ConnectionPermissionDeniedError()
        : new ConnectionUnavailableError(
            subject,
            "Authorization is unsupported",
          );
    }
    const complete = (privateState?: Uint8Array) =>
      completeAuthorization({
        tenantId: args.identity.tenantId,
        ...(attempt.project_id ? { projectId: attempt.project_id } : {}),
        externalUserId: args.identity.externalUserId,
        principal: attempt.service_connection_id ? "service" : "member",
        callback: args.callback,
        ...(privateState ? { privateState } : {}),
      });
    let authorized: ConnectionAuthorizationResult;
    try {
      authorized = await withSpan(
        {
          tracer,
          name: "connection.authorization.complete",
          attributes: {
            "catamorphic.tenant.id": args.identity.tenantId,
            "user.id": args.identity.externalUserId,
            "catamorphic.project.id": attempt.project_id ?? "",
            "catamorphic.connection.environment":
              attempt.environment_name ?? "",
            "catamorphic.connection.alias": attempt.alias ?? "",
            "catamorphic.connection.id": attempt.service_connection_id ?? "",
            "catamorphic.connection.provider": attempt.provider_kind,
          },
        },
        () =>
          attempt.private_state_ref
            ? this.vault.withMaterial({
                tenantId: args.identity.tenantId,
                ref: { id: attempt.private_state_ref },
                use: complete,
              })
            : complete(),
      );
    } catch {
      await this.finishAttempt({
        identity: args.identity,
        attempt,
        status: "canceled",
      });
      throw new ConnectionUnavailableError(subject, "Authorization failed");
    }
    if (attempt.service_connection_id) {
      const connection = await this.storeServiceCredential({
        identity: args.identity,
        connectionId: attempt.service_connection_id,
        authorized,
      });
      await this.finishAttempt({
        identity: args.identity,
        attempt,
        status: "completed",
      });
      return connection;
    }
    if (attempt.personal) {
      const connection = await this.savePersonal({
        identity: args.identity,
        providerKind: attempt.provider_kind,
        authorized,
      });
      await this.finishAttempt({
        identity: args.identity,
        attempt,
        status: "completed",
      });
      return connection;
    }
    if (!attempt.project_id || !attempt.environment_name || !attempt.alias) {
      throw new ConnectionUnavailableError(subject, "Attempt is malformed");
    }
    const connection = attempt.reauthorize_connection_id
      ? await this.reauthorizeMember({
          identity: args.identity,
          connectionId: attempt.reauthorize_connection_id,
          providerKind: attempt.provider_kind,
          authorized,
        })
      : await this.create({
          identity: args.identity,
          projectId: attempt.project_id,
          providerKind: attempt.provider_kind,
          label: `${provider?.displayName ?? attempt.provider_kind} (${attempt.alias})`,
          material: authorized.material,
          account: authorized.account,
          scopes: authorized.scopes,
          capabilities: authorized.capabilities,
          expiresAt: authorized.expiresAt,
        });
    await this.attachMember({
      identity: args.identity,
      projectId: attempt.project_id,
      environment: attempt.environment_name,
      alias: attempt.alias,
      connectionId: connection.id,
    });
    await this.finishAttempt({
      identity: args.identity,
      attempt,
      status: "completed",
    });
    await this.onMemberConnectionReady?.(args.identity);
    return connection;
  }

  async completeAuthorizationCallback(args: {
    state: string;
    callback: Readonly<Record<string, string>>;
  }): Promise<ConnectionRecord> {
    const attempt = await this.db
      .selectFrom("connection_authorization_attempts")
      .where("state_hash", "=", hashBearer(args.state))
      .where("status", "=", "pending")
      .where("expires_at", ">", new Date())
      .select(["tenant_id", "external_user_id"])
      .executeTakeFirst();
    if (!attempt) {
      throw new ConnectionUnavailableError("authorization", "Attempt expired");
    }
    // The state is the bearer: it was issued to this person, who held the
    // authority to start the attempt, and it expires in ten minutes.
    return this.completeAuthorization({
      identity: {
        tenantId: attempt.tenant_id,
        externalUserId: attempt.external_user_id,
      },
      state: args.state,
      callback: args.callback,
    });
  }

  /** A member's own connection, created with material already in hand. */
  async create(args: {
    identity: Identity;
    projectId: string;
    providerKind: string;
    label: string;
    material: Uint8Array;
    account?: Json;
    scopes?: readonly string[];
    capabilities?: readonly string[];
    expiresAt?: Date;
  }): Promise<ConnectionRecord> {
    if (!this.providers.get(args.providerKind)) {
      throw new Error(`Unknown connection provider '${args.providerKind}'`);
    }
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const ref = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.material,
    });
    try {
      const row = await this.db
        .insertInto("connections")
        .values({
          tenant_id: args.identity.tenantId,
          project_id: args.projectId,
          provider_kind: args.providerKind,
          principal_kind: "member",
          owner_external_user_id: args.identity.externalUserId,
          label: args.label,
          status: "ready",
          credential_ref: ref.id,
          account_summary: toJson(args.account ?? {}),
          scopes: toJson(args.scopes ?? []),
          capabilities: toJson(args.capabilities ?? []),
          expires_at: args.expiresAt ?? null,
        })
        .returningAll()
        .executeTakeFirstOrThrow();
      await this.audit({
        identity: args.identity,
        projectId: args.projectId,
        connectionId: row.id,
        eventType: "connection.created",
        outcome: "allowed",
      });
      return mapConnection(row);
    } catch (cause) {
      await this.vault.delete({ tenantId: args.identity.tenantId, ref });
      throw cause;
    }
  }

  /**
   * Create a named service connection, pending until an administrator
   * authorizes it. `tenant_service` connections serve every project whose
   * Environments bind the name; `project_service` ones serve one project.
   */
  async createService(args: {
    identity: Identity;
    name: string;
    providerKind: string;
    principalKind: "tenant_service" | "project_service";
    projectId?: string;
    label?: string;
  }): Promise<ConnectionRecord> {
    if (!hasControlPlanePermission(args.identity, "connections:write")) {
      throw new ConnectionPermissionDeniedError();
    }
    if (!CONNECTION_NAME_PATTERN.test(args.name)) {
      throw new Error(
        `Invalid service connection name '${args.name}': use lowercase letters, numbers, dots, underscores, and hyphens`,
      );
    }
    const provider = this.providers.get(args.providerKind);
    if (!provider) {
      throw new Error(`Unknown connection provider '${args.providerKind}'`);
    }
    if (args.principalKind === "project_service") {
      if (!args.projectId) {
        throw new Error("A project service connection names its project");
      }
      await requireTenantProject(
        this.db,
        args.identity.tenantId,
        args.projectId,
      );
    }
    const projectId =
      args.principalKind === "project_service" ? args.projectId : undefined;
    const existing = await this.db
      .selectFrom("connections")
      .select("id")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("principal_kind", "=", args.principalKind)
      .where("name", "=", args.name)
      .where("status", "!=", "revoked")
      .$if(projectId !== undefined, (query) =>
        query.where("project_id", "=", projectId ?? ""),
      )
      .executeTakeFirst();
    if (existing) throw new ConnectionNameTakenError(args.name);
    const row = await this.db
      .insertInto("connections")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: projectId ?? null,
        provider_kind: args.providerKind,
        principal_kind: args.principalKind,
        name: args.name,
        owner_external_user_id: null,
        label: args.label ?? `${provider.displayName} (${args.name})`,
        status: "pending",
        credential_ref: null,
      })
      .returningAll()
      .executeTakeFirstOrThrow()
      .catch((error: unknown) => {
        throw isUniqueViolation(error)
          ? new ConnectionNameTakenError(args.name)
          : error;
      });
    await this.audit({
      identity: args.identity,
      projectId,
      connectionId: row.id,
      eventType: "connection.created",
      outcome: "allowed",
      metadata: { name: args.name, principalKind: args.principalKind },
    });
    return mapConnection(row);
  }

  async list(args: {
    identity: Identity;
    projectId?: string;
  }): Promise<ConnectionRecord[]> {
    let query = this.db
      .selectFrom("connections")
      .where("tenant_id", "=", args.identity.tenantId);
    if (args.projectId) {
      query = query.where((eb) =>
        eb.or([
          eb("project_id", "=", args.projectId as string),
          eb("project_id", "is", null),
        ]),
      );
    }
    if (!hasControlPlanePermission(args.identity, "connections:read")) {
      query = query
        .where("principal_kind", "=", "member")
        .where("owner_external_user_id", "=", args.identity.externalUserId);
    }
    return (
      await query.selectAll().orderBy("created_at", "desc").execute()
    ).map(mapConnection);
  }

  /** The organization's live service connections, by name. */
  async listServices(args: {
    identity: Identity;
    projectId?: string;
  }): Promise<ConnectionRecord[]> {
    if (!hasControlPlanePermission(args.identity, "connections:read")) {
      throw new ConnectionPermissionDeniedError();
    }
    const rows = await this.db
      .selectFrom("connections")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("principal_kind", "!=", "member")
      .where("status", "!=", "revoked")
      .$if(args.projectId !== undefined, (query) =>
        query.where((eb) =>
          eb.or([
            eb("project_id", "=", args.projectId ?? ""),
            eb("project_id", "is", null),
          ]),
        ),
      )
      .selectAll()
      .orderBy("name")
      .execute();
    return rows.map(mapConnection);
  }

  /** Host-side adoption/refresh of an already authenticated member account. */
  async replaceMemberCredential(args: {
    identity: Identity;
    connectionId: string;
    material: Uint8Array;
    account?: Json;
    scopes?: readonly string[];
    capabilities?: readonly string[];
    expiresAt?: Date;
  }): Promise<ConnectionRecord> {
    const current = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (
      current.principal_kind !== "member" ||
      current.owner_external_user_id !== args.identity.externalUserId
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const row = await this.replaceCredential({
      identity: args.identity,
      current,
      authorized: {
        material: args.material,
        account: args.account,
        scopes: args.scopes,
        capabilities: args.capabilities,
        expiresAt: args.expiresAt,
      },
    });
    await this.resolveWorkflowRequirementsForConnection({
      tenantId: args.identity.tenantId,
      connectionId: current.id,
    });
    await this.onMemberConnectionReady?.(args.identity);
    return row;
  }

  /**
   * Each alias an Environment declares, with the caller's own and the
   * service authority behind it. Connection administrators see every alias
   * and the service names; others only aliases they may use.
   */
  async listBindings(args: {
    identity: Identity;
    projectId: string;
    environment: string;
  }): Promise<EnvironmentConnectionStatus[]> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const bindings = await this.bindings(args);
    const mayManage = hasControlPlanePermission(
      args.identity,
      "connections:read",
    );
    const visible = Object.entries(bindings)
      .filter(
        ([alias]) =>
          mayManage ||
          identityMayUseConnection(
            args.identity,
            args.projectId,
            args.environment,
            alias,
          ),
      )
      .sort(([a], [b]) => a.localeCompare(b));
    return Promise.all(
      visible.map(async ([alias, binding]) => {
        const [memberConnection, serviceConnection] = await Promise.all([
          this.db
            .selectFrom("member_connection_attachments as attachment")
            .innerJoin(
              "connections as connection",
              "connection.id",
              "attachment.connection_id",
            )
            .where("attachment.tenant_id", "=", args.identity.tenantId)
            .where("attachment.project_id", "=", args.projectId)
            .where("attachment.environment_name", "=", args.environment)
            .where("attachment.alias", "=", alias)
            .where(
              "attachment.external_user_id",
              "=",
              args.identity.externalUserId,
            )
            .selectAll("connection")
            .executeTakeFirst(),
          binding.service
            ? this.findService({
                tenantId: args.identity.tenantId,
                projectId: args.projectId,
                name: binding.service,
              })
            : undefined,
        ]);
        return {
          environment: args.environment,
          alias,
          provider: binding.provider,
          principal: binding.principal,
          service: mayManage ? (binding.service ?? null) : null,
          capabilities: binding.capabilities ? [...binding.capabilities] : null,
          memberConnection: memberConnection
            ? mapBindingPrincipal(memberConnection, true)
            : null,
          serviceConnection: serviceConnection
            ? mapBindingPrincipal(serviceConnection, mayManage)
            : null,
        };
      }),
    );
  }

  async attachMember(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
    connectionId: string;
  }): Promise<void> {
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (
      connection.principal_kind !== "member" ||
      connection.owner_external_user_id !== args.identity.externalUserId
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const binding = (await this.bindings(args))[args.alias];
    if (
      !binding ||
      binding.provider !== connection.provider_kind ||
      !bindingPrincipalKinds(binding.principal).includes("member")
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    await this.db
      .insertInto("member_connection_attachments")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        environment_name: args.environment,
        alias: args.alias,
        external_user_id: args.identity.externalUserId,
        connection_id: args.connectionId,
      })
      .onConflict((oc) =>
        oc
          .columns([
            "project_id",
            "environment_name",
            "alias",
            "external_user_id",
          ])
          .doUpdateSet({
            connection_id: args.connectionId,
          }),
      )
      .execute();
    await this.resolveWorkflowRequirements({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
      environment: args.environment,
      alias: args.alias,
      externalUserId: args.identity.externalUserId,
    });
  }

  async detachMember(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
  }): Promise<void> {
    if (
      !identityMayUseConnection(
        args.identity,
        args.projectId,
        args.environment,
        args.alias,
      )
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const attachment = await this.db
      .selectFrom("member_connection_attachments")
      .select("connection_id")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("alias", "=", args.alias)
      .where("external_user_id", "=", args.identity.externalUserId)
      .executeTakeFirst();
    await this.db
      .deleteFrom("member_connection_attachments")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("alias", "=", args.alias)
      .where("external_user_id", "=", args.identity.externalUserId)
      .execute();
    if (attachment) {
      await this.onConnectionUnavailable?.({
        identity: args.identity,
        connectionId: attachment.connection_id,
      });
    }
  }

  async resolve(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    aliases: readonly string[];
    principalsByAlias?: Readonly<
      Record<string, ConnectionRequirementPrincipal>
    >;
    unattended?: boolean;
  }): Promise<ResolvedConnectionBinding[]> {
    const bindings = await this.bindings(args);
    const resolved: ResolvedConnectionBinding[] = [];
    const missing: Array<{
      alias: string;
      providerKind: string;
      principalKinds: ConnectionPrincipalKind[];
    }> = [];
    for (const alias of args.aliases) {
      const binding = bindings[alias];
      if (!binding) throw new ConnectionUnavailableError(alias, "No binding");
      const use = identityMayUseConnection(
        args.identity,
        args.projectId,
        args.environment,
        alias,
      );
      if (!use) throw new ConnectionPermissionDeniedError();
      const requiredPrincipal = args.principalsByAlias?.[alias];
      const accepts = (principal: ConnectionPrincipalKind) =>
        (!requiredPrincipal ||
          requiredPrincipal === "either" ||
          (requiredPrincipal === "member"
            ? principal === "member"
            : principal !== "member")) &&
        (!args.unattended || principal !== "member");
      const acceptablePrincipals = bindingPrincipalKinds(
        binding.principal,
      ).filter(accepts);
      if (acceptablePrincipals.length === 0) {
        throw new ConnectionUnavailableError(
          alias,
          "No permitted principal kind is configured",
        );
      }
      const accepted = (connection: ConnectionRow | undefined) =>
        connection &&
        connection.provider_kind === binding.provider &&
        acceptablePrincipals.includes(
          connection.principal_kind as ConnectionPrincipalKind,
        )
          ? connection
          : undefined;
      const connection =
        (binding.service
          ? accepted(
              await this.findService({
                tenantId: args.identity.tenantId,
                projectId: args.projectId,
                name: binding.service,
              }),
            )
          : undefined) ??
        (acceptablePrincipals.includes("member")
          ? accepted(
              await this.attachedMemberConnection({
                identity: args.identity,
                projectId: args.projectId,
                environment: args.environment,
                alias,
              }),
            )
          : undefined);
      if (!connection || !isReady(connection)) {
        missing.push({
          alias,
          providerKind: binding.provider,
          principalKinds: acceptablePrincipals,
        });
        continue;
      }
      resolved.push({
        connectionId: connection.id,
        alias,
        providerKind: binding.provider,
        principalKind: connection.principal_kind as ConnectionPrincipalKind,
        capabilities: intersectCapabilities(
          stringArray(connection.capabilities),
          binding.capabilities,
          use.capabilities,
        ),
      });
    }
    if (missing.length > 0) {
      throw new AuthenticationRequiredError(args.environment, missing);
    }
    return resolved;
  }

  /** Revalidates a trigger's immutable service authorization selection. */
  async resolveSnapshot(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    snapshot: readonly ResolvedConnectionBinding[];
  }): Promise<ResolvedConnectionBinding[]> {
    const bindings = await this.bindings(args);
    const resolved: ResolvedConnectionBinding[] = [];
    for (const selected of args.snapshot) {
      const use = identityMayUseConnection(
        args.identity,
        args.projectId,
        args.environment,
        selected.alias,
      );
      if (!use) throw new ConnectionPermissionDeniedError();
      const binding = bindings[selected.alias];
      if (
        !binding ||
        binding.provider !== selected.providerKind ||
        !bindingPrincipalKinds(binding.principal).includes(
          selected.principalKind,
        )
      ) {
        throw new ConnectionUnavailableError(
          selected.alias,
          "Trigger connection binding changed",
          selected.connectionId,
        );
      }
      const connection = await this.requireConnection(
        args.identity,
        selected.connectionId,
      );
      if (
        !isReady(connection) ||
        connection.provider_kind !== selected.providerKind
      ) {
        throw new AuthenticationRequiredError(args.environment, [
          {
            alias: selected.alias,
            providerKind: selected.providerKind,
            principalKinds: bindingPrincipalKinds(binding.principal),
          },
        ]);
      }
      if (selected.principalKind === "member") {
        const attached = await this.attachedMemberConnection({
          identity: args.identity,
          projectId: args.projectId,
          environment: args.environment,
          alias: selected.alias,
        });
        if (
          attached?.id !== selected.connectionId ||
          connection.principal_kind !== "member" ||
          connection.owner_external_user_id !== args.identity.externalUserId
        ) {
          throw new ConnectionUnavailableError(
            selected.alias,
            "The member connection attachment changed",
            selected.connectionId,
          );
        }
      } else {
        const service = binding.service
          ? await this.findService({
              tenantId: args.identity.tenantId,
              projectId: args.projectId,
              name: binding.service,
            })
          : undefined;
        if (service?.id !== selected.connectionId) {
          throw new ConnectionUnavailableError(
            selected.alias,
            "Assigned service connection changed",
            selected.connectionId,
          );
        }
      }
      resolved.push({
        ...selected,
        capabilities: intersectCapabilities(
          selected.capabilities,
          binding.capabilities,
          stringArray(connection.capabilities),
          use.capabilities,
        ),
      });
    }
    return resolved;
  }

  async revoke(args: {
    identity: Identity;
    connectionId: string;
  }): Promise<void> {
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    const owns =
      connection.principal_kind === "member" &&
      connection.owner_external_user_id === args.identity.externalUserId;
    if (
      !owns &&
      !hasControlPlanePermission(args.identity, "connections:write")
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("connection_capability_grants")
        .set({ revoked_at: new Date() })
        .where("connection_id", "=", args.connectionId)
        .where("revoked_at", "is", null)
        .execute();
      await trx
        .updateTable("connections")
        .set({
          status: "revoked",
          credential_ref: null,
          revision: connection.revision + 1,
          updated_at: new Date(),
        })
        .where("id", "=", args.connectionId)
        .where("tenant_id", "=", args.identity.tenantId)
        .execute();
    });
    await this.release(connection);
    await this.onConnectionUnavailable?.({
      identity: args.identity,
      connectionId: args.connectionId,
    });
    let revokeFailed = false;
    const provider = this.providers.get(connection.provider_kind);
    const revokeProvider = provider?.revoke;
    const credentialRef = connection.credential_ref;
    if (credentialRef && revokeProvider) {
      try {
        await withSpan(
          {
            tracer,
            name: "connection.revoke",
            attributes: {
              "catamorphic.tenant.id": args.identity.tenantId,
              "user.id": args.identity.externalUserId,
              "catamorphic.connection.id": connection.id,
              "catamorphic.connection.provider": connection.provider_kind,
            },
          },
          () =>
            this.vault.withMaterial({
              tenantId: args.identity.tenantId,
              ref: { id: credentialRef },
              use: (material) => revokeProvider({ material }),
            }),
        );
      } catch {
        revokeFailed = true;
      }
    }
    if (credentialRef) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: credentialRef },
      });
    }
    await this.audit({
      identity: args.identity,
      projectId: connection.project_id ?? undefined,
      connectionId: connection.id,
      eventType: "connection.revoked",
      outcome: revokeFailed ? "error" : "allowed",
      ...(revokeFailed
        ? { metadata: { providerRevocation: "failed_closed" } }
        : {}),
    });
  }

  async withCredential<T>(args: {
    identity: Identity;
    connectionId: string;
    use: (material: Uint8Array, connection: ConnectionRow) => Promise<T>;
  }): Promise<T> {
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    const credentialRef = connection.credential_ref;
    if (!isReady(connection) || !credentialRef) {
      throw new ConnectionUnavailableError(connection.id);
    }
    return this.vault.withMaterial({
      tenantId: args.identity.tenantId,
      ref: { id: credentialRef },
      use: (material) => args.use(material, connection),
    });
  }

  async refreshIfNeeded(args: {
    identity: Identity;
    connectionId: string;
    minimumTtlSeconds?: number;
  }): Promise<void> {
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    const threshold = new Date(
      Date.now() + (args.minimumTtlSeconds ?? 60) * 1000,
    );
    if (!connection.expires_at || connection.expires_at > threshold) return;
    const provider = this.providers.get(connection.provider_kind);
    const refresh = provider?.refresh;
    const credentialRef = connection.credential_ref;
    if (!credentialRef || !refresh) {
      if (connection.expires_at <= new Date()) {
        await this.markExpired(connection);
      }
      return;
    }
    let refreshed: ConnectionAuthorizationResult;
    try {
      refreshed = await withSpan(
        {
          tracer,
          name: "connection.refresh",
          attributes: {
            "catamorphic.tenant.id": args.identity.tenantId,
            "user.id": args.identity.externalUserId,
            "catamorphic.connection.id": connection.id,
            "catamorphic.connection.provider": connection.provider_kind,
          },
        },
        () =>
          this.vault.withMaterial({
            tenantId: args.identity.tenantId,
            ref: { id: credentialRef },
            use: (material) => refresh({ material }),
          }),
      );
    } catch {
      if (connection.expires_at <= new Date()) {
        await this.markExpired(connection);
      }
      throw new ConnectionUnavailableError(connection.id, "Refresh failed");
    }
    const nextRef = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: refreshed.material,
    });
    const updated = await this.db
      .updateTable("connections")
      .set({
        credential_ref: nextRef.id,
        status: "ready",
        account_summary: toJson(
          refreshed.account ?? connection.account_summary,
        ),
        scopes: toJson(refreshed.scopes ?? stringArray(connection.scopes)),
        capabilities: toJson(
          refreshed.capabilities ?? stringArray(connection.capabilities),
        ),
        expires_at: refreshed.expiresAt ?? null,
        revision: connection.revision + 1,
        updated_at: new Date(),
      })
      .where("id", "=", connection.id)
      .where("tenant_id", "=", args.identity.tenantId)
      .where("revision", "=", connection.revision)
      .where("status", "=", "ready")
      .returning("id")
      .executeTakeFirst();
    if (!updated) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: nextRef,
      });
      return;
    }
    await this.vault.delete({
      tenantId: args.identity.tenantId,
      ref: { id: credentialRef },
    });
    await this.release(connection);
  }

  async audit(args: {
    identity: Identity;
    projectId?: string;
    connectionId?: string;
    allocationId?: string;
    eventType: string;
    outcome: "allowed" | "denied" | "error";
    action?: string;
    argumentsDigest?: string;
    metadata?: Json;
  }): Promise<void> {
    await this.db
      .insertInto("connection_audit_events")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId ?? null,
        connection_id: args.connectionId ?? null,
        allocation_id: args.allocationId ?? null,
        actor_external_user_id: args.identity.externalUserId,
        event_type: args.eventType,
        outcome: args.outcome,
        action: args.action ?? null,
        arguments_digest: args.argumentsDigest ?? null,
        metadata: toJson(args.metadata ?? {}),
      })
      .execute();
  }

  async listAudit(args: {
    identity: Identity;
    projectId?: string;
    limit?: number;
  }): Promise<ConnectionAuditEvent[]> {
    if (!hasControlPlanePermission(args.identity, "connections:read")) {
      throw new ConnectionPermissionDeniedError();
    }
    let query = this.db
      .selectFrom("connection_audit_events")
      .where("tenant_id", "=", args.identity.tenantId);
    if (args.projectId) query = query.where("project_id", "=", args.projectId);
    const rows = await query
      .selectAll()
      .orderBy("created_at", "desc")
      .limit(Math.min(args.limit ?? 100, 500))
      .execute();
    return rows.map((row) => ({
      id: String(row.id),
      projectId: row.project_id,
      connectionId: row.connection_id,
      allocationId: row.allocation_id,
      actorExternalUserId: row.actor_external_user_id,
      eventType: row.event_type,
      outcome: row.outcome,
      action: row.action,
      argumentsDigest: row.arguments_digest,
      metadata: row.metadata,
      createdAt: row.created_at.toISOString(),
    }));
  }

  async parkWorkflowRequirement(args: {
    identity: Identity;
    projectId: string;
    workflowRunId: string;
    workflowStepAttemptId: string;
    executionJobId: string;
    allocationId: string;
    alias: string;
    connectionId: string;
  }): Promise<string> {
    const allocation = await this.db
      .selectFrom("execution_allocations")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("id", "=", args.allocationId)
      .where("status", "=", "active")
      .select("environment_name")
      .executeTakeFirst();
    if (!allocation) {
      throw new ConnectionUnavailableError(
        args.alias,
        "Allocation unavailable",
      );
    }
    const existing = await this.db
      .selectFrom("connection_action_requirements")
      .where("execution_job_id", "=", args.executionJobId)
      .where("status", "=", "pending")
      .select("id")
      .executeTakeFirst();
    if (existing) return existing.id;
    const row = await this.db
      .insertInto("connection_action_requirements")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        workflow_run_id: args.workflowRunId,
        workflow_step_attempt_id: args.workflowStepAttemptId,
        execution_job_id: args.executionJobId,
        allocation_id: args.allocationId,
        connection_id: args.connectionId,
        environment_name: allocation.environment_name,
        alias: args.alias,
        external_user_id: args.identity.externalUserId,
      })
      .returning("id")
      .executeTakeFirstOrThrow();
    return row.id;
  }

  private async requireBinding(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
  }): Promise<EnvironmentConnectionBinding> {
    const binding = (await this.bindings(args))[args.alias];
    if (!binding) {
      throw new ConnectionUnavailableError(args.alias, "No binding");
    }
    return binding;
  }

  private async startAttempt(args: {
    identity: Identity;
    providerKind: string;
    projectId?: string;
    redirectUri: string;
    target:
      | {
          environment: string;
          alias: string;
          reauthorizeConnectionId: string | null;
        }
      | { serviceConnectionId: string }
      | { personal: true; reauthorizeConnectionId: string | null };
  }): Promise<{ authorizationId: string; challenge: AuthorizationChallenge }> {
    const subject =
      "alias" in args.target
        ? args.target.alias
        : "serviceConnectionId" in args.target
          ? args.target.serviceConnectionId
          : args.providerKind;
    const provider = this.providers.get(args.providerKind);
    const beginAuthorization = provider?.beginAuthorization;
    if (!beginAuthorization) {
      throw new ConnectionUnavailableError(
        subject,
        "Authorization is unsupported",
      );
    }
    const state = randomBearer();
    const started = await withSpan(
      {
        tracer,
        name: "connection.authorization.begin",
        attributes: {
          "catamorphic.tenant.id": args.identity.tenantId,
          "user.id": args.identity.externalUserId,
          "catamorphic.project.id": args.projectId ?? "",
          "catamorphic.connection.provider": args.providerKind,
          ...("alias" in args.target
            ? {
                "catamorphic.connection.environment": args.target.environment,
                "catamorphic.connection.alias": args.target.alias,
              }
            : "serviceConnectionId" in args.target
              ? { "catamorphic.connection.id": args.target.serviceConnectionId }
              : { "catamorphic.connection.personal": true }),
        },
      },
      () =>
        beginAuthorization({
          tenantId: args.identity.tenantId,
          ...(args.projectId ? { projectId: args.projectId } : {}),
          externalUserId: args.identity.externalUserId,
          principal:
            "serviceConnectionId" in args.target ? "service" : "member",
          redirectUri: args.redirectUri,
          state,
        }),
    );
    const privateRef = started.privateState
      ? await this.vault.put({
          tenantId: args.identity.tenantId,
          material: started.privateState,
        })
      : undefined;
    await this.db
      .insertInto("connection_authorization_attempts")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId ?? null,
        provider_kind: args.providerKind,
        external_user_id: args.identity.externalUserId,
        state_hash: hashBearer(state),
        private_state_ref: privateRef?.id ?? null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
        ...("alias" in args.target
          ? {
              environment_name: args.target.environment,
              alias: args.target.alias,
              reauthorize_connection_id: args.target.reauthorizeConnectionId,
            }
          : "serviceConnectionId" in args.target
            ? { service_connection_id: args.target.serviceConnectionId }
            : {
                personal: true,
                reauthorize_connection_id: args.target.reauthorizeConnectionId,
              }),
      })
      .execute();
    return { authorizationId: state, challenge: started.challenge };
  }

  private async finishAttempt(args: {
    identity: Identity;
    attempt: Selectable<DB["connection_authorization_attempts"]>;
    status: "completed" | "canceled";
  }): Promise<void> {
    await this.db
      .updateTable("connection_authorization_attempts")
      .set({ status: args.status, completed_at: new Date() })
      .where("id", "=", args.attempt.id)
      .execute();
    if (args.attempt.private_state_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: args.attempt.private_state_ref },
      });
    }
  }

  /** A completed service authorization becomes the connection's credential. */
  private async storeServiceCredential(args: {
    identity: Identity;
    connectionId: string;
    authorized: ConnectionAuthorizationResult;
  }): Promise<ConnectionRecord> {
    const current = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (current.principal_kind === "member" || current.status === "revoked") {
      throw new ConnectionPermissionDeniedError();
    }
    const row = await this.replaceCredential({
      identity: args.identity,
      current,
      authorized: args.authorized,
    });
    await this.resolveWorkflowRequirementsForConnection({
      tenantId: args.identity.tenantId,
      connectionId: current.id,
    });
    await this.audit({
      identity: args.identity,
      projectId: current.project_id ?? undefined,
      connectionId: current.id,
      eventType:
        current.credential_ref === null
          ? "connection.authorized"
          : "connection.rotated",
      outcome: "allowed",
    });
    return row;
  }

  /**
   * Seal new material, point the connection at it, and drop the old
   * credential and anything a provider held for it.
   */
  private async replaceCredential(args: {
    identity: Identity;
    current: ConnectionRow;
    authorized: ConnectionAuthorizationResult;
  }): Promise<ConnectionRecord> {
    const { current } = args;
    const nextRef = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.authorized.material,
    });
    const row = await this.db
      .updateTable("connections")
      .set({
        credential_ref: nextRef.id,
        status: "ready",
        account_summary: toJson(args.authorized.account ?? {}),
        scopes: toJson(args.authorized.scopes ?? []),
        capabilities: toJson(args.authorized.capabilities ?? []),
        expires_at: args.authorized.expiresAt ?? null,
        revision: current.revision + 1,
        updated_at: new Date(),
      })
      .where("id", "=", current.id)
      .where("tenant_id", "=", args.identity.tenantId)
      .where("revision", "=", current.revision)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: nextRef,
      });
      throw new ConnectionUnavailableError(
        current.id,
        "Credential update raced",
      );
    }
    if (current.credential_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: current.credential_ref },
      });
    }
    await this.release(current);
    return mapConnection(row);
  }

  private async release(connection: ConnectionRow): Promise<void> {
    await this.providers
      .get(connection.provider_kind)
      ?.release?.({ connectionId: connection.id })
      .catch(() => {});
  }

  private async markExpired(connection: ConnectionRow): Promise<void> {
    await this.db
      .updateTable("connections")
      .set({ status: "expired", updated_at: new Date() })
      .where("id", "=", connection.id)
      .where("revision", "=", connection.revision)
      .execute();
  }

  /**
   * The live service connection a binding names: the project's own first,
   * then the tenant's.
   */
  private async findService(args: {
    tenantId: string;
    projectId: string;
    name: string;
  }): Promise<ConnectionRow | undefined> {
    const rows = await this.db
      .selectFrom("connections")
      .where("tenant_id", "=", args.tenantId)
      .where("name", "=", args.name)
      .where("status", "!=", "revoked")
      .where((eb) =>
        eb.or([
          eb.and([
            eb("principal_kind", "=", "project_service"),
            eb("project_id", "=", args.projectId),
          ]),
          eb("principal_kind", "=", "tenant_service"),
        ]),
      )
      .selectAll()
      .execute();
    return (
      rows.find((row) => row.principal_kind === "project_service") ?? rows[0]
    );
  }

  private async attachedMemberConnection(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
  }): Promise<ConnectionRow | undefined> {
    return this.db
      .selectFrom("member_connection_attachments as attachment")
      .innerJoin(
        "connections as connection",
        "connection.id",
        "attachment.connection_id",
      )
      .where("attachment.tenant_id", "=", args.identity.tenantId)
      .where("attachment.project_id", "=", args.projectId)
      .where("attachment.environment_name", "=", args.environment)
      .where("attachment.alias", "=", args.alias)
      .where("attachment.external_user_id", "=", args.identity.externalUserId)
      .selectAll("connection")
      .executeTakeFirst();
  }

  private async resolveWorkflowRequirements(args: {
    tenantId: string;
    projectId: string;
    environment: string;
    alias: string;
    externalUserId?: string;
  }): Promise<void> {
    const now = new Date();
    await this.db.transaction().execute(async (transaction) => {
      let query = transaction
        .updateTable("connection_action_requirements")
        .set({ status: "resolved", resolved_at: now })
        .where("tenant_id", "=", args.tenantId)
        .where("project_id", "=", args.projectId)
        .where("environment_name", "=", args.environment)
        .where("alias", "=", args.alias)
        .where("status", "=", "pending");
      if (args.externalUserId) {
        query = query.where("external_user_id", "=", args.externalUserId);
      }
      const resolved = await query.returning("execution_job_id").execute();
      if (resolved.length === 0) return;
      await transaction
        .updateTable("execution_jobs")
        .set({ available_at: now, updated_at: now })
        .where(
          "id",
          "in",
          resolved.map((item) => item.execution_job_id),
        )
        .where("status", "=", "pending")
        .execute();
    });
  }

  private async resolveWorkflowRequirementsForConnection(args: {
    tenantId: string;
    connectionId: string;
  }): Promise<void> {
    const now = new Date();
    await this.db.transaction().execute(async (transaction) => {
      const resolved = await transaction
        .updateTable("connection_action_requirements")
        .set({ status: "resolved", resolved_at: now })
        .where("tenant_id", "=", args.tenantId)
        .where("connection_id", "=", args.connectionId)
        .where("status", "=", "pending")
        .returning("execution_job_id")
        .execute();
      if (resolved.length === 0) return;
      await transaction
        .updateTable("execution_jobs")
        .set({ available_at: now, updated_at: now })
        .where(
          "id",
          "in",
          resolved.map((item) => item.execution_job_id),
        )
        .where("status", "=", "pending")
        .execute();
    });
  }

  private async reauthorizeMember(args: {
    identity: Identity;
    connectionId: string;
    providerKind: string;
    authorized: ConnectionAuthorizationResult;
  }): Promise<ConnectionRecord> {
    const current = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (
      current.principal_kind !== "member" ||
      current.owner_external_user_id !== args.identity.externalUserId ||
      current.provider_kind !== args.providerKind ||
      current.status === "revoked"
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    return this.replaceCredential({
      identity: args.identity,
      current,
      authorized: args.authorized,
    });
  }

  private async requireConnection(identity: Identity, id: string) {
    const row = await this.db
      .selectFrom("connections")
      .where("tenant_id", "=", identity.tenantId)
      .where("id", "=", id)
      .selectAll()
      .executeTakeFirst();
    if (!row) throw new ConnectionNotFoundError();
    return row;
  }
}

export function hashBearer(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

export function randomBearer(): string {
  return randomBytes(32).toString("base64url");
}

function isReady(connection: ConnectionRow): boolean {
  return (
    connection.status === "ready" &&
    (!connection.expires_at || connection.expires_at > new Date())
  );
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    error.code === "23505"
  );
}

function stringArray(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

/** Capabilities every given layer allows; an absent layer does not narrow. */
function intersectCapabilities(
  ...layers: Array<readonly string[] | undefined>
): string[] {
  const concrete = layers.filter(
    (layer): layer is readonly string[] => layer !== undefined,
  );
  if (concrete.length === 0) return [];
  return (
    concrete[0]?.filter((capability) =>
      concrete.slice(1).every((layer) => layer.includes(capability)),
    ) ?? []
  );
}

function mapConnection(row: ConnectionRow): ConnectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    providerKind: row.provider_kind,
    principalKind: row.principal_kind as ConnectionPrincipalKind,
    name: row.name,
    ownerExternalUserId: row.owner_external_user_id,
    label: row.label,
    status: row.status as ConnectionRecord["status"],
    account: row.account_summary,
    scopes: stringArray(row.scopes),
    capabilities: stringArray(row.capabilities),
    expiresAt: row.expires_at?.toISOString() ?? null,
    revision: row.revision,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapBindingPrincipal(
  row: ConnectionRow,
  revealId: boolean,
): ConnectionBindingPrincipalStatus {
  return {
    connectionId: revealId ? row.id : null,
    principalKind: row.principal_kind as ConnectionPrincipalKind,
    label: row.label,
    status: row.status as ConnectionRecord["status"],
    account: row.account_summary,
    scopes: stringArray(row.scopes),
  };
}
