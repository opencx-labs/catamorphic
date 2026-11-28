import type { DB } from "@catamorphic/db";
import type { ProjectManager } from "@catamorphic/git";
import {
  type EnvironmentNetworkPolicy,
  type EnvironmentRequirements,
  isEgressPattern,
  VOLUME_NAME_PATTERN,
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

const EgressAllowSchema = z
  .array(
    z.string().toLowerCase().refine(isEgressPattern, {
      message: "allow entries are domains, *.suffix patterns, or IPv4",
    }),
  )
  .min(1)
  .max(200);

const NetworkSchema = z.discriminatedUnion("egress", [
  z.strictObject({ egress: z.literal("open") }),
  z.strictObject({ egress: z.literal("gateway") }),
  z.strictObject({ egress: z.literal("allowlist"), allow: EgressAllowSchema }),
]);

/**
 * How a new workspace gets the commit it stands on (ADR 0353): a shell
 * command run in its empty checkout, a Git repository whose remote `work`
 * serves exactly that commit (`$WORK_BASE`).
 */
const CheckoutSchema = z.strictObject({
  command: z.string().min(1).max(16_384),
  timeoutMinutes: z.number().int().positive().max(240).optional(),
});

/**
 * What a manifest that still names a setup workflow is told (ADR 0355): a
 * workflow is never named in configuration.
 */
export const SETUP_WORKFLOW_REMOVED =
  'setup.workflow was removed: a workflow is not named in configuration. Bind it to the trigger in its own source instead, trigger("session.workspace-setup", {}), and enable it for the project';

/**
 * An Environment's workspace setup (ADRs 0208, 0257): a command, how long
 * it and the runs of its setup event may take, and the network and secrets
 * both run with. A project workflow sets workspaces up by binding
 * `session.workspace-setup` in its own source (ADR 0355), never by name
 * here.
 */
const SetupSchema = z
  .strictObject({
    command: z.string().min(1).max(16_384).optional(),
    /** Removed (ADR 0355); named only to say what to write instead. */
    workflow: z.never({ error: SETUP_WORKFLOW_REMOVED }).optional(),
    timeoutMinutes: z.number().int().positive().max(240).optional(),
    /** The only hosts the setup reaches, while it runs (ADR 0257). */
    network: z.strictObject({ allow: EgressAllowSchema }).optional(),
    /**
     * The Environment's secrets a setup with its own network runs with (ADR
     * 0257); it runs with no others.
     */
    secrets: z.array(z.string()).max(200).optional(),
  })
  .refine(
    (setup) =>
      setup.command !== undefined ||
      setup.network !== undefined ||
      setup.timeoutMinutes !== undefined,
    {
      message:
        "setup names a command, a network of its own, or how long it may take",
    },
  );

/**
 * A secret name an Environment may list or `project.json` may declare (ADR
 * 0206): an environment variable name, outside the prefixes Work sets.
 */
export const ENVIRONMENT_SECRET_NAME =
  /^(?!CATAMORPHIC_|WORK_)[A-Z][A-Z0-9_]*$/;

const SecretNameSchema = z
  .string()
  .max(128)
  .regex(
    ENVIRONMENT_SECRET_NAME,
    "Secret names are SCREAMING_SNAKE_CASE and do not start with CATAMORPHIC_ or WORK_",
  );

/** Where a volume mounts: absolute, or `~/...` under the sandbox user's home. */
const VolumePathSchema = z
  .string()
  .min(1)
  .max(1024)
  .refine(
    (path) =>
      (path === "~" || path.startsWith("~/") || path.startsWith("/")) &&
      !path.split("/").some((part) => part === ".." || part === ".") &&
      !/[\0\n]/.test(path),
    { message: "A volume path is absolute or starts with ~/" },
  );

const VolumeSchema = z.union([
  VolumePathSchema,
  z.strictObject({
    path: VolumePathSchema,
    /** Mounted into one sandbox at a time (ADR 0208). */
    exclusive: z.boolean().optional(),
    sizeMb: z
      .number()
      .int()
      .positive()
      .max(1024 * 1024)
      .optional(),
  }),
]);

/** The largest cache an Environment may declare, in MiB (1 TiB). */
const MAX_CACHE_MB = 1024 * 1024;

/** A cache's size limit unless it names one, in MiB (ADR 0334). */
export const DEFAULT_CACHE_SIZE_MB = 10 * 1024;

/** Minutes a cache's fill may run unless it says otherwise (ADR 0334). */
export const DEFAULT_CACHE_FILL_TIMEOUT_MINUTES = 30;

/**
 * A directory every sandbox of the Environment mounts read only, which only
 * a fill at a published revision writes (ADR 0334).
 */
const CacheSchema = z.strictObject({
  path: VolumePathSchema,
  sizeMb: z.number().int().positive().max(MAX_CACHE_MB).optional(),
  fill: z.strictObject({
    /** Run in the project folder of the published revision's checkout. */
    command: z.string().min(1).max(16_384),
    timeoutMinutes: z.number().int().positive().max(240).optional(),
  }),
});

/** One spelling of a volume or cache path, to compare them. */
function pathSegments(path: string): string[] {
  return path.split("/").filter((part, index) => index === 0 || part !== "");
}

/** Whether two declared paths are the same directory or one holds the other. */
function nested(left: string, right: string): boolean {
  const a = pathSegments(left);
  const b = pathSegments(right);
  const shorter = a.length <= b.length ? a : b;
  const longer = shorter === a ? b : a;
  return shorter.every((part, index) => longer[index] === part);
}

/** `project.json`'s own secret declarations (ADR 0206). */
const ProjectSecretDeclarationsSchema = z.record(
  SecretNameSchema,
  z.strictObject({
    label: z.string().max(120).optional(),
    description: z.string().max(2000).optional(),
  }),
);

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
    /**
     * Minutes work may wait for a machine when none open to it has room or
     * is online (ADR 0258): a new chat starts waiting and its turn fails
     * after this. `0`, the default, fails a new chat at once.
     */
    waitMinutes: z
      .number()
      .int()
      .min(0)
      .max(60 * 24)
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
    /**
     * A member's own chats here may carry that member's personal
     * credentials: harness logins and listed files (ADR 0184).
     */
    personalCredentials: z.boolean().optional(),
    /** Project secrets this Environment's sandboxes receive (ADR 0206). */
    secrets: z.array(SecretNameSchema).max(200).optional(),
    /** How a new workspace fetches its base (ADR 0353). */
    checkout: CheckoutSchema.optional(),
    /** Run in every new workspace's project folder (ADRs 0208, 0257). */
    setup: SetupSchema.optional(),
    /** Directories kept on the machine for each owner (ADR 0208). */
    volumes: z
      .record(
        z
          .string()
          .regex(
            VOLUME_NAME_PATTERN,
            "Volume names are lowercase letters, digits and dashes",
          ),
        VolumeSchema,
      )
      .optional(),
    /**
     * Directories mounted read only into every sandbox, filled only from
     * a published revision (ADR 0334).
     */
    caches: z
      .record(
        z
          .string()
          .regex(
            VOLUME_NAME_PATTERN,
            "Cache names are lowercase letters, digits and dashes",
          ),
        CacheSchema,
      )
      .optional(),
    /** Connection aliases, keyed by alias (ADR 0172). */
    connections: z
      .record(
        z.string().regex(CONNECTION_ALIAS_PATTERN),
        EnvironmentConnectionBindingSchema,
      )
      .optional(),
    /**
     * Run the agent's commands apart from the agent (ADR 0332), reaching
     * through the gateway only the bindings `connections` lists.
     */
    commands: z
      .strictObject({
        separate: z.boolean(),
        connections: z
          .array(z.string().regex(CONNECTION_ALIAS_PATTERN))
          .max(64)
          .optional(),
        /**
         * The agent container's own limits (ADR 0332); the Environment's
         * `requirements.resources` are the command container's. 1 CPU and
         * 2 GiB by default; the Allocation reserves both.
         */
        agentResources: z
          .strictObject({
            cpuMillis: z.number().int().positive().max(1_024_000).optional(),
            memoryMb: z
              .number()
              .int()
              .positive()
              .max(4 * 1024 * 1024)
              .optional(),
          })
          .optional(),
      })
      .optional(),
  })
  .refine((definition) => !(definition.device && definition.pool), {
    message: "An Environment runs on a member's device or on a pool, not both",
  })
  .refine(
    (definition) =>
      !definition.setup?.network ||
      (definition.network !== undefined &&
        definition.network.egress !== "open"),
    {
      message:
        "Open egress has nothing to widen: setup.network needs the Environment's network to be gateway or allowlist",
      path: ["setup", "network"],
    },
  )
  .refine(
    (definition) =>
      !definition.setup?.network ||
      Object.keys(definition.volumes ?? {}).length === 0,
    {
      message:
        "A volume would carry what agents wrote into the next setup's wider network: an Environment whose setup has its own network keeps no volumes; declare read-only caches, which only a trusted fill writes, instead",
      path: ["volumes"],
    },
  )
  .superRefine((definition, ctx) => {
    const commands = definition.commands;
    if (!commands) return;
    if (!commands.separate && commands.agentResources)
      ctx.addIssue({
        code: "custom",
        path: ["commands", "agentResources"],
        message:
          "commands.agentResources limits the agent's own container, which exists only when commands run apart: set commands.separate",
      });
    if (!commands.separate && commands.connections?.length)
      ctx.addIssue({
        code: "custom",
        path: ["commands", "connections"],
        message:
          "commands.connections names what commands reach when they run apart: set commands.separate",
      });
    for (const [index, alias] of (commands.connections ?? []).entries()) {
      const binding = definition.connections?.[alias];
      if (!binding)
        ctx.addIssue({
          code: "custom",
          path: ["commands", "connections", index],
          message: `'${alias}' is not one of this Environment's connections`,
        });
      else if (binding.model || binding.capabilities?.includes("model"))
        ctx.addIssue({
          code: "custom",
          path: ["commands", "connections", index],
          message: `'${alias}' is a model connection: the agent's model stays beside the agent, never with its commands`,
        });
    }
  })
  .refine(
    (definition) => {
      const paths = [
        ...Object.values(definition.volumes ?? {}).map((volume) =>
          typeof volume === "string" ? volume : volume.path,
        ),
        ...Object.values(definition.caches ?? {}).map((cache) => cache.path),
      ];
      return paths.every((path, index) =>
        paths.slice(index + 1).every((other) => !nested(path, other)),
      );
    },
    {
      message:
        "Volume and cache paths must not be the same directory or hold one another",
      path: ["caches"],
    },
  )
  .refine(
    (definition) =>
      !definition.setup?.secrets ||
      (definition.setup.network !== undefined &&
        definition.setup.secrets.every((name) =>
          definition.secrets?.includes(name),
        )),
    {
      message:
        "setup.secrets names secrets of the Environment's own secrets for a setup with its own network, which runs with no others",
      path: ["setup", "secrets"],
    },
  );

