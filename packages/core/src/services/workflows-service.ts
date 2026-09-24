import { createHash } from "node:crypto";
import type { ProjectManager, ProjectRepo } from "@catamorphic/git";
import {
  type DeclaredSecret,
  layoutGraph,
  parseProject,
  parseWorkflowFromProject,
  type WorkflowCapabilities,
  type WorkflowExecutionDescriptor,
  type WorkflowGraph,
  type WorkflowTriggerBinding,
} from "@catamorphic/parser";
import {
  hasProjectPermission,
  type Identity,
  identityCovers,
  mayUseProject,
} from "../identity.js";
import { AccessDeniedError } from "./artifact-scope.js";
import { withProgram } from "./program-reader.js";
import type { ProjectsService } from "./projects-service.js";
import { workflowSourceFiles } from "./workflow-source-files.js";

export interface WorkflowSummary {
  name: string;
  capabilities: WorkflowCapabilities;
  execution: WorkflowExecutionDescriptor;
  displayName: string | null;
  description: string | null;
  filePath: string;
  parameterCount: number;
  triggers: WorkflowTriggerBinding[];
  canSuspend: boolean;
}

export interface WorkflowDetail extends WorkflowGraph {
  projectFiles: string[];
  allFiles: Record<string, string>;
}

export class WorkflowNotFoundError extends Error {
  constructor(
    readonly projectId: string,
    readonly workflowName: string,
  ) {
    super(`Workflow '${workflowName}' not found in project '${projectId}'`);
    this.name = "WorkflowNotFoundError";
  }
}

/**
 * Reads workflow definitions by parsing project source files. Workflows are
 * not separate DB entities; the exported TypeScript source is the registry.
 */
export class WorkflowsService {
  constructor(
    private readonly projectManager: ProjectManager,
    private readonly projects: ProjectsService,
  ) {}

  async list(args: {
    identity: Identity;
    projectId: string;
    ref?: string;
  }): Promise<WorkflowSummary[]> {
    await this.projects.getOverview(args);
    return this.withReadableFiles(args, async (files) => {
      const { workflows } = parseProject(files);
      return workflows
        .filter((wf) =>
          this.mayRead(args.identity, args.projectId, wf.functionName),
        )
        .map((wf) => ({
          name: wf.functionName,
          capabilities: wf.graph.capabilities,
          execution: wf.graph.execution,
          displayName: wf.graph.displayName ?? null,
          description: wf.graph.description ?? null,
          filePath: wf.filePath ?? "",
          parameterCount: wf.graph.input.parameters.length,
          triggers: wf.graph.triggers,
          canSuspend: wf.graph.canSuspend,
        }));
    });
  }

  async get(args: {
    identity: Identity;
    projectId: string;
    workflowName: string;
    ref?: string;
  }): Promise<WorkflowDetail> {
    await this.projects.getOverview(args);
    if (!this.mayRead(args.identity, args.projectId, args.workflowName))
      throw new AccessDeniedError();
    return this.withReadableFiles(args, async (allFiles) => {
      const graph = parseWorkflowFromProject(allFiles, args.workflowName);
      if (!graph) {
        throw new WorkflowNotFoundError(args.projectId, args.workflowName);
      }

      layoutGraph({ nodes: graph.nodes, edges: graph.edges });

      return {
        ...graph,
        projectFiles: hasProjectPermission(
          args.identity,
          args.projectId,
          "program:read",
        )
          ? Object.keys(allFiles)
          : [],
        allFiles: hasProjectPermission(
          args.identity,
          args.projectId,
          "program:read",
        )
          ? allFiles
          : {},
      };
    });
  }

