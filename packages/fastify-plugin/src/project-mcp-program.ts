import type {
  CallRunInput,
  CatamorphicCore,
  Identity,
} from "@catamorphic/core";
import {
  AccessDeniedError,
  assertMayManageRolePolicy,
  assertProjectPermission,
  effectiveProjectPermissions,
  hasProjectPermission,
  mayUseProject,
} from "@catamorphic/core";
import { checkProject } from "@catamorphic/parser";
import { toolError, toolValue } from "./mcp-shared.js";
import type { SurfaceTool } from "./project-mcp-surface.js";

/**
 * The member's working loop on the project MCP (ADR 0166): orient, draft a
 * program change, check it, publish it, run it, and read what happened.
 * Everything a member can do over REST, as tools a member's own agent
 * (Claude Code or any MCP client) uses with the member's identity. Each
 * call goes through the core service that already enforces the member's
 * permissions; nothing is checked by hand beyond choosing what to list.
 *
 * The draft is the member's own working copy of the program (their dev
 * branch): `program_write` changes it, `program_check` validates it, and
 * `program_deploy` publishes it as the project's new production commit.
 * The documents tools keep reading what is live.
 */

const READ_ONLY = { readOnlyHint: true } as const;
const TOOL_SYNC_BUDGET_MS = 30_000;