/** The Environment every project has unless its manifest declares others. */
export const DEFAULT_ENVIRONMENT = "default";

/** Minutes an idle chat keeps its workspace unless its Environment says otherwise. */
export const DEFAULT_IDLE_RELEASE_MINUTES = 30;

/** Minutes a workspace's setup may run unless its Environment says otherwise (ADR 0208). */
export const DEFAULT_SETUP_TIMEOUT_MINUTES = 30;

/** Minutes a workspace's checkout may run unless its Environment says otherwise (ADR 0353). */
export const DEFAULT_CHECKOUT_TIMEOUT_MINUTES = 15;

/**
 * What fetches a workspace's base when its Environment names no command
 * (ADR 0353): the commit and its whole tree, with no history before it.
 */
export const DEFAULT_CHECKOUT_COMMAND =
  'git fetch --quiet --no-tags --depth=1 work "$WORK_BASE" && git checkout --quiet --force --detach FETCH_HEAD';

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
  /** Minutes work may wait for a machine (ADR 0258); 0 by default. */
  waitMinutes?: number;
  connections?: Readonly<Record<string, EnvironmentConnectionBinding>>;
  requirements?: Omit<EnvironmentRequirements, "workload" | "topology"> & {
    containers?: boolean;
  };
  image?: EnvironmentImage;
  network?: EnvironmentNetworkPolicy;
  approvals?: { waitMinutes: number };
  /** Members' own chats here may carry their personal credentials (ADR 0184). */
  personalCredentials?: boolean;
  /** Project secrets this Environment's sandboxes receive (ADR 0206). */
  secrets?: readonly string[];
  /** How a new workspace fetches its base (ADR 0353). */
  checkout?: EnvironmentCheckout;
  /** Run in every new workspace's project folder (ADRs 0208, 0257). */
  setup?: EnvironmentSetup;
  /** Directories kept on the machine for each owner (ADR 0208). */
  volumes?: Readonly<Record<string, EnvironmentVolume>>;
  /** Read-only directories only a trusted fill writes (ADR 0334). */
  caches?: Readonly<Record<string, EnvironmentCache>>;
  /**
   * The agent's commands run apart from the agent (ADR 0332), reaching
   * through the gateway only the bindings `connections` lists.
   */
  commands?: EnvironmentCommands;
}

