import type { DB, Json } from "@catamorphic/db";
import type { Kysely } from "kysely";
import { type Identity, identityCovers, mayUseProject } from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { requireTenantProject } from "./projects-service.js";
import type { RunsService } from "./runs-service.js";
import {
  type SessionArtifactAddress,
  SessionArtifactConflictError,
  type SessionArtifactsService,
} from "./session-artifacts-service.js";
import type { WorkflowEnablementsService } from "./workflow-enablements-service.js";

/** Member-owned retained source uses ordinary deployment, enablement and runs. */
export class PrivateWorkflowsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly deps: {
      artifacts: SessionArtifactsService;
      enablements: WorkflowEnablementsService;
      runs: RunsService;
    },
  ) {}

  /** Whether this caller owns approved private work that still needs a worker. */
  async hasEnabled(input: {
    identity: Identity;
    projectId?: string;
  }): Promise<boolean> {
    if (input.projectId) {
      await requireTenantProject(
        this.db,
        input.identity.tenantId,
        input.projectId,
      );
      if (!mayUseProject(input.identity, input.projectId))
        throw new AccessDeniedError();
    }
    let query = this.db
      .selectFrom("session_artifacts as source")
      .innerJoin("projects", "projects.id", "source.project_id")
      .where("projects.tenant_id", "=", input.identity.tenantId)
      .where(
        "source.owner_external_user_id",
        "=",
        input.identity.externalUserId,
      )
      .where("source.lifetime", "=", "member")
      .select([
        "source.id",
        "source.name",
        "source.project_id",
        "source.status",
      ]);
    if (input.projectId)
      query = query.where("source.project_id", "=", input.projectId);
    const sources = (await query.execute()).filter((source) =>
      identityCovers(input.identity, {
        kind: "workflow",
        projectId: source.project_id,
        name: source.name,
      }),
    );
    if (!sources.length) return false;
    const active = sources
      .filter((source) => source.status === "active")
      .map((source) => source.id);
    if (active.length) {
      const enabled = await this.db
        .selectFrom("workflow_enablements as enablement")
        .innerJoin(
          "session_artifact_revisions as revision",
          "revision.commit_sha",
          "enablement.commit_sha",
        )
        .where("revision.artifact_id", "in", active)
        .where("enablement.tenant_id", "=", input.identity.tenantId)
        .where("enablement.owner_kind", "=", "member")
        .where(
          "enablement.owner_external_user_id",
          "=",
          input.identity.externalUserId,
        )
        .where("enablement.status", "!=", "disabled")
        .where(({ or, eb }) =>
          or([
            eb("enablement.expires_at", "is", null),
            eb("enablement.expires_at", ">", new Date()),
          ]),
        )
        .select("enablement.id")
        .limit(1)
        .executeTakeFirst();
      if (enabled) return true;
    }
    return Boolean(
      await this.db
        .selectFrom("workflow_runs")
        .where(
          "session_artifact_id",
          "in",
          sources.map((source) => source.id),
        )
        .where("external_user_id", "=", input.identity.externalUserId)
        .where("status", "not in", ["completed", "failed", "canceled"])
        .select("id")
        .limit(1)
        .executeTakeFirst(),
    );
  }

  private async source(input: SessionArtifactAddress & { revision?: number }) {
    const source = await this.deps.artifacts.get(input);
    if (source.lifetime !== "member" || source.kind !== "workflow")
      throw new AccessDeniedError();
    if (input.revision !== undefined && source.revision !== input.revision)
      throw new SessionArtifactConflictError(
        "Artifact changed. Read its current revision.",
      );
    return source;
  }

  async preview(
    input: SessionArtifactAddress & { revision: number; environment?: string },
  ) {
    const source = await this.source(input);
    return this.deps.enablements.preview({
      ...input,
      workflowName: source.name,
      commitSha: source.commitSha,
      remoteBranch: source.remoteBranch,
    });
  }

  async activate(
    input: SessionArtifactAddress & {
      revision: number;
      environment?: string;
      consentDigest: string;
    },
  ) {
    const source = await this.source(input);
    const pin = {
      ...input,
      workflowName: source.name,
      commitSha: source.commitSha,
      remoteBranch: source.remoteBranch,
    };
    const assertRevision = async (transaction: Kysely<DB>) => {
      const current = await transaction
        .selectFrom("session_artifacts")
        .select(["revision", "status"])
        .where("id", "=", source.id)
        .forUpdate()
        .executeTakeFirstOrThrow();
      if (current.status !== "active" || current.revision !== input.revision)
        throw new SessionArtifactConflictError(
          "Artifact changed before activation.",
        );
    };
    const preview = await this.preview(input);
    const reusable = source.workflowEnablementId
      ? await this.deps.enablements.get({
          identity: input.identity,
          enablementId: source.workflowEnablementId,
        })
      : (
          await this.deps.enablements.list({
            identity: input.identity,
            projectId: input.projectId,
            workflowName: source.name,
          })
        ).find(
          (enablement) =>
            enablement.owner.type === "member" &&
            enablement.owner.externalUserId === input.identity.externalUserId &&
            enablement.environment === preview.environment,
        );
    if (reusable) {
      const current = reusable;
      if (
        current.status === "active" &&
        current.commitSha === source.commitSha &&
        current.consentDigest === input.consentDigest &&
        (!input.environment || input.environment === current.environment)
      ) {
        await this.deps.enablements.revalidate({
          identity: input.identity,
          enablementId: current.id,
        });
        return current;
      }
      return this.deps.enablements.updateDeployment({
        ...pin,
        enablementId: current.id,
        onUpdate: async (transaction) => {
          await assertRevision(transaction);
          await transaction
            .updateTable("session_artifacts")
            .set({ workflow_enablement_id: null })
            .where("workflow_enablement_id", "=", current.id)
            .where("id", "!=", source.id)
            .execute();
          await transaction
            .updateTable("session_artifacts")
            .set({ workflow_enablement_id: current.id })
            .where("id", "=", source.id)
            .execute();
        },
      });
    }
    return this.deps.enablements.create({
      ...pin,
      onCreate: async ({ transaction, enablement }) => {
        await assertRevision(transaction);
        await transaction
          .updateTable("session_artifacts")
          .set({ workflow_enablement_id: enablement.id })
          .where("id", "=", source.id)
          .execute();
      },
    });
  }

  async stop(input: SessionArtifactAddress & { signal?: AbortSignal }) {
    const source = await this.source(input);
    const enablements = await this.db
      .selectFrom("workflow_enablements")
      .where("project_id", "=", input.projectId)
      .where("owner_kind", "=", "member")
      .where("owner_external_user_id", "=", input.identity.externalUserId)
      .where(
        "commit_sha",
        "in",
        this.db
          .selectFrom("session_artifact_revisions")
          .select("commit_sha")
          .where("artifact_id", "=", source.id),
      )
      .select("id")
      .execute();
    for (const enablement of enablements)
      await this.deps.enablements.disable({
        identity: input.identity,
        enablementId: enablement.id,
        signal: input.signal,
      });
    const active = await this.db
      .selectFrom("workflow_runs")
      .select("id")
      .where("session_artifact_id", "=", source.id)
      .where("parent_run_id", "is", null)
      .where("status", "not in", ["completed", "failed", "canceled"])
      .execute();
    for (const run of active)
      await this.deps.runs.cancel({ identity: input.identity, runId: run.id });
    return { stopped: true };
  }

  async run(
    input: SessionArtifactAddress & {
      revision: number;
      environment?: string;
      input?: Json;
    },
  ) {
    const source = await this.source(input);
    return this.deps.runs.triggerAtCommit({
      identity: input.identity,
      projectId: input.projectId,
      workflowName: source.name,
      commitSha: source.commitSha,
      remoteBranch: source.remoteBranch,
      environment: input.environment,
      input: input.input ?? {},
    });
  }
}
