import { Buffer } from "node:buffer";
import type { DB } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import {
  type AgentCapabilityGateway,
  CapabilityPageSchema,
  DiscoverCapabilitiesSchema,
  extraToolResult,
  InvokeCapabilitySchema,
  type TurnContextFragment,
} from "@catamorphic/sandbox";
import type { Kysely } from "kysely";
import { z } from "zod";
import {
  hasControlPlanePermission,
  type Identity,
  identityMayUseConnection,
  identityMayUseEnvironment,
  intersectProjectPermissions,
  intersectScope,
} from "../identity.js";
import { requireRuntimeSession } from "./agent-runtime-events-service.js";
import { AccessDeniedError } from "./artifact-scope.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import type { ExecutionEnvironmentsService } from "./execution-environments-service.js";

const tracer = getTracer("@catamorphic/core");
const empty = z.object({}).strict();
const json = z.json();
const ResourceSchema = z.object({
  cpuMillis: z.number().optional(),
  memoryMb: z.number().optional(),
  storageMb: z.number().optional(),
  gpu: z.boolean().optional(),
  timeoutSeconds: z.number().optional(),
  maxConcurrency: z.number().optional(),
});
const AssignmentSchema = z.object({
  allocationId: z.string(),
  environment: z.string(),
  bindingId: z.string(),
  workerNodeId: z.string().nullable(),
  status: z.enum(["active", "released"]),
  resources: ResourceSchema,
});
const EnvironmentPageSchema = z.object({
  nextCursor: z.string().optional(),
  items: z.array(
    z.object({
      name: z.string(),
      label: z.string(),
      description: z.string().optional(),
      available: z.boolean(),
      compatible: z.boolean(),
      preferred: z.boolean(),
      allowed: z.boolean(),
      reasons: z.array(z.string()),
      binding: z
        .object({
          trust: z.enum(["local", "managed"]),
          isolation: z.enum(["none", "process", "sandbox"]),
          capabilities: z.array(z.string()),
          resources: ResourceSchema,
        })
        .optional(),
    }),
  ),
});

const RoleSummarySchema = z.object({
  name: z.string().max(200),
  description: z.string().max(1000).optional(),
});

const ContextSchema = z.object({
  observedAt: z.string(),
  currentUser: z.object({
    id: z.string(),
    displayName: z.string().optional(),
    timeZone: z.string().optional(),
    /** `full`: the host's unscoped identity. `member`: access through roles. */
    access: z.enum(["full", "member"]),
    /** The member's roles, described so the agent knows who it serves. */
    roles: z.array(RoleSummarySchema),
  }),
  project: z.object({ id: z.string(), name: z.string() }),
  sessionId: z.string(),
  allocationId: z.string(),
  environment: z.string(),
  agentLoopHost: z.string().nullable(),
  execution: z.object({
    bindingId: z.string(),
    workerNodeId: z.string().nullable(),
    commandTarget: z.enum(["host_checkout", "environment_sandbox"]),
    workingDirectory: z.string().nullable(),
    isolation: z.enum(["none", "process", "sandbox"]),
    declaredCapabilities: z.array(z.string()),
    harnessSandbox: z.literal("provider_configured"),
    workspaceLifetime: z.literal("session_managed"),
  }),
});

export interface AgentCapabilityContext {
  identity: Identity;
  projectId: string;
  sessionId: string;
  allocationId: string;
}
export interface AgentCapabilityInvocation extends AgentCapabilityContext {
  requestId: string;
  signal?: AbortSignal;
  progress(value: {
    message: string;
    current?: number;
    total?: number;
  }): Promise<void>;
}
export interface AgentCapability {
  name: string;
  /** Host-local version of execution semantics. Never sent to agents. */
  revision: string;
  /** Version of required consent. Omit when the operation needs no approval. */
  consent?: string;
  description: string;
  effect: "read" | "write";
  inputSchema: z.ZodType;
  outputSchema: z.ZodType;
  authorize(context: AgentCapabilityContext): boolean | Promise<boolean>;
  /** Validate once, retaining the typed input for approval and execution. */
  prepare(input: unknown): {
    input: unknown;
    beforeInvoke?(context: AgentCapabilityInvocation): Promise<void>;
    execute(context: AgentCapabilityInvocation): Promise<unknown>;
  };
}
/** Typed authoring; the registry erases types only after schema validation. */
export function defineAgentCapability<
  I extends z.ZodType,
  O extends z.ZodType,