export function programTools(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): SurfaceTool[] {
  if (!mayUseProject(identity, projectId)) return [];
  const tools: SurfaceTool[] = [overviewTool(core, identity, projectId)];
  const may = (permission: string) =>
    hasProjectPermission(identity, projectId, permission);

  if (may("program:write")) {
    tools.push(
      {
        definition: {
          name: "program_files",
          description:
            "Your draft of the project's program (workflows, apps, agents, roles and skills under .catamorphic/, plus any other files). Without a path, lists files and your unpublished changes; with a path, returns that file from your draft.",
          inputSchema: {
            type: "object",
            properties: {
              path: { type: "string", description: "File to read" },
            },
          },
        },
        call: guarded(async (args) => {
          const status = await refreshDraft(core, identity, projectId);
          const path = str(args.path);
          if (path)
            return {
              path,
              content: await core.projects.readFile(identity, projectId, path),
            };
          const files = await core.projects.listFiles(identity, projectId);
          return {
            files: files.map((file) => file.path).sort(),
            ...draftSummary(status),
          };
        }),
      },
      {
        definition: {
          name: "program_write",
          description:
            "Change files in your draft of the program. Nothing reaches members until program_deploy (or propose_change). Role files under .catamorphic/roles need roles:write.",
          inputSchema: {
            type: "object",
            properties: {
              changes: {
                type: "array",
                items: {
                  type: "object",
                  properties: {
                    path: { type: "string" },
                    content: { type: "string" },
                    delete: { type: "boolean" },
                  },
                  required: ["path"],
                },
              },
            },
            required: ["changes"],
          },
        },
        call: guarded(async (args) => {
          const changes = Array.isArray(args.changes) ? args.changes : [];
          if (changes.length === 0) throw new Error("changes is required");
          await refreshDraft(core, identity, projectId);
          const written: string[] = [];
          for (const raw of changes) {
            const change = asRecord(raw);
            const path = str(change.path);
            if (!path) throw new Error("Each change needs a path");
            if (change.delete === true) {
              await core.projects.deleteFile(identity, projectId, path);
            } else {
              const content = str(change.content);
              if (content === undefined)
                throw new Error(`${path}: pass content or delete: true`);
              await core.projects.writeFile(identity, projectId, path, {
                content,
              });
            }
            written.push(path);
          }
          return { written };
        }),
      },
      {
        definition: {
          name: "program_check",
          description:
            "Refresh your draft's generated types (the trigger kinds this server offers, in .catamorphic/workflows/src/catamorphic-triggers.d.ts, and each app's workflow API types), then validate it the way publishing does: workflow and app parse errors and trigger configurations. Run it after writing and before program_deploy.",
          inputSchema: { type: "object", properties: {} },
        },
        call: guarded(async () => checkDraft(core, identity, projectId)),
      },
    );
  }

  // Deploying publishes the caller's own draft: it takes both.
  if (may("program:write") && may("program:publish")) {
    tools.push({
      definition: {
        name: "program_deploy",
        description:
          "Publish your draft as the project's production program: workflows move to it, and every app it changes (or that was never published) is built and published, with each app's result reported. Refused while program_check reports errors, and for projects whose program lives in a linked repository (use propose_change there).",
        inputSchema: {
          type: "object",
          properties: {
            message: {
              type: "string",
              description: "What changed and why, as a commit message",
            },
          },
          required: ["message"],
        },
      },
      call: guarded(async (args) => {
        const message = str(args.message);
        if (!message) throw new Error("message is required");
        const project = await core.projects.get(identity, projectId);
        if (project.remoteUrl)
          throw new Error(
            `This project's program is published from ${project.remoteUrl}. Open a pull request there, or use propose_change.`,
          );
        const check = await checkDraft(core, identity, projectId);
        if (!check.ok) return { status: "blocked", ...check };
        const before = await core.deployment.getStatus(
          identity.tenantId,
          projectId,
          identity.externalUserId,
        );
        const result = await core.deployment.deploy(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          {
            message,
            guardPublishedPaths: (paths) =>
              assertMayManageRolePolicy(identity, projectId, paths),
          },
        );
        // Nothing new to publish still publishes apps that never were.
        const published =
          result.status === "deployed"
            ? result.commitSha
            : result.status === "nothing-to-deploy"
              ? before.remoteHead
              : null;
        const apps = published
          ? await publishApps({
              core,
              identity,
              projectId,
              base:
                result.status === "deployed" ? before.remoteHead : published,
              head: published,
            })
          : [];
        return { ...result, apps, warnings: check.findings };
      }),
    });
  }

  tools.push(
    {
      definition: {
        name: "workflow_run",
        description:
          "Run a deployed workflow with an input. Waits up to 30 seconds: a finished run returns its output, a longer one returns its runId for run_details. Pass environment to choose where it runs (names in project_overview).",
        inputSchema: {
          type: "object",
          properties: {
            workflow: { type: "string" },
            input: {
              description:
                "The workflow's input, as JSON of the workflow's input type",
              type: ["object", "array", "string", "number", "boolean", "null"],
            },
            environment: { type: "string" },
          },
          required: ["workflow"],
        },
      },
      call: guarded(async (args) => {
        const workflowName = str(args.workflow);
        if (!workflowName) throw new Error("workflow is required");
        const environment = str(args.environment);
        return core.runs.call({
          identity,
          projectId,
          workflowName,
          ...(environment ? { environment } : {}),
          ...(args.input === undefined
            ? {}
            : { input: args.input as CallRunInput["input"] }),
          budgetMs: TOOL_SYNC_BUDGET_MS,
        });
      }),
    },
    {
      definition: {
        name: "workflow_runs",
        description:
          "Recent runs of the project's workflows, newest first, with status and errors. Filter by workflow.",
        inputSchema: {
          type: "object",
          properties: {
            workflow: { type: "string" },
            limit: { type: "integer", minimum: 1, maximum: 100 },
          },
        },
        annotations: READ_ONLY,
      },
      call: guarded(async (args) => {
        const workflowName = str(args.workflow);
        return core.runs.list({
          identity,
          projectId,
          ...(workflowName ? { workflowName } : {}),
          limit: typeof args.limit === "number" ? args.limit : 20,
        });
      }),
    },
    {
      definition: {
        name: "run_details",
        description:
          "One run in full: status, input, output, error, and each step with its result, for debugging a workflow.",
        inputSchema: {
          type: "object",
          properties: { runId: { type: "string" } },
          required: ["runId"],
        },
        annotations: READ_ONLY,
      },
      call: guarded(async (args) => {
        const runId = str(args.runId);
        if (!runId) throw new Error("runId is required");
        const run = await core.runs.get({ identity, runId });
        if (run.projectId !== projectId) throw new Error("Run not found");
        return run;
      }),
    },
  );
  return tools;
}

