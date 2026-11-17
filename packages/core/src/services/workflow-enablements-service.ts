import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type WorkflowGraph,
  WorkflowSourceInvalidError,
} from "@catamorphic/parser";
import type { Kysely, Selectable, Transaction } from "kysely";
import type { Identity } from "../identity.js";
import {
  hasProjectPermission,
  identityCovers,
  mayUseProject,
  projectPrincipalIdentity,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ConnectionAdmissionService } from "./connection-admission.js";
import type { ResolvedConnectionBinding } from "./connection-types.js";
import {
  AuthenticationRequiredError,
  ConnectionNotFoundError,
  ConnectionPermissionDeniedError,
  ConnectionUnavailableError,
} from "./connections-service.js";
import type { DeploymentArtifact } from "./deployment-artifacts-service.js";
import {
  EnvironmentAccessDeniedError,
  EnvironmentBindingUnavailableError,
  EnvironmentIncompatibleError,
  EnvironmentNotFoundError,
  EnvironmentPolicyInvalidError,
  type ExecutionEnvironmentsService,
  NoCompatibleEnvironmentError,
} from "./execution-environments-service.js";
import { toJson } from "./run-coordinator.js";
import {
  TriggerBindingsInvalidError,
  TriggerKindNotRegisteredError,
  TriggerModeNotAllowedError,
} from "./triggers-service.js";
import { EnvironmentCapacityError } from "./worker-capacity.js";
import {
  workflowEnablementAuthorityDigest,
  workflowEnablementConsentDigest,
} from "./workflow-enablement-consent.js";
import type {
  RevalidatedWorkflowEnablement,
  WorkflowEnablement,
  WorkflowEnablementConnection,
  WorkflowEnablementFollowOutcome,
  WorkflowEnablementOwner,
  WorkflowEnablementPreview,
  WorkflowEnablementStatus,
  WorkflowEnablementSuspensionReason,
  WorkflowEnablementTrigger,
} from "./workflow-enablement-types.js";
import { WorkflowNotFoundError } from "./workflows-service.js";

const tracer = getTracer("@catamorphic/core");

interface WorkflowTarget {
  remoteBranch?: string;
  artifact: DeploymentArtifact;
  requirements: WorkflowGraph["connections"];
  permissions: WorkflowGraph["permissions"];
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
  /**
   * Someone consented to an enablement again: created it, updated its
   * deployment, or turned it back on (ADR 0331 retries a failed deploy).
   */
  onConsented?(args: {
    projectId: string;
    workflowName: string;
    ownerKind: "member" | "project";
  }): Promise<void>;
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

/** Only a lasting enablement of `main` can follow it (ADR 0330). */
export class WorkflowEnablementFollowUnavailableError extends Error {
  constructor() {
    super(
      "Only an enablement of the published main branch that is not temporary can follow it",
    );
    this.name = "WorkflowEnablementFollowUnavailableError";
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
    this.assertMayManage(input.identity, input.projectId, owner);
    await this.deps.assertWorkflowAccess({
      identity: input.identity,
      projectId: input.projectId,
      workflowName: input.workflowName,
    });
    const target = await this.deps.resolveTarget(input);
    // Only someone who holds a permission can hand it to a workflow: a
    // member's runs keep it only while they do; a project automation's
    // runs keep what was consented to (ADR 0158).
    const missing = target.permissions.filter(
      (permission) =>
        !hasProjectPermission(input.identity, input.projectId, permission),
    );
    if (missing.length > 0) {
      throw new AccessDeniedError(
        `This workflow needs permissions you do not have: ${missing.join(", ")}`,
      );
    }
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
          unattended: owner.type === "project",
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
      remoteBranch: target.remoteBranch ?? input.remoteBranch ?? "main",
      environment: admission.environmentName,
      owner,
      connections,
      capabilities,
      permissions: [...target.permissions],
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
    const triggers = (
      await this.db
        .selectFrom("trigger_definitions")
        .select(["trigger_kind as kind", "config", "project_kind"])
        .where("project_id", "=", input.projectId)
        .where("commit_sha", "=", preview.commitSha)
        .where("workflow_name", "=", input.workflowName)
        .orderBy("binding_index")
        .execute()
    ).map(({ project_kind, ...trigger }) => ({
      ...trigger,
      ...(project_kind ? { projectKind: project_kind } : {}),
    }));
    const labels = connections.length
      ? await this.db
          .selectFrom("connections")
          .select(["id", "label"])
          .where("tenant_id", "=", input.identity.tenantId)
          .where(
            "id",
            "in",
            connections.map((connection) => connection.connectionId),
          )
          .execute()
      : [];
    const consentDigest = workflowEnablementConsentDigest(preview);
    return {
      ...preview,
      consentDigest,
      triggerCount: triggers.length,
      triggers,
      connectionLabels: Object.fromEntries(
        labels.map((connection) => [connection.id, connection.label]),
      ),
    };
  }