>(args: {
  name: string;
  revision: string;
  /** Version of required consent. Omit when the operation needs no approval. */
  consent?: string;
  description: string;
  effect: "read" | "write";
  inputSchema: I;
  outputSchema: O;
  authorize(context: AgentCapabilityContext): boolean | Promise<boolean>;
  beforeInvoke?(
    context: AgentCapabilityInvocation,
    input: z.output<I>,
  ): Promise<void>;
  execute(
    context: AgentCapabilityInvocation,
    input: z.output<I>,
  ): Promise<z.input<O>>;
}): AgentCapability {
  const { execute, beforeInvoke, ...definition } = args;
  return {
    ...definition,
    prepare: (input) => {
      const value = args.inputSchema.parse(input);
      return {
        input: value,
        ...(beforeInvoke
          ? {
              beforeInvoke: (context: AgentCapabilityInvocation) =>
                beforeInvoke(context, value),
            }
          : {}),
        execute: (context) => execute(context, value),
      };
    },
  };
}
/** Live, session-specific entries in the same registry as static capabilities. */
export type AgentCapabilitySource = (
  context: AgentCapabilityContext,
  selection: { query?: string; name?: string },
) => readonly AgentCapability[] | Promise<readonly AgentCapability[]>;

export interface AgentCapabilityOptions {
  /** Each capability supplies ordinary live host authorization. Duplicate names fail boot. */
  capabilities?: readonly AgentCapability[];
  sources?: readonly AgentCapabilitySource[];
  /** Optional host profile; no email, groups, tokens, or directory inferred by core. */
  currentUser?(context: AgentCapabilityContext): Promise<{
    displayName?: string;
    timeZone?: string;
    /** Hosts with their own entitlements describe the caller's roles here. */
    roles?: Array<{ name: string; description?: string }>;
  }>;
  /** Host approval/interception. Throw to reject; returning completes any required approval. */
  beforeInvoke?(
    context: AgentCapabilityInvocation & {
      capability: string;
      effect: "read" | "write";
      input: unknown;
    },
  ): Promise<void>;
  onEvent?(
    event: AgentCapabilityContext & {
      capability: string;
      requestId: string;
      type: "started" | "completed" | "failed" | "progress";
      progress?: { message: string; current?: number; total?: number };
    },
  ): void | Promise<void>;
}