function overviewTool(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
): SurfaceTool {
  return {
    definition: {
      name: "project_overview",
      description:
        "Start here: the project, your roles and permissions, the agents you can ask, the Environments you can run in, its workflows and apps, and your unpublished draft.",
      inputSchema: { type: "object", properties: {} },
    },
    call: guarded(async () => {
      const optional = <T>(load: () => Promise<T>) =>
        load().catch((error: unknown) => {
          if (error instanceof AccessDeniedError) return undefined;
          throw error;
        });
      const may = (permission: string) =>
        hasProjectPermission(identity, projectId, permission);
      const [project, roles, agents, environments, workflows, apps, draft] =
        await Promise.all([
          optional(() => core.projects.getOverview({ identity, projectId })),
          optional(async () =>
            core.memberships?.describeMember({
              projectId,
              tenantId: identity.tenantId,
              externalUserId: identity.externalUserId,
            }),
          ),
          optional(() => core.agentDefinitions.list(identity, projectId)),
          optional(() => environmentsFor(core, identity, projectId)),
          optional(() => core.workflows.list({ identity, projectId })),
          may("program:read")
            ? optional(async () => core.apps?.list({ identity, projectId }))
            : undefined,
          may("program:write")
            ? optional(() => refreshDraft(core, identity, projectId))
            : undefined,
        ]);
      return {
        project: project
          ? {
              id: project.id,
              name: project.name,
              publishedFrom: project.remoteUrl ?? "this server",
            }
          : { id: projectId },
        you: {
          userId: identity.externalUserId,
          roles: roles ?? [],
          permissions: effectiveProjectPermissions(identity, projectId),
        },
        agents,
        environments,
        workflows,
        apps,
        draft: draft ? draftSummary(draft) : undefined,
      };
    }),
  };
}

/**
 * The caller's draft, first brought up to the published program when it has
 * no unpublished edits, so a member never works from a stale copy. A draft
 * with edits keeps them; publishing merges.
 */
async function refreshDraft(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
) {
  const args = [identity.tenantId, projectId, identity.externalUserId] as const;
  const status = await core.deployment.getStatus(...args);
  if (status.dirty || status.ahead > 0 || status.behind === 0) return status;
  await core.deployment.pullFromRemote(...args);
  return core.deployment.getStatus(...args);
}

function draftSummary(status: {
  modifiedFiles: string[];
  ahead: number;
  behind: number;
}) {
  return {
    changed: status.modifiedFiles,
    unpublishedCommits: status.ahead,
    ...(status.behind > 0
      ? {
          behindPublished: status.behind,
          note: "Others published since your draft began; program_deploy merges their changes with yours.",
        }
      : {}),
  };
}

/** Each Environment once, with what it can run for this caller. */
async function environmentsFor(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
) {
  const service = core.executionEnvironments;
  if (!service) return undefined;
  const [agents, workflows] = await Promise.all(
    (["agent", "workflow"] as const).map((workload) =>
      service.discover({ identity, projectId, requirements: { workload } }),
    ),
  );
  const workflowsByName = new Map(
    (workflows?.items ?? []).map((item) => [item.name, item]),
  );
  const usable = (item?: {
    allowed: boolean;
    available: boolean;
    compatible: boolean;
  }) => Boolean(item?.allowed && item.available && item.compatible);
  return {
    items: (agents?.items ?? []).map((item) => ({
      name: item.name,
      description: item.description,
      agents: usable(item),
      workflows: usable(workflowsByName.get(item.name)),
      ...(usable(item) || usable(workflowsByName.get(item.name))
        ? {}
        : { reasons: item.reasons }),
    })),
    defaultForAgents: agents?.defaultEnvironment,
    defaultForWorkflows: workflows?.defaultEnvironment,
  };
}

/**
 * Publishing the program publishes its apps: each app whose source or
 * workflow contract changed in this deploy, or that has no published
 * version yet, is built at the new commit and published. A failed build
 * keeps the app's previous version and reports why.
 */
