import type { DB } from "@catamorphic/db";
import { PROJECT_MANIFEST_PATH, type ProjectManager } from "@catamorphic/git";
import type {
  EnvironmentRequirements,
  WorkloadKind,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import { readProgramFile, withProgram } from "./program-reader.js";
import { requireTenantProject } from "./projects-service.js";

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ResourcePolicySchema = z.object({
  cpuMillis: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  storageMb: z.number().int().positive().optional(),
  gpu: z.boolean().optional(),
  timeoutSeconds: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
});

const LABEL = /^[a-z0-9][a-z0-9._-]{0,62}$/;

const ProjectEnvironmentDefinitionSchema = z
  .strictObject({
    description: z.string().optional(),
    workloads: z.array(z.enum(["agent", "workflow"])).min(1),
    /** Node labels that must all match (ADR 0167); none selects any node. */
    pool: z
      .record(z.string().regex(LABEL), z.string().min(1).max(128))
      .optional(),
    /** A member's own connected computer (ADR 0098). */
    device: z.literal("member").optional(),
    /** Never fall back past the narrowest nodes open to the owner. */
    strict: z.boolean().optional(),
    requirements: z
      .strictObject({
        trust: z.enum(["local", "managed"]).optional(),
        isolation: z.enum(["none", "process", "sandbox"]).optional(),
        capabilities: z.array(z.string().min(1)).optional(),
        resources: ResourcePolicySchema.optional(),
      })
      .optional(),
  })
  .refine((definition) => !(definition.device && definition.pool), {
    message: "An Environment runs on a member's device or on a pool, not both",
  });

/** The Environment every project has unless its manifest declares others. */
export const DEFAULT_ENVIRONMENT = "default";

export interface ProjectEnvironmentDefinition {
  description?: string;
  workloads: readonly WorkloadKind[];
  pool?: Readonly<Record<string, string>>;
  device?: "member";
  strict?: boolean;
  requirements?: Omit<EnvironmentRequirements, "workload" | "topology">;
}

export interface ProjectEnvironmentEntry {
  name: string;
  definition?: ProjectEnvironmentDefinition;
  invalid?: { error: string };
}

export interface ProjectEnvironmentPolicy {
  environments: Readonly<Record<string, ProjectEnvironmentDefinition>>;
  defaultEnvironment?: string;
  entries: readonly ProjectEnvironmentEntry[];
  invalid?: { error: string };
}

function defaultEnvironmentPolicy(): ProjectEnvironmentPolicy {
  const definition: ProjectEnvironmentDefinition = {
    description: "Run where this host places work",
    workloads: ["agent", "workflow"],
  };
  return {
    environments: { [DEFAULT_ENVIRONMENT]: definition },
    defaultEnvironment: DEFAULT_ENVIRONMENT,
    entries: [{ name: DEFAULT_ENVIRONMENT, definition }],
  };
}

export function parseProjectEnvironmentPolicy(
  raw: unknown,
): ProjectEnvironmentPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      environments: {},
      entries: [],
      invalid: { error: "Project manifest must be a JSON object" },
    };
  }
  const manifest = raw as Record<string, unknown>;
  const rawEnvironments = manifest.environments;
  if (rawEnvironments === undefined) {
    return defaultEnvironmentPolicy();
  }
  if (
    typeof rawEnvironments !== "object" ||
    rawEnvironments === null ||
    Array.isArray(rawEnvironments)
  ) {
    return {
      environments: {},
      entries: [],
      invalid: { error: "Project manifest must declare environments" },
    };
  }
  const entries = Object.entries(rawEnvironments)
    .map(([name, value]): ProjectEnvironmentEntry => {
      if (!ENVIRONMENT_NAME.test(name)) {
        return {
          name,
          invalid: { error: `Invalid Environment name '${name}'` },
        };
      }
      const parsed = ProjectEnvironmentDefinitionSchema.safeParse(value);
      if (!parsed.success) {
        const issue = parsed.error.issues[0];
        return {
          name,
          invalid: {
            error: issue
              ? `${issue.path.join(".") || "(root)"}: ${issue.message}`
              : "Invalid Environment definition",
          },
        };
      }
      const definition: ProjectEnvironmentDefinition = parsed.data;
      return { name, definition };
    })
    .sort((a, b) => a.name.localeCompare(b.name));
  const environments = Object.fromEntries(
    entries.flatMap((entry) =>
      entry.definition ? [[entry.name, entry.definition] as const] : [],
    ),
  );
  const defaultEnvironment = manifest.defaultEnvironment;
  if (
    defaultEnvironment !== undefined &&
    (typeof defaultEnvironment !== "string" ||
      environments[defaultEnvironment] === undefined)
  ) {
    return {
      environments,
      entries,
      invalid: {
        error: "defaultEnvironment must name a valid declared Environment",
      },
    };
  }
  return {
    environments,
    entries,
    ...(typeof defaultEnvironment === "string" ? { defaultEnvironment } : {}),
  };
}

export class ProjectEnvironmentsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
  ) {}

  async list(args: {
    identity: Identity;
    projectId: string;
  }): Promise<ProjectEnvironmentPolicy> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const publishedOnly =
      args.identity.scope !== undefined &&
      Boolean(
        await this.projectManager.localPath({
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
        }),
      );
    const content = await withProgram(
      this.projectManager,
      args.identity.tenantId,
      args.projectId,
      (repo, ref) =>
        publishedOnly && ref === null
          ? Promise.resolve(null)
          : readProgramFile(repo, ref, PROJECT_MANIFEST_PATH),
      {
        workingTree: args.identity.scope === undefined,
        publishedOnly,
      },
    );
    if (!content) {
      return defaultEnvironmentPolicy();
    }
    try {
      return parseProjectEnvironmentPolicy(JSON.parse(content));
    } catch (cause) {
      return {
        environments: {},
        entries: [],
        invalid: {
          error: `Project manifest is not valid JSON: ${
            cause instanceof Error ? cause.message : String(cause)
          }`,
        },
      };
    }
  }

  async get(args: {
    identity: Identity;
    projectId: string;
    name: string;
  }): Promise<ProjectEnvironmentDefinition | undefined> {
    return (await this.list(args)).environments[args.name];
  }
}