export class AgentCapabilitiesService {
  private readonly registry = new Map<string, AgentCapability>();
  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      hostId?: string;
      resolveMemberIdentity?: (args: {
        tenantId: string;
        projectId: string;
        externalUserId: string;
      }) => Promise<Identity | null>;
      allocations: ExecutionAllocationsService;
      environments: ExecutionEnvironmentsService;
      options?: AgentCapabilityOptions;
      /** The stock membership's described roles; `null` for non-members. */
      memberRoles?: (args: {
        tenantId: string;
        projectId: string;
        externalUserId: string;
      }) => Promise<Array<{ name: string; description?: string }> | null>;
    },
  ) {
    for (const capability of [
      ...this.builtins(),
      ...(deps.options?.capabilities ?? []),
    ]) {
      if (
        !capability.revision ||
        !/^[a-z][a-z0-9_.]{0,119}$/.test(capability.name) ||
        this.registry.has(capability.name)
      )
        throw new Error(
          `Invalid or duplicate agent capability: ${capability.name}`,
        );
      // Reject schemas that cannot be transported at boot, not during a model call.
      z.toJSONSchema(capability.inputSchema);
      z.toJSONSchema(capability.outputSchema);
      this.registry.set(capability.name, capability);
    }
  }

  forSession(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    allocationId?: string;
  }): AgentCapabilityGateway {
    return {
      discover: async (input) => {
        const { query, cursor, limit } =
          DiscoverCapabilitiesSchema.parse(input);
        const context = await this.context(args);
        const words = query.toLowerCase().split(/\s+/).filter(Boolean);
        const matching = [...(await this.resolve(context, { query })).values()]
          .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
          .filter(
            (item) =>
              (!cursor || item.name > cursor) &&
              words.every((word) =>
                `${item.name} ${item.description}`.toLowerCase().includes(word),
              ),
          );
        const visible: AgentCapability[] = [];
        for (const item of matching) {
          if (await item.authorize(context)) visible.push(item);
          if (visible.length > limit) break;
        }
        return CapabilityPageSchema.parse({
          items: visible.slice(0, limit).map((item) => ({
            name: item.name,
            description: item.description,
            effect: item.effect,
            inputSchema: z.toJSONSchema(item.inputSchema),
            outputSchema: z.toJSONSchema(item.outputSchema),
          })),
          ...(visible.length > limit
            ? { nextCursor: visible[limit - 1]?.name }
            : {}),
        });
      },
      invoke: async (input) => {
        const command = InvokeCapabilitySchema.parse(input);
        let context = await this.context(args);
        const capability = (
          await this.resolve(context, { name: command.name })
        ).get(command.name);
        if (!capability || !(await capability.authorize(context)))
          throw new AccessDeniedError();
        const prepared = capability.prepare(command.input);
        const approvalDefinition = (entry: AgentCapability) =>
          JSON.stringify({
            revision: entry.revision,
            effect: entry.effect,
            inputSchema: z.toJSONSchema(entry.inputSchema),
            outputSchema: z.toJSONSchema(entry.outputSchema),
          });
        const approvedDefinition = approvalDefinition(capability);
        const approvedConsent = capability.consent;
        const event = async (
          type: "started" | "completed" | "failed" | "progress",
          progress?: { message: string; current?: number; total?: number },
        ) => {
          // Observers cannot change the outcome of an already executed operation.
          try {
            await this.deps.options?.onEvent?.({
              ...context,
              capability: command.name,
              requestId: command.requestId,
              type,
              progress,
            });
          } catch {
            /* host telemetry is best effort */
          }
        };
        const invocation = (): AgentCapabilityInvocation => ({
          ...context,
          requestId: command.requestId,
          signal: input.signal,
          progress: (value) => event("progress", value),
        });
        return withSpan(
          {
            tracer,
            name: "agent.capability.invoke",
            attributes: {
              "catamorphic.capability.name": command.name,
              "catamorphic.agent.session.id": args.sessionId,
              "catamorphic.tenant.id": context.identity.tenantId,
              "catamorphic.project.id": context.projectId,
              "user.id": context.identity.externalUserId,
            },
          },
          async () => {
            input.signal?.throwIfAborted();
            await this.deps.options?.beforeInvoke?.({
              ...invocation(),
              capability: command.name,
              effect: capability.effect,
              input: prepared.input,
            });
            await prepared.beforeInvoke?.(invocation());
            await event("started");
            try {
              // Activity sinks may await IO too. Recheck after every host hook
              // before handing control to the capability's owning service.
              context = await this.context({
                ...args,
                allocationId: context.allocationId,
              });
              const current = (
                await this.resolve(context, { name: command.name })
              ).get(command.name);
              if (!current || !(await current.authorize(context)))
                throw new AccessDeniedError();
              input.signal?.throwIfAborted();
              if (
                approvalDefinition(current) !== approvedDefinition ||
                (current.consent !== undefined &&
                  current.consent !== approvedConsent)
              )
                throw new Error(
                  "Capability definition or consent policy changed during approval; discover it again and retry",
                );
              const execution =
                current === capability
                  ? prepared
                  : current.prepare(command.input);
              if (
                JSON.stringify(execution.input) !==
                JSON.stringify(prepared.input)
              )
                throw new Error(
                  "Capability input changed during approval; discover its current schema and retry",
                );
              const result = current.outputSchema.parse(
                await execution.execute(invocation()),
              );
              // JSON is the contract across in-process and remote transports alike.
              const wire = json.parse(result);
              const media =
                typeof wire === "object" &&
                wire !== null &&
                !Array.isArray(wire) &&
                wire.kind === "agent-tool-result";
              if (media) extraToolResult(wire); // Validate the explicit media envelope.
              const limit = (media ? 8 : 1) * 1024 * 1024;
              if (Buffer.byteLength(JSON.stringify(wire), "utf8") > limit)
                throw new Error(
                  `Capability result exceeds ${media ? 8 : 1} MiB; use a bounded query or resource reference`,
                );
              await event("completed");
              return wire;
            } catch (error) {
              await event("failed");
              throw error;
            }
          },
        );
      },
    };
  }

  private async resolve(
    context: AgentCapabilityContext,
    selection: { query?: string; name?: string },
  ): Promise<Map<string, AgentCapability>> {
    const entries = new Map(this.registry);
    for (const source of this.deps.options?.sources ?? []) {
      for (const entry of await source(context, selection)) {
        if (
          !entry.revision ||
          !/^[a-z][a-zA-Z0-9_.:%-]{0,199}$/.test(entry.name) ||
          entries.has(entry.name)
        )
          throw new Error(
            `Invalid or duplicate agent capability: ${entry.name}`,
          );
        entries.set(entry.name, entry);
      }
    }
    return entries;
  }

  private async context(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    allocationId?: string;
  }): Promise<AgentCapabilityContext> {
    const check = async (identity: Identity) => {
      const { projectId } = await requireRuntimeSession({
        db: this.deps.db,
        identity,
        sessionId: args.sessionId,
        lock: false,
        intent: "read",
      });
      if (projectId !== args.projectId) throw new AccessDeniedError();
      const session = await this.deps.db
        .selectFrom("agent_sessions")
        .select(["allocation_id", "status"])
        .where("id", "=", args.sessionId)
        .executeTakeFirstOrThrow();
      if (session.status !== "active" || !session.allocation_id)
        throw new AccessDeniedError();
      const allocation = await this.deps.allocations.get({
        identity,
        allocationId: session.allocation_id,
      });
      if (
        allocation?.status !== "active" ||
        allocation.projectId !== projectId ||
        (args.allocationId !== undefined && allocation.id !== args.allocationId)
      )
        throw new AccessDeniedError();
      return {
        identity,
        projectId,
        sessionId: args.sessionId,
        allocationId: allocation.id,
      };
    };
    const original = await check(args.identity);
    // An absent artifact scope is the host's explicit root identity (ADR 0055).
    // Membership resolution can only refresh identities issued as members.
    if (args.identity.scope === undefined || !this.deps.resolveMemberIdentity)
      return original;
    const identity = await this.deps.resolveMemberIdentity({
      tenantId: args.identity.tenantId,
      projectId: args.projectId,
      externalUserId: args.identity.externalUserId,
    });
    if (
      !identity ||
      identity.tenantId !== args.identity.tenantId ||
      identity.externalUserId !== args.identity.externalUserId
    )
      throw new AccessDeniedError();
    // Refresh may revoke a grant, but cannot expand a caller's narrowed token.
    return check({
      ...args.identity,
      scope: intersectScope(args.identity.scope, identity),
      executionScope: (args.identity.executionScope ?? []).filter((ref) =>
        identityMayUseEnvironment(identity, ref.projectId, ref.name),
      ),
      connectionScope: (args.identity.connectionScope ?? []).flatMap((ref) => {
        const current = identityMayUseConnection(
          identity,
          ref.projectId,
          ref.environment,
          ref.alias,
        );
        if (!current) return [];
        return [
          {
            ...ref,
            capabilities:
              ref.capabilities === undefined
                ? current.capabilities
                : ref.capabilities.filter(
                    (capability) =>
                      current.capabilities === undefined ||
                      current.capabilities.includes(capability),
                  ),
          },
        ];
      }),
      projectPermissions: intersectProjectPermissions(
        args.identity.projectPermissions ?? [],
        identity,
      ),
      controlPlanePermissions: (
        args.identity.controlPlanePermissions ?? []
      ).filter((permission) => hasControlPlanePermission(identity, permission)),
    });
  }

  async snapshot(args: {
    identity: Identity;
    projectId: string;
    sessionId: string;
    workingDirectory?: string;
    agentLoopHost?: string;
    allocationId?: string;
  }) {
    const context = await this.context(args);
    const allocation = await this.deps.allocations.get(context);
    if (!allocation) throw new AccessDeniedError();
    const profile = z
      .object({
        displayName: z.string().max(200).optional(),
        timeZone: z.string().max(100).optional(),
        roles: z.array(RoleSummarySchema).max(20).optional(),
      })
      .parse((await this.deps.options?.currentUser?.(context)) ?? {});
    const access = context.identity.scope === undefined ? "full" : "member";
    const roles =
      profile.roles ??
      (await this.deps.memberRoles?.({
        tenantId: context.identity.tenantId,
        projectId: context.projectId,
        externalUserId: context.identity.externalUserId,
      })) ??
      [];
    const project = await this.deps.db
      .selectFrom("projects")
      .select("name")
      .where("id", "=", context.projectId)
      .where("tenant_id", "=", context.identity.tenantId)
      .executeTakeFirstOrThrow();
    const workerNodeId = allocation.workerNodeId;
    // Never probe another worker just to render the model's basic context.
    return ContextSchema.parse({
      observedAt: new Date().toISOString(),
      currentUser: {
        id: context.identity.externalUserId,
        ...(profile.displayName ? { displayName: profile.displayName } : {}),
        ...(profile.timeZone ? { timeZone: profile.timeZone } : {}),
        access,
        roles: roles.slice(0, 20),
      },
      project: { id: context.projectId, name: project.name.slice(0, 200) },
      sessionId: context.sessionId,
      allocationId: context.allocationId,
      environment: allocation.environmentName,
      agentLoopHost: args.agentLoopHost ?? null,
      execution: {
        bindingId: allocation.bindingId,
        workerNodeId,
        commandTarget:
          allocation.policy.requirements.topology === "native"
            ? "host_checkout"
            : "environment_sandbox",
        workingDirectory: args.workingDirectory ?? null,
        isolation: allocation.policy.binding.isolation,
        declaredCapabilities: allocation.policy.binding.capabilities.slice(
          0,
          20,
        ),
        harnessSandbox: "provider_configured",
        workspaceLifetime: "session_managed",
      },
    });
  }
  /**
   * The session fragment of each turn's context (ADR 0152): who the agent is
   * working with, their access, the project, and where commands run, in
   * plain words. Infrastructure identifiers stay behind `context.read`.
   */
  async prompt(
    args: Parameters<AgentCapabilitiesService["snapshot"]>[0],
  ): Promise<TurnContextFragment> {
    return {
      source: "session",
      trust: "host",
      text: formatSessionContext(
        await this.snapshot({ ...args, agentLoopHost: this.deps.hostId }),
      ),
    };
  }

  private builtins(): AgentCapability[] {
    return [
      defineAgentCapability({
        revision: "1",
        name: "context.read",
        description:
          "Read the current user, their roles, the project, the session, and where commands run, including execution identifiers.",
        effect: "read",
        inputSchema: empty,
        outputSchema: ContextSchema,
        authorize: () => true,
        execute: (context) => this.snapshot(context),
      }),
      defineAgentCapability({
        revision: "1",
        name: "environments.list",
        description:
          "List project environments this caller is permitted to use for agents. Availability does not reserve a machine.",
        effect: "read",
        inputSchema: DiscoverCapabilitiesSchema.pick({
          cursor: true,
          limit: true,
        }),
        outputSchema: EnvironmentPageSchema,
        authorize: () => true,
        execute: async (context, input) => {
          const result = await this.deps.environments.discover({
            ...context,
            requirements: { workload: "agent" },
          });
          const visible = result.items
            .filter(
              (item) =>
                item.allowed && (!input.cursor || item.name > input.cursor),
            )
            .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
          return EnvironmentPageSchema.parse({
            items: visible.slice(0, input.limit),
            ...(visible.length > input.limit
              ? { nextCursor: visible[input.limit - 1]?.name }
              : {}),
          });
        },
      }),
      defineAgentCapability({
        revision: "1",
        name: "assignments.current",
        description:
          "Inspect this session's pinned environment assignment and resource reservation. Does not list other users' machines or grant execution authority.",
        effect: "read",
        inputSchema: empty,
        outputSchema: AssignmentSchema,
        authorize: () => true,
        execute: async (context) => {
          const allocation = await this.deps.allocations.get(context);
          if (!allocation) throw new AccessDeniedError();
          return {
            allocationId: allocation.id,
            environment: allocation.environmentName,
            bindingId: allocation.bindingId,
            workerNodeId: allocation.workerNodeId,
            status: allocation.status,
            resources: allocation.policy.requirements.resources ?? {},
          };
        },
      }),
    ];
  }
}