/** One cache an Environment declares (ADR 0334). */
export interface EnvironmentCache {
  path: string;
  /** The largest a fill may leave it; {@link DEFAULT_CACHE_SIZE_MB} by default. */
  sizeMb?: number;
  fill: { command: string; timeoutMinutes?: number };
}

/** How an Environment runs an agent's commands (ADR 0332). */
export interface EnvironmentCommands {
  separate: boolean;
  /** Bindings of the Environment commands may reach; none by default. */
  connections?: readonly string[];
  /** The agent container's own limits; 1 CPU and 2 GiB by default. */
  agentResources?: { cpuMillis?: number; memoryMb?: number };
}

/**
 * How an Environment's workspaces get the commit they stand on (ADR
 * 0353). Work makes the checkout a Git repository with a remote named
 * `work`, which serves that commit and its tree and nothing else, and runs
 * `command` there with `WORK_BASE` naming the commit, before any setup and
 * before the workspace holds anything of a session's. When the command
 * ends, HEAD must be that commit; how much of it arrived (every file, a
 * sparse cone, no blobs until they are read) is the command's to say.
 * Without one, {@link DEFAULT_CHECKOUT_COMMAND} fetches it whole.
 */
export interface EnvironmentCheckout {
  command: string;
  timeoutMinutes?: number;
}