  async create(
    input: Parameters<WorkflowEnablementsService["preview"]>[0] & {
      consentDigest: string;
      temporary?: boolean;
      expiresAt?: Date;
      /**
       * Move to each newly published revision (ADR 0330). Defaults to true
       * for a project automation of `main`, false for a member's own (it
       * uses their connections; they turn it on). A temporary one never
       * follows.
       */
      follow?: boolean;
      /** Attach ownership in the same transaction before triggers become visible. */
      onCreate?: (input: {
        transaction: Transaction<DB>;
        enablement: Selectable<DB["workflow_enablements"]>;
      }) => Promise<void>;
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
        const follows = followDefault({
          follow: input.follow,
          temporary: input.temporary ?? false,
          remoteBranch: preview.remoteBranch,
          owner: preview.owner,
        });
        let created: Selectable<DB["workflow_enablements"]>;
        try {
          created = await this.db.transaction().execute(async (trx) => {
            await this.lockRetainedSource({
              transaction: trx,
              identity: input.identity,
              projectId: input.projectId,
              commitSha: preview.commitSha,
              owner: preview.owner,
            });
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
                owner_identity: toJson(input.identity),
                capabilities: toJson(preview.capabilities),
                permissions: toJson(preview.permissions),
                consent_digest: preview.consentDigest,
                temporary: input.temporary ?? false,
                follow: follows,
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
            await input.onCreate?.({ transaction: trx, enablement: row });
            return row;
          });
        } catch (error) {
          if (isUniqueViolation(error)) {
            throw new WorkflowEnablementConflictError();
          }
          throw error;
        }
        await this.consented(created);
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
      !hasProjectPermission(input.identity, input.projectId, "automations:read")
    ) {
      // Everyone in the project sees its project automations; of members'
      // automations, only their own.
      const seesProject = mayUseProject(input.identity, input.projectId);
      query = query.where((eb) =>
        eb.or([
          ...(seesProject ? [eb("owner_kind", "=", "project")] : []),
          eb("owner_external_user_id", "=", input.identity.externalUserId),
        ]),
      );
    }
    const items = await Promise.all(
      (await query.select("id").orderBy("created_at", "desc").execute()).map(
        async (row) => {
          try {
            return await this.get({
              identity: input.identity,
              enablementId: row.id,
            });
          } catch (error) {
            if (error instanceof AccessDeniedError) return null;
            throw error;
          }
        },
      ),
    );
    return items.filter((item) => item !== null);
  }

