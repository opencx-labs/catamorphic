import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { WorkflowGraph } from "@catamorphic/parser";
import type { Kysely, Selectable } from "kysely";
import type { Identity } from "../identity.js";
import { hasControlPlanePermission } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import {
  AuthenticationRequiredError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
} from "./connections-service.js";
import type { DeploymentArtifact } from "./deployment-artifacts-service.js";
import type { ExecutionEnvironmentsService } from "./execution-environments-service.js";
import { toJson } from "./run-coordinator.js";
import { workflowEnablementConsentDigest } from "./workflow-enablement-consent.js";
import type {
  RevalidatedWorkflowEnablement,
  WorkflowEnablement,
  WorkflowEnablementConnection,
  WorkflowEnablementOwner,
  WorkflowEnablementPreview,
  WorkflowEnablementStatus,
  WorkflowEnablementSuspensionReason,
  WorkflowEnablementTrigger,
} from "./workflow-enablement-types.js";

const tracer = getTracer("@catamorphic/core");

interface WorkflowTarget {
  artifact: DeploymentArtifact;
  requirements: WorkflowGraph["connections"];
}

interface WorkflowEnablementsDeps {
  executionEnvironments: ExecutionEnvironmentsService;
  connectionAdmission?: ConnectionAdmissionService;
  resolveTarget(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha?: string;
    remoteBranch?: string;
  }): Promise<WorkflowTarget>;
  ensureTriggerDefinitions(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    commitSha: string;
    remoteBranch: string;
    environment?: string;
  }): Promise<void>;
  assertWorkflowAccess(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
  }): Promise<void>;
  resolveMemberIdentity?(args: {
    tenantId: string;
    projectId: string;
    externalUserId: string;
  }): Promise<Identity | null>;
}

export class WorkflowEnablementNotFoundError extends Error {
  constructor() {
    super("Workflow enablement not found");
    this.name = "WorkflowEnablementNotFoundError";
  }
}

export class WorkflowEnablementConsentRequiredError extends Error {
  constructor(readonly expectedDigest: string) {
    super("Workflow enablement consent is required");
    this.name = "WorkflowEnablementConsentRequiredError";
  }
}

export class WorkflowEnablementConflictError extends Error {
  constructor() {
    super("This workflow is already enabled for that owner and Environment");
    this.name = "WorkflowEnablementConflictError";
  }
}

export class WorkflowEnablementSuspendedError extends Error {
  constructor(
    readonly enablementId: string,
    readonly reason: string,
  ) {
    super(`Workflow enablement is unavailable: ${reason}`);
    this.name = "WorkflowEnablementSuspendedError";
  }
}