async function publishApps(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId: string;
  base: string | null;
  head: string;
}) {
  const { core, identity, projectId } = args;
  const apps = core.apps;
  if (!apps) return [];
  const summaries = await apps.list({ identity, projectId });
  if (summaries.length === 0) return [];
  const changed = args.base
    ? (
        await core.deployment.diffRefs(
          identity.tenantId,
          projectId,
          identity.externalUserId,
          args.base,
          args.head,
        )
      ).map((entry) => entry.path)
    : undefined;
  const contractChanged = changed?.some(
    (path) =>
      path.startsWith(".catamorphic/contracts/") ||
      path.startsWith(".catamorphic/workflows/"),
  );
  const results: Array<{
    app: string;
    status: "published" | "failed";
    error?: string;
  }> = [];
  for (const summary of summaries) {
    const touched =
      !changed ||
      contractChanged ||
      changed.some((path) =>
        path.startsWith(`.catamorphic/apps/${summary.name}/`),
      );
    if (summary.activeVersionId && !touched) continue;
    try {
      const version = await apps.build({
        identity,
        projectId,
        appName: summary.name,
        kind: "published",
        commitSha: args.head,
      });
      if (version.status !== "ready") {
        results.push({
          app: summary.name,
          status: "failed",
          error: version.error ?? "Build failed",
        });
        continue;
      }
      await apps.publish({ identity, projectId, versionId: version.id });
      results.push({ app: summary.name, status: "published" });
    } catch (error) {
      results.push({
        app: summary.name,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return results;
}

async function checkDraft(
  core: CatamorphicCore,
  identity: Identity,
  projectId: string,
) {
  assertProjectPermission(identity, projectId, "program:write");
  const generated = await core.triggers.syncTypes({ identity, projectId });
  const files = await core.projects.readAllFiles(identity, projectId);
  const result = checkProject(files, {
    triggerKinds: core.triggers.listKinds(),
  });
  return {
    ok: result.ok,
    findings: result.findings,
    ...(generated.updated ? { refreshed: generated.paths } : {}),
  };
}

function guarded(fn: (args: Record<string, unknown>) => Promise<unknown>) {
  return async (args: Record<string, unknown>) => {
    try {
      return toolValue(await fn(args));
    } catch (error) {
      if (error instanceof AccessDeniedError)
        return toolError("Your roles do not allow that.");
      // Filesystem errors name server paths; say what happened instead.
      const code =
        typeof error === "object" && error !== null && "code" in error
          ? error.code
          : undefined;
      if (code === "ENOENT") return toolError("No such file in your draft.");
      if (code === "EISDIR") return toolError("That path is a folder.");
      if (code === "ENOTDIR")
        return toolError("A parent of that path is a file.");
      return toolError(error instanceof Error ? error.message : String(error));
    }
  };
}

function str(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

/**
 * The orientation a client receives at `initialize`: what this endpoint is
 * and the member's working loop, naming only tools this caller has.
 */
export async function projectInstructions(args: {
  core: CatamorphicCore;
  identity: Identity;
  projectId: string;
  toolNames: ReadonlySet<string>;
  host?: string;
}): Promise<string> {
  const { core, identity, projectId, toolNames } = args;
  const has = (name: string) => toolNames.has(name);
  const project = await Promise.resolve()
    .then(() => core.projects.getOverview({ identity, projectId }))
    .catch(() => undefined);
  const lines = [
    `This is the project${project ? ` "${project.name}"` : ""} on a shared server. Everything you do here acts as you, with your own roles; call project_overview first to see them.`,
  ];
  if (has("documents_read"))
    lines.push(
      "- Live material: documents_list, documents_read and documents_search read the published program and store/ documents. documents_write changes store/ documents directly.",
    );
  if (has("program_write"))
    lines.push(
      `- Program changes (workflows, apps, agents under .catamorphic/): program_write edits your private draft, program_files reads it, program_check validates it${
        has("program_deploy")
          ? ", program_deploy publishes it."
          : ", and propose_change asks someone who may publish to review it."
      }`,
    );
  else if (has("propose_change"))
    lines.push(
      "- Program changes go through propose_change, which a publisher reviews.",
    );
  if (has("list_skills"))
    lines.push(
      "- Read the project's skills (list_skills, read_skill) before writing workflows or apps: writing-workflows and building-apps hold the contracts.",
    );
  lines.push(
    "- Run deployed workflows with workflow_run and debug them with workflow_runs and run_details.",
  );
  if (has("ask_agent"))
    lines.push(
      "- ask_agent runs one of the project's agents on the server, in an Environment you may use. Server agents reach connected systems, such as a production database, through the reviewed gateway; you never receive those credentials.",
    );
  if (args.host) lines.push(args.host);
  return lines.join("\n");
}