  /**
   * Secrets the project declares in its own code via `defineSecrets`. Called
   * on every run trigger (secret injection), so the ts-morph parse is cached
   * per content hash of the parseable sources — the dev tree has no stable
   * ref, and hashing file bytes is orders of magnitude cheaper than parsing
   * them. Exact invalidation: any source change produces a new key.
   */
  async listDeclaredSecrets(args: {
    identity: Identity;
    projectId: string;
    ref?: string;
  }): Promise<DeclaredSecret[]> {
    // Declarations are program source; the secrets page reads them too.
    if (
      !hasProjectPermission(args.identity, args.projectId, "program:read") &&
      !hasProjectPermission(args.identity, args.projectId, "secrets:read")
    )
      throw new AccessDeniedError();
    await this.projects.getOverview(args);
    return this.readDeclaredSecrets(args);
  }

  /**
   * The secrets a run needs. A run's caller may be any member allowed to run
   * the workflow (or the project principal); the declarations belong to the
   * program, so reading them for injection needs no `program:read`.
   */
  async declaredSecretsForRun(args: {
    identity: Identity;
    projectId: string;
  }): Promise<DeclaredSecret[]> {
    if (!mayUseProject(args.identity, args.projectId))
      throw new AccessDeniedError();
    return this.readDeclaredSecrets(args);
  }

  private readDeclaredSecrets(args: {
    identity: Identity;
    projectId: string;
    ref?: string;
  }): Promise<DeclaredSecret[]> {
    return this.withDev(args.identity, args.projectId, async (repo) => {
      const files = await workflowSourceFiles(repo, args.ref);
      const key = `${args.projectId}:${hashParseableSources(files)}`;
      const hit = this.declaredSecretsCache.get(key);
      if (hit) return hit;
      const secrets = parseProject(files).secrets;
      if (this.declaredSecretsCache.size >= DECLARED_SECRETS_CACHE_MAX) {
        const oldest = this.declaredSecretsCache.keys().next().value;
        if (oldest !== undefined) this.declaredSecretsCache.delete(oldest);
      }
      this.declaredSecretsCache.set(key, secrets);
      return secrets;
    });
  }

  private mayRead(
    identity: Identity,
    projectId: string,
    workflowName: string,
  ): boolean {
    return (
      hasProjectPermission(identity, projectId, "program:read") ||
      identityCovers(identity, {
        kind: "workflow",
        projectId,
        name: workflowName,
      })
    );
  }

  private async withReadableFiles<T>(
    args: { identity: Identity; projectId: string; ref?: string },
    read: (files: Record<string, string>) => Promise<T>,
  ): Promise<T> {
    if (hasProjectPermission(args.identity, args.projectId, "program:read")) {
      return this.withDev(args.identity, args.projectId, async (repo) =>
        read(await workflowSourceFiles(repo, args.ref)),
      );
    }
    // A member sees the deployed program, never another user's draft or an
    // arbitrary historical commit supplied by the client.
    if (args.ref && args.ref !== "main") throw new AccessDeniedError();
    if (!this.projectManager.remoteBackend) return read({});
    return withProgram(
      this.projectManager,
      args.identity.tenantId,
      args.projectId,
      async (repo, ref) =>
        read(ref ? await workflowSourceFiles(repo, ref) : {}),
      { publishedOnly: true },
    );
  }

  private readonly declaredSecretsCache = new Map<string, DeclaredSecret[]>();

  private async withDev<T>(
    identity: Identity,
    projectId: string,
    fn: (repo: ProjectRepo) => Promise<T>,
  ): Promise<T> {
    const repo = await this.projectManager.openDev(
      identity.tenantId,
      projectId,
      identity.externalUserId,
    );
    try {
      return await fn(repo);
    } finally {
      await repo.dispose();
    }
  }
}

const DECLARED_SECRETS_CACHE_MAX = 256;

/** Digest of the sources parseProject reads, in stable path order. */
function hashParseableSources(files: Record<string, string>): string {
  const hash = createHash("sha256");
  for (const filePath of Object.keys(files).sort()) {
    if (!filePath.endsWith(".ts") && !filePath.endsWith(".tsx")) continue;
    hash.update(filePath);
    hash.update("\0");
    hash.update(files[filePath] ?? "");
    hash.update("\0");
  }
  return hash.digest("hex");
}