/** Model-facing rendering of a context snapshot: plain facts, no ids. */
export function formatSessionContext(
  snapshot: z.output<typeof ContextSchema>,
): string {
  const user = snapshot.currentUser;
  const lines = [
    `Person: ${user.displayName ?? user.id}${
      user.timeZone ? ` (time zone ${user.timeZone})` : ""
    }`,
  ];
  lines.push(
    user.access === "full"
      ? "Access: full access to this project."
      : "Access: what their roles allow.",
  );
  if (user.roles.length > 0) {
    lines.push(
      `Role${user.roles.length > 1 ? "s" : ""} in this project (let these shape what you say and how):`,
      ...user.roles.map((role) =>
        role.description
          ? `- ${role.name}: ${role.description.replace(/\s+/g, " ").trim()}`
          : `- ${role.name}`,
      ),
    );
  }
  lines.push(`Project: ${snapshot.project.name}`);
  const where = snapshot.execution.workingDirectory
    ? ` at ${snapshot.execution.workingDirectory}`
    : "";
  lines.push(
    snapshot.execution.commandTarget === "host_checkout"
      ? `Commands and file edits run directly in the project folder${where}.`
      : `Commands and file edits run in an isolated sandbox copy of the project${where}; localhost there is the sandbox, not the person's computer.`,
  );
  lines.push(`Now: ${snapshot.observedAt}`);
  return lines.join("\n");
}
