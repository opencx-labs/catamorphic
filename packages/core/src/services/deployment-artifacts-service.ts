import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { RunPluginPayload } from "@catamorphic/sandbox";
import type { Kysely, Selectable } from "kysely";

type DeploymentArtifactRow = Selectable<DB["deployment_artifacts"]>;

export type DeploymentArtifactStatus =
  | "pending"
  | "building"
  | "ready"
  | "failed"
  | "retired";

export interface DeploymentArtifact {
  id: string;
  projectId: string;
  commitSha: string;
  artifactDigest: string;
  pluginDigest: string;
  transformVersion: string;
  runtimeVersion: string;
  status: DeploymentArtifactStatus;
  createdAt: string;
  readyAt: string | null;
  lastUsedAt: string;
}

const TRANSFORM_VERSION = "execution-transform-v1";
const RUNTIME_VERSION = "runtime-protocol-v2";
const tracer = getTracer("@catamorphic/core");

export class DeploymentArtifactsService {
  constructor(private readonly db: Kysely<DB>) {}

  async ensure(args: {
    tenantId: string;
    projectId: string;
    commitSha: string;
    files: Record<string, string>;
    plugins?: readonly RunPluginPayload[];
  }): Promise<DeploymentArtifact> {
    return withSpan(
      {
        tracer,
        name: "deployment_artifact.ensure",
        attributes: {
          "catamorphic.tenant.id": args.tenantId,
          "catamorphic.project.id": args.projectId,
        },
      },
      async (span) => {
        const pluginDigest = await digestPlugins(args.plugins ?? []);
        const artifactDigest = await sha256(
          stableSerialize({
            commitSha: args.commitSha,
            files: sortedRecord(args.files),
            pluginDigest,
            transformVersion: TRANSFORM_VERSION,
            runtimeVersion: RUNTIME_VERSION,
          }),
        );
        const row = await this.db
          .insertInto("deployment_artifacts")
          .values({
            project_id: args.projectId,
            commit_sha: args.commitSha,
            artifact_digest: artifactDigest,
            plugin_digest: pluginDigest,
            transform_version: TRANSFORM_VERSION,
            runtime_version: RUNTIME_VERSION,
          })
          .onConflict((conflict) =>
            conflict.columns(["project_id", "artifact_digest"]).doUpdateSet({
              last_used_at: new Date(),
            }),
          )
          .returningAll()
          .executeTakeFirstOrThrow();
        span.setAttribute("catamorphic.deployment_artifact.id", row.id);
        span.setAttribute("catamorphic.deployment_artifact.status", row.status);
        return mapDeploymentArtifact(row);
      },
    );
  }

  async get(args: { artifactId: string }): Promise<DeploymentArtifact | null> {
    const row = await this.db
      .selectFrom("deployment_artifacts")
      .where("id", "=", args.artifactId)
      .selectAll()
      .executeTakeFirst();
    return row ? mapDeploymentArtifact(row) : null;
  }

  async markStatus(args: {
    artifactId: string;
    status: DeploymentArtifactStatus;
  }): Promise<void> {
    await withSpan(
      {
        tracer,
        name: "deployment_artifact.mark_status",
        attributes: {
          "catamorphic.deployment_artifact.id": args.artifactId,
          "catamorphic.deployment_artifact.status": args.status,
        },
      },
      () =>
        this.db
          .updateTable("deployment_artifacts")
          .set({
            status: args.status,
            ready_at: args.status === "ready" ? new Date() : undefined,
            last_used_at: new Date(),
          })
          .where("id", "=", args.artifactId)
          .execute()
          .then(() => undefined),
    );
  }
}

async function digestPlugins(
  plugins: readonly RunPluginPayload[],
): Promise<string> {
  return sha256(
    stableSerialize(
      [...plugins]
        .sort((left, right) =>
          left.packageName.localeCompare(right.packageName),
        )
        .map((plugin) => ({
          packageName: plugin.packageName,
          files: sortedRecord(plugin.files),
        })),
    ),
  );
}

async function sha256(value: string): Promise<string> {
  const bytes = new TextEncoder().encode(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (byte) =>
    byte.toString(16).padStart(2, "0"),
  ).join("");
}

function sortedRecord(
  value: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(value).sort(([left], [right]) => left.localeCompare(right)),
  );
}

function stableSerialize(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableSerialize).join(",")}]`;
  }
  if (value && typeof value === "object") {
    const entries = Object.entries(value).sort(([left], [right]) =>
      left.localeCompare(right),
    );
    return `{${entries
      .map(([key, entry]) => `${JSON.stringify(key)}:${stableSerialize(entry)}`)
      .join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

function mapDeploymentArtifact(row: DeploymentArtifactRow): DeploymentArtifact {
  return {
    id: row.id,
    projectId: row.project_id,
    commitSha: row.commit_sha,
    artifactDigest: row.artifact_digest,
    pluginDigest: row.plugin_digest,
    transformVersion: row.transform_version,
    runtimeVersion: row.runtime_version,
    status: parseDeploymentArtifactStatus(row.status),
    createdAt: row.created_at.toISOString(),
    readyAt: row.ready_at?.toISOString() ?? null,
    lastUsedAt: row.last_used_at.toISOString(),
  };
}

function parseDeploymentArtifactStatus(
  value: string,
): DeploymentArtifactStatus {
  if (
    value === "pending" ||
    value === "building" ||
    value === "ready" ||
    value === "failed" ||
    value === "retired"
  ) {
    return value;
  }
  throw new Error(`Unknown deployment artifact status: ${value}`);
}
