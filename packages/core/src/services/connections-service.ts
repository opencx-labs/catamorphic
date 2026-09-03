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
  ConnectionPrincipalKind,
  ConnectionRecord,
  ConnectionRequirementPrincipal,
  EnvironmentConnectionBinding,
  ResolvedConnectionBinding,
} from "./connection-types.js";
import { assertConnectionAlias } from "./connection-types.js";
import type { CredentialVault } from "./credential-vault.js";
import { requireTenantProject } from "./projects-service.js";
import { toJson } from "./run-coordinator.js";

const tracer = getTracer("@catamorphic/core");

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

export class ConnectionsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly vault: CredentialVault,
    private readonly providers: ConnectionProviderRegistry,
    private readonly onMemberConnectionReady?: (
      identity: Identity,
    ) => Promise<void>,
    private readonly onConnectionUnavailable?: (input: {
      identity: Identity;
      connectionId: string;
    }) => Promise<void>,
  ) {}

  providerCatalog(): Array<{ kind: string; displayName: string }> {
    return this.providers.list().map((provider) => ({
      kind: provider.kind,
      displayName: provider.displayName,
    }));
  }

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
    const binding = await this.db
      .selectFrom("environment_connection_bindings")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("alias", "=", args.alias)
      .selectAll()
      .executeTakeFirst();
    if (!binding)
      throw new ConnectionUnavailableError(args.alias, "No binding");
    if (!stringArray(binding.principal_kinds).includes("member")) {
      throw new ConnectionUnavailableError(
        args.alias,
        "This binding does not accept member authorization",
      );
    }
    const provider = this.providers.get(binding.provider_kind);
    if (!provider?.beginAuthorization) {
      throw new ConnectionUnavailableError(
        args.alias,
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
          "catamorphic.project.id": args.projectId,
          "catamorphic.connection.environment": args.environment,
          "catamorphic.connection.alias": args.alias,
          "catamorphic.connection.provider": binding.provider_kind,
        },
      },
      () =>
        provider.beginAuthorization!({
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
          externalUserId: args.identity.externalUserId,
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
      .where("connection.provider_kind", "=", binding.provider_kind)
      .where("connection.principal_kind", "=", "member")
      .where("connection.status", "!=", "revoked")
      .select("connection.id")
      .executeTakeFirst();
    await this.db
      .insertInto("connection_authorization_attempts")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        environment_name: args.environment,
        alias: args.alias,
        provider_kind: binding.provider_kind,
        external_user_id: args.identity.externalUserId,
        reauthorize_connection_id: current?.id ?? null,
        state_hash: hashBearer(state),
        private_state_ref: privateRef?.id ?? null,
        expires_at: new Date(Date.now() + 10 * 60 * 1000),
      })
      .execute();
    return { authorizationId: state, challenge: started.challenge };
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
    const provider = this.providers.get(attempt.provider_kind);
    if (!provider?.completeAuthorization) {
      throw new ConnectionUnavailableError(
        attempt.alias,
        "Authorization is unsupported",
      );
    }
    const completeAuthorization = provider.completeAuthorization;
    const complete = (privateState?: Uint8Array) =>
      completeAuthorization({
        tenantId: args.identity.tenantId,
        projectId: attempt.project_id,
        externalUserId: args.identity.externalUserId,
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
            "catamorphic.project.id": attempt.project_id,
            "catamorphic.connection.environment": attempt.environment_name,
            "catamorphic.connection.alias": attempt.alias,
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
      await this.db
        .updateTable("connection_authorization_attempts")
        .set({ status: "canceled", completed_at: new Date() })
        .where("id", "=", attempt.id)
        .execute();
      if (attempt.private_state_ref) {
        await this.vault.delete({
          tenantId: args.identity.tenantId,
          ref: { id: attempt.private_state_ref },
        });
      }
      throw new ConnectionUnavailableError(
        attempt.alias,
        "Authorization failed",
      );
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
          principalKind: "member",
          label: `${provider.displayName} (${attempt.alias})`,
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
    await this.db
      .updateTable("connection_authorization_attempts")
      .set({ status: "completed", completed_at: new Date() })
      .where("id", "=", attempt.id)
      .execute();
    if (attempt.private_state_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: attempt.private_state_ref },
      });
    }
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
    return this.completeAuthorization({
      identity: {
        tenantId: attempt.tenant_id,
        externalUserId: attempt.external_user_id,
      },
      state: args.state,
      callback: args.callback,
    });
  }

  async create(args: {
    identity: Identity;
    projectId: string;
    providerKind: string;
    principalKind: ConnectionPrincipalKind;
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
    if (
      args.principalKind !== "member" &&
      !hasControlPlanePermission(args.identity, "connections:manage_service")
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const ref = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.material,
    });
    try {
      const row = await this.db
        .insertInto("connections")
        .values({
          tenant_id: args.identity.tenantId,
          project_id:
            args.principalKind === "tenant_service" ? null : args.projectId,
          provider_kind: args.providerKind,
          principal_kind: args.principalKind,
          owner_external_user_id:
            args.principalKind === "member"
              ? args.identity.externalUserId
              : null,
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
    if (
      !hasControlPlanePermission(args.identity, "connections:manage_service")
    ) {
      query = query
        .where("principal_kind", "=", "member")
        .where("owner_external_user_id", "=", args.identity.externalUserId);
    }
    return (
      await query.selectAll().orderBy("created_at", "desc").execute()
    ).map(mapConnection);
  }

  async rotateServiceCredential(args: {
    identity: Identity;
    connectionId: string;
    material: Uint8Array;
  }): Promise<ConnectionRecord> {
    if (
      !hasControlPlanePermission(args.identity, "connections:manage_service")
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const current = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (current.principal_kind === "member" || current.status === "revoked") {
      throw new ConnectionPermissionDeniedError();
    }
    const nextRef = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.material,
    });
    const row = await this.db
      .updateTable("connections")
      .set({
        credential_ref: nextRef.id,
        status: "ready",
        expires_at: null,
        revision: current.revision + 1,
        updated_at: new Date(),
      })
      .where("tenant_id", "=", args.identity.tenantId)
      .where("id", "=", current.id)
      .where("revision", "=", current.revision)
      .returningAll()
      .executeTakeFirst();
    if (!row) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: nextRef,
      });
      throw new ConnectionUnavailableError(current.id, "Rotation raced");
    }
    if (current.credential_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: current.credential_ref },
      });
    }
    await this.resolveWorkflowRequirementsForConnection({
      tenantId: args.identity.tenantId,
      connectionId: current.id,
    });
    await this.audit({
      identity: args.identity,
      projectId: current.project_id ?? undefined,
      connectionId: current.id,
      eventType: "connection.rotated",
      outcome: "allowed",
    });
    return mapConnection(row);
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
    const nextRef = await this.vault.put({
      tenantId: args.identity.tenantId,
      material: args.material,
    });
    const row = await this.db
      .updateTable("connections")
      .set({
        credential_ref: nextRef.id,
        account_summary: toJson(args.account ?? {}),
        scopes: toJson(args.scopes ?? []),
        capabilities: toJson(args.capabilities ?? []),
        expires_at: args.expiresAt ?? null,
        status: "ready",
        revision: current.revision + 1,
        updated_at: new Date(),
      })
      .where("id", "=", current.id)
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
    await this.resolveWorkflowRequirementsForConnection({
      tenantId: args.identity.tenantId,
      connectionId: current.id,
    });
    await this.onMemberConnectionReady?.(args.identity);
    return mapConnection(row);
  }

  async bind(args: {
    identity: Identity;
    projectId: string;
    environment: string;
    alias: string;
    providerKind: string;
    principalKinds: readonly ConnectionPrincipalKind[];
    serviceConnectionId?: string;
    capabilities?: readonly string[];
  }): Promise<EnvironmentConnectionBinding> {
    if (
      !hasControlPlanePermission(args.identity, "connections:manage_service")
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    assertConnectionAlias(args.alias);
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    if (!this.providers.get(args.providerKind)) {
      throw new ConnectionUnavailableError(args.alias, "Unknown provider");
    }
    if (args.serviceConnectionId) {
      const service = await this.requireConnection(
        args.identity,
        args.serviceConnectionId,
      );
      if (
        service.principal_kind === "member" ||
        service.provider_kind !== args.providerKind ||
        !args.principalKinds.includes(
          service.principal_kind as ConnectionPrincipalKind,
        ) ||
        (service.principal_kind === "project_service" &&
          service.project_id !== args.projectId)
      ) {
        throw new ConnectionPermissionDeniedError();
      }
    }
    const row = await this.db
      .insertInto("environment_connection_bindings")
      .values({
        tenant_id: args.identity.tenantId,
        project_id: args.projectId,
        environment_name: args.environment,
        alias: args.alias,
        provider_kind: args.providerKind,
        principal_kinds: toJson(args.principalKinds),
        service_connection_id: args.serviceConnectionId ?? null,
        capabilities: toJson(args.capabilities ?? []),
      })
      .onConflict((oc) =>
        oc.columns(["project_id", "environment_name", "alias"]).doUpdateSet({
          provider_kind: args.providerKind,
          principal_kinds: toJson(args.principalKinds),
          service_connection_id: args.serviceConnectionId ?? null,
          capabilities: toJson(args.capabilities ?? []),
          updated_at: new Date(),
        }),
      )
      .returningAll()
      .executeTakeFirstOrThrow();
    return mapBinding(row);
  }

  async listBindings(args: {
    identity: Identity;
    projectId: string;
    environment?: string;
  }): Promise<EnvironmentConnectionBinding[]> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    let query = this.db
      .selectFrom("environment_connection_bindings")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId);
    if (args.environment) {
      query = query.where("environment_name", "=", args.environment);
    }
    const rows = await query.orderBy("alias").selectAll().execute();
    const mayManage = hasControlPlanePermission(
      args.identity,
      "connections:manage_service",
    );
    const visible = rows.filter(
      (row) =>
        mayManage ||
        identityMayUseConnection(
          args.identity,
          args.projectId,
          row.environment_name,
          row.alias,
        ),
    );
    return Promise.all(
      visible.map(async (row) => {
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
            .where("attachment.environment_name", "=", row.environment_name)
            .where("attachment.alias", "=", row.alias)
            .where(
              "attachment.external_user_id",
              "=",
              args.identity.externalUserId,
            )
            .selectAll("connection")
            .executeTakeFirst(),
          row.service_connection_id
            ? this.db
                .selectFrom("connections")
                .where("tenant_id", "=", args.identity.tenantId)
                .where("id", "=", row.service_connection_id)
                .selectAll()
                .executeTakeFirst()
            : undefined,
        ]);
        return {
          ...mapBinding(row),
          serviceConnectionId: mayManage ? row.service_connection_id : null,
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
    const binding = await this.db
      .selectFrom("environment_connection_bindings")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("alias", "=", args.alias)
      .select(["provider_kind", "principal_kinds"])
      .executeTakeFirst();
    if (
      !binding ||
      binding.provider_kind !== connection.provider_kind ||
      !stringArray(binding.principal_kinds).includes("member")
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
    const bindings = await this.db
      .selectFrom("environment_connection_bindings")
      .where("tenant_id", "=", args.identity.tenantId)
      .where("project_id", "=", args.projectId)
      .where("environment_name", "=", args.environment)
      .where("alias", "in", [...args.aliases])
      .selectAll()
      .execute();
    const resolved: ResolvedConnectionBinding[] = [];
    const missing: Array<{
      alias: string;
      providerKind: string;
      principalKinds: ConnectionPrincipalKind[];
    }> = [];
    for (const alias of args.aliases) {
      const binding = bindings.find((candidate) => candidate.alias === alias);
      if (!binding) throw new ConnectionUnavailableError(alias, "No binding");
      if (
        !identityMayUseConnection(
          args.identity,
          args.projectId,
          args.environment,
          alias,
        )
      ) {
        throw new ConnectionPermissionDeniedError();
      }
      const principals = stringArray(
        binding.principal_kinds,
      ) as ConnectionPrincipalKind[];
      const requiredPrincipal = args.principalsByAlias?.[alias];
      const accepts = (principal: ConnectionPrincipalKind) =>
        principals.includes(principal) &&
        (!requiredPrincipal ||
          requiredPrincipal === "either" ||
          (requiredPrincipal === "member"
            ? principal === "member"
            : principal !== "member")) &&
        (!args.unattended || principal !== "member");
      const acceptablePrincipals = principals.filter(accepts);
      if (acceptablePrincipals.length === 0) {
        throw new ConnectionUnavailableError(
          alias,
          "No permitted principal kind is configured",
        );
      }
      let connectionId: string | null = null;
      if (binding.service_connection_id) {
        const service = await this.requireConnection(
          args.identity,
          binding.service_connection_id,
        );
        if (accepts(service.principal_kind as ConnectionPrincipalKind)) {
          connectionId = service.id;
        }
      }
      if (!connectionId && accepts("member")) {
        const attachment = await this.db
          .selectFrom("member_connection_attachments")
          .where("tenant_id", "=", args.identity.tenantId)
          .where("project_id", "=", args.projectId)
          .where("environment_name", "=", args.environment)
          .where("alias", "=", alias)
          .where("external_user_id", "=", args.identity.externalUserId)
          .select("connection_id")
          .executeTakeFirst();
        connectionId = attachment?.connection_id ?? null;
      }
      if (!connectionId) {
        missing.push({
          alias,
          providerKind: binding.provider_kind,
          principalKinds: acceptablePrincipals,
        });
        continue;
      }
      const connection = await this.requireConnection(
        args.identity,
        connectionId,
      );
      if (
        connection.status !== "ready" ||
        (connection.expires_at && connection.expires_at <= new Date())
      ) {
        missing.push({
          alias,
          providerKind: binding.provider_kind,
          principalKinds: acceptablePrincipals,
        });
        continue;
      }
      resolved.push({
        bindingId: binding.id,
        connectionId,
        alias,
        providerKind: binding.provider_kind,
        principalKind: connection.principal_kind as ConnectionPrincipalKind,
        capabilities: intersectCapabilities(
          stringArray(binding.capabilities),
          stringArray(connection.capabilities),
          identityMayUseConnection(
            args.identity,
            args.projectId,
            args.environment,
            alias,
          )?.capabilities,
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
    const resolved: ResolvedConnectionBinding[] = [];
    for (const selected of args.snapshot) {
      if (
        !identityMayUseConnection(
          args.identity,
          args.projectId,
          args.environment,
          selected.alias,
        )
      ) {
        throw new ConnectionPermissionDeniedError();
      }
      const binding = await this.db
        .selectFrom("environment_connection_bindings")
        .where("tenant_id", "=", args.identity.tenantId)
        .where("project_id", "=", args.projectId)
        .where("environment_name", "=", args.environment)
        .where("id", "=", selected.bindingId)
        .where("alias", "=", selected.alias)
        .where("provider_kind", "=", selected.providerKind)
        .selectAll()
        .executeTakeFirst();
      if (!binding) {
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
      const ready =
        connection.status === "ready" &&
        (!connection.expires_at || connection.expires_at > new Date());
      if (!ready || connection.provider_kind !== selected.providerKind) {
        throw new AuthenticationRequiredError(args.environment, [
          {
            alias: selected.alias,
            providerKind: selected.providerKind,
            principalKinds: stringArray(
              binding.principal_kinds,
            ) as ConnectionPrincipalKind[],
          },
        ]);
      }
      if (selected.principalKind === "member") {
        const attachment = await this.db
          .selectFrom("member_connection_attachments")
          .where("tenant_id", "=", args.identity.tenantId)
          .where("project_id", "=", args.projectId)
          .where("environment_name", "=", args.environment)
          .where("alias", "=", selected.alias)
          .where("external_user_id", "=", args.identity.externalUserId)
          .where("connection_id", "=", selected.connectionId)
          .select("id")
          .executeTakeFirst();
        if (
          !attachment ||
          connection.principal_kind !== "member" ||
          connection.owner_external_user_id !== args.identity.externalUserId
        ) {
          throw new ConnectionUnavailableError(
            selected.alias,
            "The member connection attachment changed",
            selected.connectionId,
          );
        }
      } else if (binding.service_connection_id !== selected.connectionId) {
        throw new ConnectionUnavailableError(
          selected.alias,
          "Assigned service connection changed",
          selected.connectionId,
        );
      }
      resolved.push({
        ...selected,
        capabilities: intersectCapabilities(
          selected.capabilities,
          stringArray(binding.capabilities),
          stringArray(connection.capabilities),
          identityMayUseConnection(
            args.identity,
            args.projectId,
            args.environment,
            selected.alias,
          )?.capabilities,
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
      !hasControlPlanePermission(args.identity, "connections:manage_service")
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
    await this.onConnectionUnavailable?.({
      identity: args.identity,
      connectionId: args.connectionId,
    });
    let revokeFailed = false;
    const provider = this.providers.get(connection.provider_kind);
    const revokeProvider = provider?.revoke;
    if (connection.credential_ref && revokeProvider) {
      try {
        await withSpan(
          {
            tracer,
            name: "connection.revoke",
            attributes: {
              "catamorphic.tenant.id": args.identity.tenantId,
              "catamorphic.connection.id": connection.id,
              "catamorphic.connection.provider": connection.provider_kind,
            },
          },
          () =>
            this.vault.withMaterial({
              tenantId: args.identity.tenantId,
              ref: { id: connection.credential_ref! },
              use: (material) => revokeProvider({ material }),
            }),
        );
      } catch {
        revokeFailed = true;
      }
    }
    if (connection.credential_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: connection.credential_ref },
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
    use: (
      material: Uint8Array,
      connection: Selectable<DB["connections"]>,
    ) => Promise<T>;
  }): Promise<T> {
    const connection = await this.requireConnection(
      args.identity,
      args.connectionId,
    );
    if (
      connection.status !== "ready" ||
      !connection.credential_ref ||
      (connection.expires_at && connection.expires_at <= new Date())
    ) {
      throw new ConnectionUnavailableError(connection.id);
    }
    return this.vault.withMaterial({
      tenantId: args.identity.tenantId,
      ref: { id: connection.credential_ref },
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
    if (!connection.credential_ref || !refresh) {
      if (connection.expires_at <= new Date()) {
        await this.db
          .updateTable("connections")
          .set({ status: "expired", updated_at: new Date() })
          .where("id", "=", connection.id)
          .where("revision", "=", connection.revision)
          .execute();
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
            "catamorphic.connection.id": connection.id,
            "catamorphic.connection.provider": connection.provider_kind,
          },
        },
        () =>
          this.vault.withMaterial({
            tenantId: args.identity.tenantId,
            ref: { id: connection.credential_ref! },
            use: (material) => refresh({ material }),
          }),
      );
    } catch {
      if (connection.expires_at <= new Date()) {
        await this.db
          .updateTable("connections")
          .set({ status: "expired", updated_at: new Date() })
          .where("id", "=", connection.id)
          .where("revision", "=", connection.revision)
          .execute();
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
      ref: { id: connection.credential_ref },
    });
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
    if (!hasControlPlanePermission(args.identity, "connections:view_audit")) {
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
      throw new ConnectionUnavailableError(current.id, "Authorization raced");
    }
    if (current.credential_ref) {
      await this.vault.delete({
        tenantId: args.identity.tenantId,
        ref: { id: current.credential_ref },
      });
    }
    return mapConnection(row);
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

function stringArray(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

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

function mapConnection(row: Selectable<DB["connections"]>): ConnectionRecord {
  return {
    id: row.id,
    projectId: row.project_id,
    providerKind: row.provider_kind,
    principalKind: row.principal_kind as ConnectionPrincipalKind,
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

function mapBinding(
  row: Selectable<DB["environment_connection_bindings"]>,
): EnvironmentConnectionBinding {
  return {
    id: row.id,
    projectId: row.project_id,
    environment: row.environment_name,
    alias: row.alias,
    providerKind: row.provider_kind,
    principalKinds: stringArray(
      row.principal_kinds,
    ) as ConnectionPrincipalKind[],
    serviceConnectionId: row.service_connection_id,
    capabilities: stringArray(row.capabilities),
    memberConnection: null,
    serviceConnection: null,
    createdAt: row.created_at.toISOString(),
    updatedAt: row.updated_at.toISOString(),
  };
}

function mapBindingPrincipal(
  row: Selectable<DB["connections"]>,
  revealId: boolean,
) {
  return {
    connectionId: revealId ? row.id : null,
    principalKind: row.principal_kind as ConnectionPrincipalKind,
    label: row.label,
    status: row.status as ConnectionRecord["status"],
    account: row.account_summary,
    scopes: stringArray(row.scopes),
  };
}