/**
 * An Environment's workspace setup (ADR 0208): a shell command run in the
 * project folder of every new workspace, again when it changes or the
 * workspace's base moves, within `timeoutMinutes`. After it, the runs of
 * the workspace's setup event (project workflows bound to
 * `session.workspace-setup`, ADR 0355) have the same time. With `network`
 * (ADR 0257) it reaches only those hosts while it runs, in a sandbox
 * holding the base checkout alone, with only the `secrets` it names.
 */
export interface EnvironmentSetup {
  command?: string;
  timeoutMinutes?: number;
  network?: { allow: readonly string[] };
  /** The Environment's secrets a setup with its own network runs with. */
  secrets?: readonly string[];
}

/** One volume an Environment declares (ADR 0208). */
export interface EnvironmentVolume {
  path: string;
  exclusive?: boolean;
  sizeMb?: number;
}

/** A secret `project.json` declares for Environments (ADR 0206). */
export interface ProjectSecretDeclaration {
  label?: string;
  description?: string;
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
  /** Secrets `project.json` declares for Environments (ADR 0206). */
  secrets: Readonly<Record<string, ProjectSecretDeclaration>>;
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
    secrets: {},
  };
}

export function parseProjectEnvironmentPolicy(
  raw: unknown,
): ProjectEnvironmentPolicy {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    return {
      environments: {},
      entries: [],
      secrets: {},
      invalid: { error: "Project manifest must be a JSON object" },
    };
  }
  const manifest = raw as Record<string, unknown>;
  const declared = ProjectSecretDeclarationsSchema.safeParse(
    manifest.secrets ?? {},
  );
  if (!declared.success) {
    const issue = declared.error.issues[0];
    return {
      environments: {},
      entries: [],
      secrets: {},
      invalid: {
        error: `secrets${issue?.path.length ? `.${issue.path.join(".")}` : ""}: ${issue?.message ?? "invalid"}`,
      },
    };
  }
  const secrets = declared.data;
  const rawEnvironments = manifest.environments;
  if (rawEnvironments === undefined) {
    return { ...defaultEnvironmentPolicy(), secrets };
  }
  if (
    typeof rawEnvironments !== "object" ||
    rawEnvironments === null ||
    Array.isArray(rawEnvironments)
  ) {
    return {
      environments: {},
      entries: [],
      secrets,
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
      const { image, volumes, ...rest } = parsed.data;
      const definition: ProjectEnvironmentDefinition = {
        ...rest,
        ...(image ? { image: environmentImage(image) } : {}),
        ...(volumes
          ? {
              volumes: Object.fromEntries(
                Object.entries(volumes).map(([name, volume]) => [
                  name,
                  typeof volume === "string" ? { path: volume } : volume,
                ]),
              ),
            }
          : {}),
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
      secrets,
      invalid: {
        error: "defaultEnvironment must name a valid declared Environment",
      },
    };
  }
  return {
    environments,
    entries,
    secrets,
    ...(typeof defaultEnvironment === "string" ? { defaultEnvironment } : {}),
  };
}