  async get(input: {
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    return this.db.transaction().execute(async (transaction) => {
      const row = await this.requireRow({
        ...input,
        transaction,
        lock: "share",
      });
      await this.assertRetainedSourceOwner({ ...input, row, transaction });
      // Published automations retain ordinary administrative visibility.
      const readable =
        (row.owner_kind === "project" &&
          mayUseProject(input.identity, row.project_id)) ||
        row.owner_external_user_id === input.identity.externalUserId ||
        hasProjectPermission(
          input.identity,
          row.project_id,
          "automations:read",
        );
      if (!readable) throw new AccessDeniedError();
      return this.hydrate(row, transaction);
    });
  }

  async disable(input: {
    signal?: AbortSignal;
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    return this.setStatus(input, "disabled", null, "disabled");
  }

  async reenable(input: {
    identity: Identity;
    enablementId: string;
  }): Promise<WorkflowEnablement> {
    const current = await this.get(input);
    this.assertMayManage(input.identity, current.projectId, current.owner);
    await this.revalidate({
      identity: input.identity,
      enablementId: input.enablementId,
      allowSuspended: true,
    });
    const reenabled = await this.setStatus(input, "active", null, "reenabled");
    await this.consented({
      project_id: reenabled.projectId,
      workflow_name: reenabled.workflowName,
      owner_kind: reenabled.owner.type,
    });
    return reenabled;
  }

  async updateDeployment(input: {
    identity: Identity;
    enablementId: string;
    consentDigest: string;
    environment?: string;
    commitSha?: string;
    remoteBranch?: string;
    onUpdate?: (transaction: Transaction<DB>) => Promise<void>;
  }): Promise<WorkflowEnablement> {
    const current = await this.get(input);
    this.assertMayManage(input.identity, current.projectId, current.owner);
    const preview = await this.preview({
      identity: input.identity,
      projectId: current.projectId,
      workflowName: current.workflowName,
      environment: input.environment ?? current.environment,
      owner: current.owner,
      commitSha: input.commitSha,
      remoteBranch: input.remoteBranch ?? current.remoteBranch,
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
      await this.lockRetainedSource({
        transaction: trx,
        identity: input.identity,
        projectId: current.projectId,
        commitSha: preview.commitSha,
        owner: preview.owner,
      });
      // Source callbacks lock retained journals before the enablement. Their
      // transactional writes roll back if the current-row authorization fails.
      await input.onUpdate?.(trx);
      const row = await this.requireRow({
        ...input,
        transaction: trx,
        lock: "update",
      });
      await this.assertRetainedSourceOwner({ ...input, row, transaction: trx });
      this.assertMayManage(input.identity, row.project_id, ownerFromRow(row));
      await this.writeDeployment({
        transaction: trx,
        row,
        preview,
        actor: input.identity,
        eventType: "deployment_updated",
      });
    });
    await this.consented({
      project_id: current.projectId,
      workflow_name: current.workflowName,
      owner_kind: current.owner.type,
    });
    return this.get(input);
  }

  private async consented(row: {
    project_id: string;
    workflow_name: string;
    owner_kind: string;
  }): Promise<void> {
    await this.deps
      .onConsented?.({
        projectId: row.project_id,
        workflowName: row.workflow_name,
        ownerKind: row.owner_kind === "project" ? "project" : "member",
      })
      .catch((error: unknown) =>
        console.warn(
          "[catamorphic] Could not report a consented enablement",
          error,
        ),
      );
  }

  /** Turn following on or off (ADR 0330). Who may manage it may change it. */
  async setFollow(input: {
    identity: Identity;
    enablementId: string;
    follow: boolean;
  }): Promise<WorkflowEnablement> {
    await this.db.transaction().execute(async (trx) => {
      const row = await this.requireRow({
        ...input,
        transaction: trx,
        lock: "update",
      });
      await this.assertRetainedSourceOwner({ ...input, row, transaction: trx });
      this.assertMayManage(input.identity, row.project_id, ownerFromRow(row));
      if (
        input.follow &&
        (row.temporary || row.remote_branch !== PUBLISHED_BRANCH)
      )
        throw new WorkflowEnablementFollowUnavailableError();
      if (row.follow === input.follow) return;
      await trx
        .updateTable("workflow_enablements")
        .set((eb) => ({
          follow: input.follow,
          revision: eb("revision", "+", 1),
          updated_at: new Date(),
        }))
        .where("id", "=", row.id)
        .execute();
      await this.recordEvent(
        trx,
        row.id,
        input.identity,
        input.follow ? "follow_on" : "follow_off",
        null,
      );
    });
    return this.get(input);
  }

  /**
   * Following enablements of a project that a published revision could
   * move (ADR 0330): lasting, not turned off, on `main`, behind it.
   */
  async followers(input: {
    projectId: string;
    sequence: number;
  }): Promise<Array<{ id: string; workflowName: string }>> {
    return this.db
      .selectFrom("workflow_enablements")
      .select(["id", "workflow_name as workflowName"])
      .where("project_id", "=", input.projectId)
      .where("follow", "=", true)
      .where("temporary", "=", false)
      .where("status", "!=", "disabled")
      .where("remote_branch", "=", PUBLISHED_BRANCH)
      .where((eb) =>
        eb.or([
          eb("followed_sequence", "is", null),
          eb("followed_sequence", "<", String(input.sequence)),
        ]),
      )
      .orderBy("created_at")
      .execute();
  }

  /**
   * The enablement's preview at a published commit, as its owner, and
   * whether its authority is the one consented to (ADR 0330). Building and
   * parsing the workflow and registering its triggers happen here, exactly
   * as enabling does.
   */
  async previewAtRevision(input: {
    enablementId: string;
    commitSha: string;
  }): Promise<
    | {
        kind: "ready";
        preview: WorkflowEnablementPreview;
        actor: Identity;
        enablement: WorkflowEnablement;
      }
    | { kind: "needs_consent"; reason: string }
    | { kind: "skipped"; reason: string }
    | { kind: "retry"; reason: string }
  > {
    const row = await this.db
      .selectFrom("workflow_enablements")
      .selectAll()
      .where("id", "=", input.enablementId)
      .executeTakeFirst();
    if (!row) throw new WorkflowEnablementNotFoundError();
    const actor = await this.consentingIdentity(row);
    if (!actor)
      return {
        kind: "needs_consent",
        reason: "The member who turned it on is no longer in the project",
      };
    const current = await this.hydrate(row);
    let preview: WorkflowEnablementPreview;
    try {
      preview = await this.preview({
        identity: actor,
        projectId: row.project_id,
        workflowName: row.workflow_name,
        environment: row.environment_name,
        owner: current.owner,
        commitSha: input.commitSha,
        remoteBranch: row.remote_branch,
        connectionSelections: Object.fromEntries(
          current.connections.map((connection) => [
            connection.alias,
            connection.connectionId,
          ]),
        ),
      });
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      if (isAuthorityError(error)) return { kind: "needs_consent", reason };
      // Only a failure the same files always produce skips the revision;
      // a database, network or capacity error is tried again.
      if (isRevisionBuildError(error)) return { kind: "skipped", reason };
      return { kind: "retry", reason };
    }
    if (
      workflowEnablementAuthorityDigest(preview) !==
      workflowEnablementAuthorityDigest(current)
    )
      return {
        kind: "needs_consent",
        reason:
          "This revision changes what the workflow may use (connections, permissions or Environment)",
      };
    return { kind: "ready", preview, actor, enablement: current };
  }

  /**
   * Move a following enablement to the published revision `sequence`
   * (ADR 0330) when its workflow builds there and its authority is
   * unchanged. Otherwise it stays and is marked `update_available`. Never
   * moves an enablement to a revision older than one it already followed.
   */
  async followRevision(input: {
    enablementId: string;
    commitSha: string;
    sequence: number;
  }): Promise<WorkflowEnablementFollowOutcome> {
    const { enablementId } = input;
    const before = await this.db
      .selectFrom("workflow_enablements")
      .select(["revision", "follow", "followed_sequence", "status"])
      .where("id", "=", enablementId)
      .executeTakeFirst();
    if (
      !before?.follow ||
      before.status === "disabled" ||
      (before.followed_sequence !== null &&
        Number(before.followed_sequence) >= input.sequence)
    )
      return { kind: "unchanged", enablementId };
    const ready = await this.previewAtRevision(input);
    if (ready.kind === "retry")
      return { kind: "retry", enablementId, reason: ready.reason };
    if (ready.kind !== "ready") {
      await this.db.transaction().execute(async (trx) => {
        // Considered at this revision: the next one is what it follows.
        await trx
          .updateTable("workflow_enablements")
          .set({
            update_available: true,
            followed_sequence: String(input.sequence),
            updated_at: new Date(),
          })
          .where("id", "=", enablementId)
          .where("commit_sha", "!=", input.commitSha)
          .where((eb) =>
            eb.or([
              eb("followed_sequence", "is", null),
              eb("followed_sequence", "<", String(input.sequence)),
            ]),
          )
          .execute();
        await this.recordEvent(
          trx,
          enablementId,
          { tenantId: "", externalUserId: FOLLOW_ACTOR },
          ready.kind === "skipped" ? "follow_skipped" : "follow_blocked",
          ready.reason,
          { commitSha: input.commitSha },
        );
      });
      return { kind: ready.kind, enablementId, reason: ready.reason };
    }
    const moved = await this.db.transaction().execute(async (trx) => {
      const row = await trx
        .selectFrom("workflow_enablements")
        .selectAll()
        .where("id", "=", enablementId)
        .forUpdate()
        .executeTakeFirst();
      // A person changed it meanwhile, it stopped following, or another
      // pass already took it as far: leave it.
      if (
        !row?.follow ||
        row.status === "disabled" ||
        row.revision !== before.revision ||
        (row.followed_sequence !== null &&
          Number(row.followed_sequence) >= input.sequence)
      )
        return false;
      if (row.commit_sha === ready.preview.commitSha) {
        await trx
          .updateTable("workflow_enablements")
          .set({ followed_sequence: String(input.sequence) })
          .where("id", "=", enablementId)
          .execute();
        return false;
      }
      await this.writeDeployment({
        transaction: trx,
        row,
        preview: ready.preview,
        actor: { tenantId: row.tenant_id, externalUserId: FOLLOW_ACTOR },
        eventType: "followed",
        followedSequence: input.sequence,
        keepStatus: true,
      });
      return true;
    });
    return moved
      ? { kind: "moved", enablementId, commitSha: input.commitSha }
      : { kind: "unchanged", enablementId };
  }

  /**
   * Who consented to an enablement, as they are now: the member for their
   * own automation, the member who turned on a project automation. Null
   * once they left the project.
   */
  private async consentingIdentity(
    row: Selectable<DB["workflow_enablements"]>,
  ): Promise<Identity | null> {
    const stored = row.owner_identity as unknown as Identity;
    if (stored.scope === undefined || !this.deps.resolveMemberIdentity)
      return stored;
    return this.deps.resolveMemberIdentity({
      tenantId: row.tenant_id,
      projectId: row.project_id,
      externalUserId: stored.externalUserId,
    });
  }

  /** Point an enablement at a previewed deployment, triggers and all. */
  private async writeDeployment(input: {
    transaction: Transaction<DB>;
    row: Selectable<DB["workflow_enablements"]>;
    preview: WorkflowEnablementPreview;
    actor: Identity;
    eventType: string;
    followedSequence?: number;
    /** Following keeps a suspension; a person's update reactivates. */
    keepStatus?: boolean;
  }): Promise<void> {
    const { transaction: trx, row, preview } = input;
    await trx
      .updateTable("workflow_enablements")
      .set((eb) => ({
        deployment_artifact_id: preview.deploymentArtifactId,
        environment_name: preview.environment,
        commit_sha: preview.commitSha,
        remote_branch: preview.remoteBranch,
        consent_digest: preview.consentDigest,
        capabilities: toJson(preview.capabilities),
        permissions: toJson(preview.permissions),
        update_available: false,
        ...(input.keepStatus
          ? {}
          : { status: "active", suspension_reason: null }),
        ...(input.followedSequence !== undefined
          ? { followed_sequence: String(input.followedSequence) }
          : {}),
        revision: eb("revision", "+", 1),
        updated_at: new Date(),
      }))
      .where("id", "=", row.id)
      .execute();
    await trx
      .deleteFrom("workflow_enablement_triggers")
      .where("enablement_id", "=", row.id)
      .execute();
    await trx
      .deleteFrom("workflow_enablement_connections")
      .where("enablement_id", "=", row.id)
      .execute();
    if (preview.connections.length > 0) {
      await trx
        .insertInto("workflow_enablement_connections")
        .values(
          preview.connections.map((connection) => ({
            enablement_id: row.id,
            alias: connection.alias,
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
          .where("project_id", "=", row.project_id)
          .where("commit_sha", "=", preview.commitSha)
          .where("workflow_name", "=", row.workflow_name),
      )
      .execute();
    await this.recordEvent(
      trx,
      row.id,
      input.actor,
      input.eventType,
      null,
      input.eventType === "followed" ? { commitSha: preview.commitSha } : {},
    );
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
    const row = await this.requireRow(input);
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
    const connections = await this.connectionRows(row.id);
    const permissions = stringArray(row.permissions);
    // A project automation never runs as the person who enabled it: it
    // runs as the project principal, allowed exactly what was consented to.
    const ownerIdentity =
      row.owner_kind === "project"
        ? projectPrincipalIdentity({
            tenantId: row.tenant_id,
            projectId: row.project_id,
            environment: row.environment_name,
            workflowName: row.workflow_name,
            connections,
            permissions,
          })
        : storedIdentity.scope !== undefined && this.deps.resolveMemberIdentity
          ? await this.deps.resolveMemberIdentity({
              tenantId: row.tenant_id,
              projectId: row.project_id,
              externalUserId: row.owner_external_user_id!,
            })
          : storedIdentity;
    if (!ownerIdentity) {
      return this.failRevalidation(row, input.identity, "member_removed");
    }
    // A member's automation runs with their declared permissions only while
    // the member still holds every one.
    if (
      permissions.some(
        (permission) =>
          !hasProjectPermission(ownerIdentity, row.project_id, permission),
      )
    ) {
      return this.failRevalidation(row, input.identity, "permission_revoked");
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
    } catch (error) {
      // A full or offline machine says nothing about authority: the run's
      // own admission waits or fails retryably (ADR 0325).
      if (
        !(
          error instanceof EnvironmentCapacityError ||
          error instanceof EnvironmentBindingUnavailableError
        )
      )
        // A broken project policy stops every automation; it is not the
        // owner losing access.
        return this.failRevalidation(
          row,
          input.identity,
          error instanceof EnvironmentPolicyInvalidError
            ? "environment_policy_invalid"
            : "environment_denied",
        );
    }
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
    input: { identity: Identity; enablementId: string; signal?: AbortSignal },
    status: WorkflowEnablementStatus,
    reason: string | null,
    eventType: string,
  ): Promise<WorkflowEnablement> {
    input.signal?.throwIfAborted();
    await this.db.transaction().execute(async (trx) => {
      const row = await this.requireRow({
        ...input,
        transaction: trx,
        lock: "update",
      });
      await this.assertRetainedSourceOwner({ ...input, row, transaction: trx });
      this.assertMayManage(input.identity, row.project_id, ownerFromRow(row));
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
      input.signal?.throwIfAborted();
    });
    return this.get(input);
  }

  /**
   * Whether this identity may turn project automations on, pause and update
   * them, and pause anyone's (`automations:write`, ADR 0158).
   */
  mayManageProjectAutomations(input: {
    identity: Identity;
    projectId: string;
  }): boolean {
    return hasProjectPermission(
      input.identity,
      input.projectId,
      "automations:write",
    );
  }

  /** A member manages their own; everything else takes `automations:write`. */
  private assertMayManage(
    identity: Identity,
    projectId: string,
    owner: WorkflowEnablementOwner,
  ): void {
    if (
      owner.type === "member" &&
      owner.externalUserId === identity.externalUserId
    ) {
      return;
    }
    if (this.mayManageProjectAutomations({ identity, projectId })) return;
    throw new AccessDeniedError();
  }

  private async lockRetainedSource(input: {
    transaction: Transaction<DB>;
    identity: Identity;
    projectId: string;
    commitSha: string;
    owner: WorkflowEnablementOwner;
  }): Promise<void> {
    const source = await input.transaction
      .selectFrom("session_artifacts")
      .where("project_id", "=", input.projectId)
      .where(
        "id",
        "in",
        input.transaction
          .selectFrom("session_artifact_revisions")
          .select("artifact_id")
          .where("commit_sha", "=", input.commitSha),
      )
      .select(["id", "status", "owner_external_user_id"])
      .forUpdate()
      .executeTakeFirst();
    if (
      source &&
      (source.status !== "active" ||
        source.owner_external_user_id !== input.identity.externalUserId ||
        input.owner.type !== "member" ||
        input.owner.externalUserId !== source.owner_external_user_id)
    )
      throw new AccessDeniedError();
  }

  /** Retained source metadata has the same private audience as its immutable pin. */
  private async assertRetainedSourceOwner(input: {
    identity: Identity;
    row: Selectable<DB["workflow_enablements"]>;
    transaction: Kysely<DB>;
  }): Promise<void> {
    const source = await input.transaction
      .selectFrom("session_artifact_revisions as revision")
      .innerJoin(
        "session_artifacts as source",
        "source.id",
        "revision.artifact_id",
      )
      .where("source.project_id", "=", input.row.project_id)
      .where("revision.commit_sha", "=", input.row.commit_sha)
      .select([
        "source.owner_external_user_id",
        "source.name",
        "source.lifetime",
      ])
      .executeTakeFirst();
    if (
      source &&
      (source.owner_external_user_id !== input.identity.externalUserId ||
        (source.lifetime === "member" &&
          !identityCovers(input.identity, {
            kind: "workflow",
            projectId: input.row.project_id,
            name: source.name,
          })))
    )
      throw new AccessDeniedError();
  }

  private async requireRow(input: {
    identity: Identity;
    enablementId: string;
    transaction?: Kysely<DB>;
    lock?: "share" | "update";
  }) {
    let query = (input.transaction ?? this.db)
      .selectFrom("workflow_enablements")
      .selectAll()
      .where("id", "=", input.enablementId)
      .where("tenant_id", "=", input.identity.tenantId);
    if (input.lock === "share") query = query.forShare();
    if (input.lock === "update") query = query.forUpdate();
    const row = await query.executeTakeFirst();
    if (!row) throw new WorkflowEnablementNotFoundError();
    return row;
  }

  private async connectionRows(
    enablementId: string,
    database: Kysely<DB> = this.db,
  ): Promise<ResolvedConnectionBinding[]> {
    return (
      await database
        .selectFrom("workflow_enablement_connections")
        .selectAll()
        .where("enablement_id", "=", enablementId)
        .orderBy("alias")
        .execute()
    ).map((row) => ({
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
    database: Kysely<DB> = this.db,
  ): Promise<WorkflowEnablement> {
    const [connections, triggers] = await Promise.all([
      this.connectionRows(row.id, database),
      database
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
          "definition.project_kind",
        ])
        .where("activation.enablement_id", "=", row.id)
        .orderBy("definition.binding_index")
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
      permissions: stringArray(row.permissions),
      consentDigest: row.consent_digest,
      status: row.status as WorkflowEnablementStatus,
      suspensionReason: row.suspension_reason,
      updateAvailable: row.update_available,
      follow: row.follow,
      temporary: row.temporary,
      expiresAt: row.expires_at?.toISOString() ?? null,
      revision: row.revision,
      triggers: triggers.map(
        (trigger): WorkflowEnablementTrigger => ({
          id: trigger.id,
          definitionId: trigger.trigger_definition_id,
          kind: trigger.trigger_kind,
          config: trigger.config,
          ...(trigger.project_kind
            ? { projectKind: trigger.project_kind }
            : {}),
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
    metadata: Record<string, string> = {},
  ): Promise<unknown> {
    return trx
      .insertInto("workflow_enablement_events")
      .values({
        enablement_id: enablementId,
        actor_external_user_id: identity.externalUserId,
        event_type: eventType,
        reason,
        metadata: toJson(metadata),
      })
      .execute();
  }
}

/** The branch published revisions are of (ADR 0330). */
const PUBLISHED_BRANCH = "main";

/** Recorded as the actor of what following does on its own. */
export const FOLLOW_ACTOR = "work:follow";

/**
 * A project automation follows by default; a member's own does not, since
 * it uses the member's connections and they should see new code reach
 * them first (ADR 0330).
 */
function followDefault(input: {
  follow?: boolean;
  temporary: boolean;
  remoteBranch: string;
  owner: WorkflowEnablementOwner;
}): boolean {
  const eligible = !input.temporary && input.remoteBranch === PUBLISHED_BRANCH;
  if (input.follow && !eligible)
    throw new WorkflowEnablementFollowUnavailableError();
  return input.follow ?? (eligible && input.owner.type === "project");
}

/**
 * The workflow does not build at that revision: its source does not parse,
 * it is gone, or its triggers do not register. The same files always fail
 * the same way.
 */
function isRevisionBuildError(error: unknown): boolean {
  return [
    WorkflowNotFoundError,
    WorkflowSourceInvalidError,
    TriggerBindingsInvalidError,
    TriggerKindNotRegisteredError,
    TriggerModeNotAllowedError,
  ].some((type) => error instanceof type);
}

/**
 * Errors that mean the owner's authority no longer covers the revision, so
 * it needs a person; anything else means the workflow did not build there.
 */
function isAuthorityError(error: unknown): boolean {
  return [
    AccessDeniedError,
    AuthenticationRequiredError,
    ConnectionNotFoundError,
    ConnectionPermissionDeniedError,
    ConnectionUnavailableError,
    EnvironmentAccessDeniedError,
    EnvironmentBindingUnavailableError,
    EnvironmentIncompatibleError,
    EnvironmentNotFoundError,
    EnvironmentPolicyInvalidError,
    NoCompatibleEnvironmentError,
  ].some((type) => error instanceof type);
}

function ownerFromRow(
  row: Selectable<DB["workflow_enablements"]>,
): WorkflowEnablementOwner {
  return row.owner_kind === "member"
    ? { type: "member", externalUserId: row.owner_external_user_id! }
    : { type: "project" };
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
