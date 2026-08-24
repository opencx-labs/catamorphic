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

const ProjectEnvironmentDefinitionSchema = z.object({
  binding: z.string().min(1),
  description: z.string().optional(),
  workloads: z.array(z.enum(["agent", "workflow"])).min(1),
  requirements: z
    .object({
      trust: z.enum(["local", "managed"]).optional(),
      isolation: z.enum(["none", "process", "sandbox"]).optional(),
      capabilities: z.array(z.string().min(1)).optional(),
      resources: ResourcePolicySchema.optional(),
    })
    .optional(),
});

export interface ProjectEnvironmentDefinition {
  binding: string;
  description?: string;
  workloads: readonly WorkloadKind[];
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
    const content = await withProgram(
      this.projectManager,
      args.identity.tenantId,
      args.projectId,
      (repo, ref) => readProgramFile(repo, ref, PROJECT_MANIFEST_PATH),
    );
    if (!content) {
      return {
        environments: {},
        entries: [],
        invalid: { error: "Project manifest is missing" },
      };
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