/** The Environment policy a manifest declares, or why it is invalid. */
function parsePolicyContent(content: string | null): ProjectEnvironmentPolicy {
  if (!content) {
    return defaultEnvironmentPolicy();
  }
  try {
    return parseProjectEnvironmentPolicy(JSON.parse(content));
  } catch (cause) {
    return {
      environments: {},
      entries: [],
      secrets: {},
      invalid: {
        error: `Project manifest is not valid JSON: ${
          cause instanceof Error ? cause.message : String(cause)
        }`,
      },
    };
  }
}

export class ProjectEnvironmentsService {
  constructor(
    private readonly db: Kysely<DB>,
    private readonly projectManager: ProjectManager,
  ) {}

  async list(args: {
    identity: Identity;
    projectId: string;
    /**
     * Read the program at this published commit instead of the newest
     * `main`: a cache fill builds its sandbox from the revision that went
     * live (ADR 0334).
     */
    commit?: string;
  }): Promise<ProjectEnvironmentPolicy> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    if (args.commit !== undefined)
      return parsePolicyContent(
        await this.readAtCommit({
          ...args,
          commit: args.commit,
          path: PROJECT_MANIFEST_PATH,
        }),
      );
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
    return parsePolicyContent(content);
  }

  /** A program file at one commit of the published program. */
  private async readAtCommit(args: {
    identity: Identity;
    projectId: string;
    commit: string;
    path: string;
  }): Promise<string | null> {
    const repo = await this.projectManager.openPublished({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
    });
    try {
      return await readProgramFile(repo, args.commit, args.path);
    } finally {
      await repo.dispose();
    }
  }

  async get(args: {
    identity: Identity;
    projectId: string;
    name: string;
    /** As for {@link list}. */
    commit?: string;
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
    /** As for {@link list}: the Dockerfile of that same commit. */
    commit?: string;
  }): Promise<string | null> {
    await requireTenantProject(this.db, args.identity.tenantId, args.projectId);
    if (args.commit !== undefined)
      return this.readAtCommit({ ...args, commit: args.commit });
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
