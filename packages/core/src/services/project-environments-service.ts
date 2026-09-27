import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import {
  type EnvironmentNetworkPolicy,
  type EnvironmentRequirements,
  isEgressPattern,
  type WorkloadKind,
} from "@catamorphic/sandbox";
import { PROJECT_MANIFEST_PATH } from "@catamorphic/workflow/project-layout";
import type { Kysely } from "kysely";
import { z } from "zod";
import type { Identity } from "../identity.js";
import {
  CONNECTION_ALIAS_PATTERN,
  CONNECTION_NAME_PATTERN,
  type EnvironmentConnectionBinding,
} from "./connection-types.js";
import { readProgramFile, withProgram } from "./program-reader.js";
import { requireTenantProject } from "./projects-service.js";

const ENVIRONMENT_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

const ResourcePolicySchema = z.object({
  cpuMillis: z.number().int().positive().optional(),
  memoryMb: z.number().int().positive().optional(),
  storageMb: z.number().int().positive().optional(),
  gpu: z.boolean().optional(),
  commandTimeoutSeconds: z.number().int().positive().optional(),
  maxConcurrency: z.number().int().positive().optional(),
});

const LABEL = /^[a-z0-9][a-z0-9._-]{0,62}$/;

/**
 * A connection alias the Environment offers (ADR 0172). Service authority
 * comes from the named service connection an administrator authorized;
 * member authority from each member's own connection.
 */