export class WorkflowEnablementsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: WorkflowEnablementsDeps,
  ) {}

  async preview(input: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    environment?: string;
    owner?: WorkflowEnablementOwner;
    connectionSelections?: Readonly<Record<string, string>>;
    commitSha?: string;
    remoteBranch?: string;
  }): Promise<WorkflowEnablementPreview> {
    const owner = input.owner ?? {
      type: "member" as const,
      externalUserId: input.identity.externalUserId,
    };
    if (
      owner.type === "member" &&
      owner.externalUserId !== input.identity.externalUserId
    ) {
      throw new AccessDeniedError();
    }
    this.assertMayManage(input.identity, owner);
    await this.deps.assertWorkflowAccess({
      identity: input.identity,
      projectId: input.projectId,
      workflowName: input.workflowName,
    });
    const target = await this.deps.resolveTarget(input);
    const admission = await this.deps.executionEnvironments.admit({
      identity: input.identity,
      projectId: input.projectId,
      environment: input.environment,
      requirements: { workload: "workflow" },
    });
    if (target.requirements.length > 0 && !this.deps.connectionAdmission) {
      throw new Error("Connection providers are not configured");
    }
    const resolved = target.requirements.length
      ? await this.deps.connectionAdmission!.admit({
          identity: input.identity,
          projectId: input.projectId,
          environment: admission.environmentName,
          requirements: target.requirements,
          unattended: owner.type === "service",
        })
      : [];
    for (const connection of resolved) {
      const selected = input.connectionSelections?.[connection.alias];
      if (selected && selected !== connection.connectionId) {
        throw new ConnectionUnavailableError(
          connection.alias,
          "The selected connection is not attached to this Environment alias",
          selected,
        );
      }
    }
    if (
      owner.type === "service" &&
      !resolved.some(
        (connection) =>
          connection.connectionId === owner.connectionId &&
          connection.principalKind === owner.principalKind,
      )
    ) {
      throw new ConnectionPermissionDeniedError();
    }
    const connections = resolved.map(mapResolvedConnection);
    const capabilities = [
      ...new Set(connections.flatMap((connection) => connection.capabilities)),
    ].sort();
    const preview = {
      projectId: input.projectId,
      workflowName: input.workflowName,
      deploymentArtifactId: target.artifact.id,
      deploymentArtifactDigest: target.artifact.artifactDigest,
      commitSha: target.artifact.commitSha,
      remoteBranch: input.remoteBranch ?? "main",
      environment: admission.environmentName,
      owner,
      connections,
      capabilities,
      consentDigest: "",
      triggerCount: 0,
    };
    await this.deps.ensureTriggerDefinitions({
      identity: input.identity,
      projectId: input.projectId,
      workflowName: input.workflowName,
      commitSha: preview.commitSha,
      remoteBranch: preview.remoteBranch,
      environment: preview.environment,
    });
    const count = await this.db
      .selectFrom("trigger_definitions")
      .select(({ fn }) => fn.countAll<string>().as("count"))
      .where("project_id", "=", input.projectId)
      .where("commit_sha", "=", preview.commitSha)
      .where("workflow_name", "=", input.workflowName)
      .executeTakeFirstOrThrow();
    const consentDigest = workflowEnablementConsentDigest(preview);
    return { ...preview, consentDigest, triggerCount: Number(count.count) };
  }

  async create(
    input: Parameters<WorkflowEnablementsService["preview"]>[0] & {
      consentDigest: string;
      temporary?: boolean;
      expiresAt?: Date;
    },
  ): Promise<WorkflowEnablement> {
    return withSpan(
      {
        tracer,
        name: "workflow_enablement.create",
        attributes: {
          "catamorphic.tenant.id": input.identity.tenantId,
          "catamorphic.project.id": input.projectId,
          "catamorphic.workflow.name": input.workflowName,
        },
      },
      async () => {
        const preview = await this.preview(input);
        if (input.consentDigest !== preview.consentDigest) {
          throw new WorkflowEnablementConsentRequiredError(
            preview.consentDigest,
          );
        }
        let created: Selectable<DB["workflow_enablements"]>;
        try {
          created = await this.db.transaction().execute(async (trx) => {
            const row = await trx
              .insertInto("workflow_enablements")
              .values({
                tenant_id: input.identity.tenantId,
                project_id: input.projectId,
                workflow_name: input.workflowName,
                deployment_artifact_id: preview.deploymentArtifactId,
                commit_sha: preview.commitSha,
                remote_branch: preview.remoteBranch,
                environment_name: preview.environment,
                owner_kind: preview.owner.type,
                owner_external_user_id:
                  preview.owner.type === "member"
                    ? preview.owner.externalUserId
                    : null,
                owner_connection_id:
                  preview.owner.type === "service"
                    ? preview.owner.connectionId
                    : null,
                owner_principal_kind:
                  preview.owner.type === "service"
                    ? preview.owner.principalKind
                    : null,
                owner_identity: toJson(input.identity),
                capabilities: toJson(preview.capabilities),
                consent_digest: preview.consentDigest,
                temporary: input.temporary ?? false,
                expires_at: input.expiresAt ?? null,
                created_by_external_user_id: input.identity.externalUserId,
              })
              .returningAll()
              .executeTakeFirstOrThrow();
            if (preview.connections.length > 0) {
              await trx
                .insertInto("workflow_enablement_connections")
                .values(
                  preview.connections.map((connection) => ({
                    enablement_id: row.id,
                    alias: connection.alias,
                    binding_id: connection.bindingId,
                    connection_id: connection.connectionId,
                    provider_kind: connection.providerKind,
                    principal_kind: connection.principalKind,
                    capabilities: toJson(connection.capabilities),
                  })),
                )
                .execute();
            }
            await trx
              .insertInto("workflow_enablement_triggers")
              .columns(["enablement_id", "trigger_definition_id"])
              .expression((eb) =>
                eb
                  .selectFrom("trigger_definitions")
                  .select([
                    eb.val(row.id).as("enablement_id"),
                    "trigger_definitions.id as trigger_definition_id",
                  ])
                  .where("project_id", "=", input.projectId)
                  .where("commit_sha", "=", preview.commitSha)
                  .where("workflow_name", "=", input.workflowName),
              )
              .execute();
            await this.recordEvent(
              trx,
              row.id,
              input.identity,
              "created",
              null,
            );
            return row;
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new WorkflowEnablementConflictError();
          }
          throw error;
        }
        return this.hydrate(created);
      },
    );
  }

  async list(input: {
    identity: Identity;
    projectId: string;
    workflowName?: string;
    includeAll?: boolean;
  }): Promise<WorkflowEnablement[]> {
    let query = this.db
      .selectFrom("workflow_enablements")
      .where("tenant_id", "=", input.identity.tenantId)
      .where("project_id", "=", input.projectId);
    if (input.workflowName) {
      query = query.where("workflow_name", "=", input.workflowName);
    }
    if (
      !input.includeAll ||
      !hasControlPlanePermission(input.identity, "connections:manage_service")
    ) {
      query = query.where((eb) =>
        eb.or([
          eb("owner_external_user_id", "=", input.identity.externalUserId),
          eb("created_by_external_user_id", "=", input.identity.externalUserId),
        ]),
      );
    }
    return Promise.all(
      (await query.selectAll().orderBy("created_at", "desc").execute()).map(
        (row) => this.hydrate(row),
      ),
    );
  }

  async get(input: {
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    const row = await this.requireRow(
      input.enablementId,
      input.identity.tenantId,
    );
    this.assertMayManage(input.identity, ownerFromRow(row));
    return this.hydrate(row);
  }

  async disable(input: {
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    return this.setStatus(input, "disabled", null, "disabled");
  }

  async reenable(input: {
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    const row = await this.requireRow(
      input.enablementId,
      input.identity.tenantId,
    );
    this.assertMayManage(input.identity, ownerFromRow(row));
    await this.revalidate({
      identity: input.identity,
      enablementId: input.enablementId,
      allowSuspended: true,
    });
    return this.setStatus(input, "active", null, "reenabled");
  }

  async updateDeployment(input: {
    identity: Identity;
    enablementId: string;
    consentDigest: string;
  }): Promise<WorkflowEnablement> {
    const current = await this.get(input);
    const preview = await this.preview({
      identity: input.identity,
      projectId: current.projectId,
      workflowName: current.workflowName,
      environment: current.environment,
      owner: current.owner,
      connectionSelections: Object.fromEntries(
        current.connections.map((connection) => [
          connection.alias,
          connection.connectionId,
        ]),
      ),
    });
    if (preview.consentDigest !== input.consentDigest) {
      throw new WorkflowEnablementConsentRequiredError(preview.consentDigest);
    }
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("workflow_enablements")
        .set((eb) => ({
          deployment_artifact_id: preview.deploymentArtifactId,
          commit_sha: preview.commitSha,
          remote_branch: preview.remoteBranch,
          consent_digest: preview.consentDigest,
          capabilities: toJson(preview.capabilities),
          update_available: false,
          status: "active",
          suspension_reason: null,
          revision: eb("revision", "+", 1),
          updated_at: new Date(),
        }))
        .where("id", "=", input.enablementId)
        .execute();
      await trx
        .deleteFrom("workflow_enablement_triggers")
        .where("enablement_id", "=", input.enablementId)
        .execute();
      await trx
        .deleteFrom("workflow_enablement_connections")
        .where("enablement_id", "=", input.enablementId)
        .execute();
      if (preview.connections.length > 0) {
        await trx
          .insertInto("workflow_enablement_connections")
          .values(
            preview.connections.map((connection) => ({
              enablement_id: input.enablementId,
              alias: connection.alias,
              binding_id: connection.bindingId,
              connection_id: connection.connectionId,
              provider_kind: connection.providerKind,
              principal_kind: connection.principalKind,
              capabilities: toJson(connection.capabilities),
            })),
          )
          .execute();
      }
      await trx
        .insertInto("workflow_enablement_triggers")
        .columns(["enablement_id", "trigger_definition_id"])
        .expression((eb) =>
          eb
            .selectFrom("trigger_definitions")
            .select([
              eb.val(input.enablementId).as("enablement_id"),
              "trigger_definitions.id as trigger_definition_id",
            ])
            .where("project_id", "=", current.projectId)
            .where("commit_sha", "=", preview.commitSha)
            .where("workflow_name", "=", current.workflowName),
        )
        .execute();
      await this.recordEvent(
        trx,
        input.enablementId,
        input.identity,
        "deployment_updated",
        null,
      );
    });
    return this.get(input);
  }

  async markUpdateAvailable(input: {
    projectId: string;
    commitSha: string;
  }): Promise<void> {
    await this.db
      .updateTable("workflow_enablements")
      .set({ update_available: true, updated_at: new Date() })
      .where("project_id", "=", input.projectId)
      .where("commit_sha", "!=", input.commitSha)
      .where("temporary", "=", false)
      .where("update_available", "=", false)
      .execute();
  }

  async revalidate(input: {
    identity: Identity;
    enablementId: string;
    allowSuspended?: boolean;
  }): Promise<RevalidatedWorkflowEnablement> {
    const row = await this.requireRow(
      input.enablementId,
      input.identity.tenantId,
    );
    if (row.status === "disabled") {
      throw new WorkflowEnablementSuspendedError(row.id, "disabled");
    }
    if (row.status === "suspended" && !input.allowSuspended) {
      throw new WorkflowEnablementSuspendedError(
        row.id,
        row.suspension_reason ?? "suspended",
      );
    }
    if (row.expires_at && row.expires_at <= new Date()) {
      return this.failRevalidation(row, input.identity, "expired");
    }
    const storedIdentity = row.owner_identity as unknown as Identity;
    const ownerIdentity =
      row.owner_kind === "member" &&
      storedIdentity.scope !== undefined &&
      this.deps.resolveMemberIdentity
        ? await this.deps.resolveMemberIdentity({
            tenantId: row.tenant_id,
            projectId: row.project_id,
            externalUserId: row.owner_external_user_id!,
          })
        : storedIdentity;
    if (!ownerIdentity) {
      return this.failRevalidation(row, input.identity, "member_removed");
    }
    try {
      await this.deps.assertWorkflowAccess({
        identity: ownerIdentity,
        projectId: row.project_id,
        workflowName: row.workflow_name,
      });
    } catch {
      return this.failRevalidation(row, input.identity, "workflow_denied");
    }
    try {
      await this.deps.executionEnvironments.admit({
        identity: ownerIdentity,
        projectId: row.project_id,
        environment: row.environment_name,
        requirements: { workload: "workflow" },
      });
    } catch {
      return this.failRevalidation(row, input.identity, "environment_denied");
    }
    const connections = await this.connectionRows(row.id);
    if (connections.length > 0 && !this.deps.connectionAdmission) {
      return this.failRevalidation(
        row,
        input.identity,
        "connection_unavailable",
      );
    }
    try {
      const live = await this.deps.connectionAdmission?.admitSnapshot({
        identity: ownerIdentity,
        projectId: row.project_id,
        environment: row.environment_name,
        snapshot: connections,
      });
      if (
        live?.some((connection) => {
          const frozen = connections.find(
            (candidate) => candidate.alias === connection.alias,
          );
          return frozen?.capabilities.some(
            (capability) => !connection.capabilities.includes(capability),
          );
        })
      ) {
        return this.failRevalidation(
          row,
          input.identity,
          "connection_capability_changed",
        );
      }
    } catch (error) {
      const reason: WorkflowEnablementSuspensionReason =
        error instanceof ConnectionPermissionDeniedError
          ? "connection_permission_denied"
          : "connection_unavailable";
      return this.failRevalidation(row, input.identity, reason);
    }
    return {
      enablement: await this.hydrate(row),
      ownerIdentity,
    };
  }

  async reenableEligibleForMember(input: {
    identity: Identity;
  }): Promise<number> {
    const rows = await this.db
      .selectFrom("workflow_enablements")
      .select("id")
      .where("tenant_id", "=", input.identity.tenantId)
      .where("owner_kind", "=", "member")
      .where("owner_external_user_id", "=", input.identity.externalUserId)
      .where("status", "=", "suspended")
      .execute();
    let reenabled = 0;
    for (const row of rows) {
      try {
        await this.reenable({ identity: input.identity, enablementId: row.id });
        reenabled += 1;
      } catch (error) {
        if (
          !(
            error instanceof AuthenticationRequiredError ||
            error instanceof WorkflowEnablementSuspendedError
          )
        ) {
          throw error;
        }
      }
    }
    return reenabled;
  }

  async suspendForConnection(input: {
    identity: Identity;
    connectionId: string;
  }): Promise<number> {
    const rows = await this.db
      .selectFrom("workflow_enablements as enablement")
      .innerJoin(
        "workflow_enablement_connections as selected",
        "selected.enablement_id",
        "enablement.id",
      )
      .select("enablement.id")
      .where("enablement.tenant_id", "=", input.identity.tenantId)
      .where("selected.connection_id", "=", input.connectionId)
      .where("enablement.status", "=", "active")
      .execute();
    for (const row of rows) {
      await this.db.transaction().execute(async (trx) => {
        await trx
          .updateTable("workflow_enablements")
          .set({
            status: "suspended",
            suspension_reason: "connection_unavailable",
            updated_at: new Date(),
          })
          .where("id", "=", row.id)
          .where("status", "=", "active")
          .execute();
        await this.recordEvent(
          trx,
          row.id,
          input.identity,
          "suspended",
          "connection_unavailable",
        );
      });
    }
    return rows.length;
  }

  private async failRevalidation(
    row: Selectable<DB["workflow_enablements"]>,
    actor: Identity,
    reason: WorkflowEnablementSuspensionReason,
  ): Promise<never> {
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("workflow_enablements")
        .set({
          status: "suspended",
          suspension_reason: reason,
          updated_at: new Date(),
        })
        .where("id", "=", row.id)
        .where("status", "!=", "disabled")
        .execute();
      await this.recordEvent(trx, row.id, actor, "suspended", reason);
    });
    throw new WorkflowEnablementSuspendedError(row.id, reason);
  }

  private async setStatus(
    input: { identity: Identity; enablementId: string },
    status: WorkflowEnablementStatus,
    reason: string | null,
    eventType: string,
  ): Promise<WorkflowEnablement> {
    const row = await this.requireRow(
      input.enablementId,
      input.identity.tenantId,
    );
    this.assertMayManage(input.identity, ownerFromRow(row));
    await this.db.transaction().execute(async (trx) => {
      await trx
        .updateTable("workflow_enablements")
        .set((eb) => ({
          status,
          suspension_reason: reason,
          revision: eb("revision", "+", 1),
          updated_at: new Date(),
        }))
        .where("id", "=", input.enablementId)
        .execute();
      await this.recordEvent(
        trx,
        input.enablementId,
        input.identity,
        eventType,
        reason,
      );
    });
    return this.get(input);
  }

  private assertMayManage(
    identity: Identity,
    owner: WorkflowEnablementOwner,
  ): void {
    if (
      owner.type === "member" &&
      owner.externalUserId === identity.externalUserId
    ) {
      return;
    }
    if (hasControlPlanePermission(identity, "connections:manage_service")) {
      return;
    }
    throw new AccessDeniedError();
  }

  private async requireRow(enablementId: string, tenantId: string) {
    const row = await this.db
      .selectFrom("workflow_enablements")
      .selectAll()
      .where("id", "=", enablementId)
      .where("tenant_id", "=", tenantId)
      .executeTakeFirst();
    if (!row) throw new WorkflowEnablementNotFoundError();
    return row;
  }

  private async connectionRows(
    enablementId: string,
  ): Promise<ResolvedConnectionBinding[]> {
    return (
      await this.db
        .selectFrom("workflow_enablement_connections")
        .selectAll()
        .where("enablement_id", "=", enablementId)
        .orderBy("alias")
        .execute()
    ).map((row) => ({
      bindingId: row.binding_id,
      connectionId: row.connection_id,
      alias: row.alias,
      providerKind: row.provider_kind,
      principalKind:
        row.principal_kind as ResolvedConnectionBinding["principalKind"],
      capabilities: stringArray(row.capabilities),
    }));
  }

  private async hydrate(
    row: Selectable<DB["workflow_enablements"]>,
  ): Promise<WorkflowEnablement> {
    const [connections, triggers] = await Promise.all([
      this.connectionRows(row.id),
      this.db
        .selectFrom("workflow_enablement_triggers as activation")
        .innerJoin(
          "trigger_definitions as definition",
          "definition.id",
          "activation.trigger_definition_id",
        )
        .select([
          "activation.id",
          "activation.trigger_definition_id",
          "activation.status",
          "definition.trigger_kind",
          "definition.config",
        ])
        .where("activation.enablement_id", "=", row.id)
        .orderBy("definition.trigger_kind")
        .execute(),
    ]);
    return {
      id: row.id,
      projectId: row.project_id,
      workflowName: row.workflow_name,
      deploymentArtifactId: row.deployment_artifact_id,
      commitSha: row.commit_sha,
      remoteBranch: row.remote_branch,
      environment: row.environment_name,
      owner: ownerFromRow(row),
      connections: connections.map(mapResolvedConnection),
      capabilities: stringArray(row.capabilities),
      consentDigest: row.consent_digest,
      status: row.status as WorkflowEnablementStatus,
      suspensionReason: row.suspension_reason,
      updateAvailable: row.update_available,
      temporary: row.temporary,
      expiresAt: row.expires_at?.toISOString() ?? null,
      revision: row.revision,
      triggers: triggers.map(
        (trigger): WorkflowEnablementTrigger => ({
          id: trigger.id,
          definitionId: trigger.trigger_definition_id,
          kind: trigger.trigger_kind,
          config: trigger.config,
          status: trigger.status as "active" | "paused",
        }),
      ),
      createdAt: row.created_at.toISOString(),
      updatedAt: row.updated_at.toISOString(),
    };
  }

  private recordEvent(
    trx: Kysely<DB>,
    enablementId: string,
    identity: Identity,
    eventType: string,
    reason: string | null,
  ): Promise<unknown> {
    return trx
      .insertInto("workflow_enablement_events")
      .values({
        enablement_id: enablementId,
        actor_external_user_id: identity.externalUserId,
        event_type: eventType,
        reason,
        metadata: {} as Json,
      })
      .execute();
  }
}

function ownerFromRow(
  row: Selectable<DB["workflow_enablements"]>,
): WorkflowEnablementOwner {
  return row.owner_kind === "member"
    ? { type: "member", externalUserId: row.owner_external_user_id! }
    : {
        type: "service",
        principalKind: row.owner_principal_kind as
          | "project_service"
          | "tenant_service",
        connectionId: row.owner_connection_id!,
      };
}

function mapResolvedConnection(
  connection: ResolvedConnectionBinding,
): WorkflowEnablementConnection {
  return { ...connection, capabilities: [...connection.capabilities] };
}

function stringArray(value: Json): string[] {
  return Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string")
    : [];
}

function isUniqueViolation(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    (error as { code?: unknown }).code === "23505"
  );
}