const EnvironmentConnectionBindingSchema = z
  .strictObject({
    provider: z.string().regex(CONNECTION_NAME_PATTERN),
    principal: z.enum(["member", "service", "either"]),
    service: z.string().regex(CONNECTION_NAME_PATTERN).optional(),
    capabilities: z.array(z.string().min(1)).optional(),
    /** Git through the gateway (ADR 0175): reachable repositories, push rules. */
    git: z
      .strictObject({
        repositories: z
          .array(
            z
              .string()
              .min(1)
              .max(255)
              .regex(/^[A-Za-z0-9._~-]+(?:\/[A-Za-z0-9._~-]+)*$/),
          )
          .min(1)
          .optional(),
        push: z
          .array(
            z
              .string()
              .min(1)
              .max(255)
              .regex(/^[A-Za-z0-9._/*-]+$/),
          )
          .min(1)
          .optional(),
      })
      .optional(),
    /** Models through the gateway (ADR 0180): allowed model ids. */
    model: z
      .strictObject({
        allow: z
          .array(
            z
              .string()
              .min(1)
              .max(255)
              .regex(/^[A-Za-z0-9._:/@*-]+$/),
          )
          .min(1)
          .optional(),
      })
      .optional(),
  })
  .refine((binding) => binding.principal !== "member" || !binding.service, {
    message: "A member binding does not name a service connection",
    path: ["service"],
  })
  .refine((binding) => binding.principal !== "service" || binding.service, {
    message: "A service binding names its service connection",
    path: ["service"],
  });

/** A project file whose name marks it as a Dockerfile. */
const DOCKERFILE_PATH =
  /^(?!\/)(?!.*(^|\/)\.\.(\/|$))[A-Za-z0-9._/-]*(^|\/|\.)[Dd]ockerfile$/;
/** An OCI reference: registry/name[:tag][@digest], no whitespace. */
const OCI_REFERENCE = /^[a-z0-9][a-z0-9._\-/:]*(@sha256:[a-f0-9]{64})?$/;

const ImageSchema = z
  .string()
  .min(1)
  .max(512)
  .refine((value) => DOCKERFILE_PATH.test(value) || OCI_REFERENCE.test(value), {
    message:
      "image must be an OCI reference (e.g. node:22) or a project Dockerfile path (e.g. .work/images/review.Dockerfile)",
  });

const NetworkSchema = z.discriminatedUnion("egress", [
  z.strictObject({ egress: z.literal("open") }),
  z.strictObject({ egress: z.literal("gateway") }),
  z.strictObject({
    egress: z.literal("allowlist"),
    allow: z
      .array(
        z.string().toLowerCase().refine(isEgressPattern, {
          message: "allow entries are domains, *.suffix patterns, or IPv4",
        }),
      )
      .min(1)
      .max(200),
  }),
]);

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
    /**
     * Minutes a chat may wait without a turn before its workspace gives back
     * its slot and reservation (ADR 0173); `0` keeps it for the chat's life.
     */
    idleReleaseMinutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24 * 30)
      .optional(),
    requirements: z
      .strictObject({
        trust: z.enum(["local", "managed"]).optional(),
        isolation: z.enum(["none", "process", "sandbox"]).optional(),
        capabilities: z.array(z.string().min(1)).optional(),
        resources: ResourcePolicySchema.optional(),
        /** An isolated container runtime inside the sandbox (ADR 0176). */
        containers: z.boolean().optional(),
      })
      .optional(),
    /** The sandbox image: an OCI reference or a project Dockerfile (ADR 0176). */
    image: ImageSchema.optional(),
    /** Outbound reach of the sandbox (ADR 0176). Default open. */
    network: NetworkSchema.optional(),
    /**
     * How long an unattended chat's escalation waits for a person before it
     * is denied (ADR 0176).
     */
    approvals: z
      .strictObject({
        waitMinutes: z
          .number()
          .int()
          .positive()
          .max(7 * 24 * 60),
      })
      .optional(),
    /** Connection aliases, keyed by alias (ADR 0172). */
    connections: z
      .record(
        z.string().regex(CONNECTION_ALIAS_PATTERN),
        EnvironmentConnectionBindingSchema,
      )
      .optional(),
  })
  .refine((definition) => !(definition.device && definition.pool), {
    message: "An Environment runs on a member's device or on a pool, not both",
  });

/** The Environment every project has unless its manifest declares others. */
export const DEFAULT_ENVIRONMENT = "default";

/** Minutes an idle chat keeps its workspace unless its Environment says otherwise. */
export const DEFAULT_IDLE_RELEASE_MINUTES = 30;

/** The image an Environment declares, before a Dockerfile is read. */
export type EnvironmentImage =
  | { kind: "oci"; reference: string }
  | { kind: "dockerfile"; path: string };

export interface ProjectEnvironmentDefinition {
  description?: string;
  workloads: readonly WorkloadKind[];
  pool?: Readonly<Record<string, string>>;
  device?: "member";
  strict?: boolean;
  idleReleaseMinutes?: number;
  connections?: Readonly<Record<string, EnvironmentConnectionBinding>>;
  requirements?: Omit<EnvironmentRequirements, "workload" | "topology"> & {
    containers?: boolean;
  };
  image?: EnvironmentImage;
  network?: EnvironmentNetworkPolicy;
  approvals?: { waitMinutes: number };
}

/** Parse an Environment's `image`: a Dockerfile path or an OCI reference. */
export function environmentImage(value: string): EnvironmentImage {
  return DOCKERFILE_PATH.test(value)
    ? { kind: "dockerfile", path: value }
    : { kind: "oci", reference: value };
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
      const { image, ...rest } = parsed.data;
      const definition: ProjectEnvironmentDefinition = {
        ...rest,
        ...(image ? { image: environmentImage(image) } : {}),
      };
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

  /**
   * An Environment's Dockerfile, read from the same program the manifest
   * came from, so the image is exactly what was reviewed (ADR 0176).
   */
  async readProgramFile(args: {
    identity: Identity;
    projectId: string;
    path: string;
  }): Promise<string | null> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    const publishedOnly =
      args.identity.scope !== undefined &&
      Boolean(
        await this.projectManager.localPath({
          tenantId: args.identity.tenantId,
          projectId: args.projectId,
        }),
      );
    return withProgram(
      this.projectManager,
      args.identity.tenantId,
      args.projectId,
      (repo, ref) =>
        publishedOnly && ref === null
          ? Promise.resolve(null)
          : readProgramFile(repo, ref, args.path),
      { workingTree: args.identity.scope === undefined, publishedOnly },
    );
  }
}
