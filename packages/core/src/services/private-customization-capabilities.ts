import { z } from "zod";
import { hasProjectPermission, type Identity } from "../identity.js";
import {
  type AgentCapability,
  defineAgentCapability,
} from "./agent-capabilities-service.js";
import type {
  CapabilityProviderRuntime,
  HostCallContext,
} from "./capability-providers.js";
import {
  PrivateStateDeleteSchema,
  PrivateStateReadSchema,
  PrivateStateSchema,
  type PrivateStateService,
  PrivateStateWriteSchema,
} from "./private-state-service.js";
import type { PrivateWorkflowsService } from "./private-workflows-service.js";
import type { SessionArtifactsService } from "./session-artifacts-service.js";
import {
  PublishNotificationSchema,
  type UserNotificationsService,
} from "./user-notifications-service.js";

interface Services {
  state(): PrivateStateService;
  workflows(): PrivateWorkflowsService;
  artifacts(): SessionArtifactsService;
  notifications(): UserNotificationsService;
  authorizeWorkflow(context: HostCallContext): Promise<Identity>;
}

/** The same authorized operations serve agents, workflows, HTTP and host sources. */
export function privateCustomizationHostCapabilities(
  services: Services,
): CapabilityProviderRuntime[] {
  return [
    {
      name: "catamorphic.privateState",
      calls: {
        read: async (context, args) =>
          services.state().read({
            identity: await services.authorizeWorkflow(context),
            projectId: context.projectId,
            ...PrivateStateReadSchema.parse(args),
          }),
        write: async (context, args) =>
          services.state().write({
            identity: await services.authorizeWorkflow(context),
            projectId: context.projectId,
            signal: context.signal,
            ...PrivateStateWriteSchema.parse(args),
          }),
        delete: async (context, args) =>
          services.state().delete({
            identity: await services.authorizeWorkflow(context),
            projectId: context.projectId,
            signal: context.signal,
            ...PrivateStateDeleteSchema.parse(args),
          }),
      },
    },
    {
      name: "catamorphic.notifications",
      calls: {
        publish: async (context, args) =>
          services.notifications().notify({
            identity: await services.authorizeWorkflow(context),
            projectId: context.projectId,
            signal: context.signal,
            ...PublishNotificationSchema.parse(args),
          }),
      },
    },
  ];
}

export function privateCustomizationAgentCapabilities(
  services: Services,
): AgentCapability[] {
  return [
    defineAgentCapability({
      name: "private.workflow",
      revision: "1",
      effect: "write",
      inputSchema: z.discriminatedUnion("action", [
        z.object({
          action: z.literal("create"),
          name: z.string().min(1).max(100),
          title: z.string().max(200).optional(),
          source: z.string().max(5 * 1024 * 1024),
          files: z.record(z.string(), z.string()).optional(),
        }),
        z.object({ action: z.literal("list") }),
        z.object({ action: z.literal("read"), artifactId: z.string().uuid() }),
        z.object({
          action: z.literal("update"),
          artifactId: z.string().uuid(),
          revision: z.number().int().positive(),
          files: z.record(z.string(), z.string().nullable()),
        }),
        z.object({
          action: z.literal("preview"),
          artifactId: z.string().uuid(),
          revision: z.number().int().positive(),
          environment: z.string().optional(),
        }),
        z.object({
          action: z.literal("activate"),
          artifactId: z.string().uuid(),
          revision: z.number().int().positive(),
          environment: z.string().optional(),
          consentDigest: z.string(),
        }),
        z.object({ action: z.literal("stop"), artifactId: z.string().uuid() }),
        z.object({
          action: z.literal("discard"),
          artifactId: z.string().uuid(),
        }),
        z.object({
          action: z.literal("run"),
          artifactId: z.string().uuid(),
          revision: z.number().int().positive(),
          environment: z.string().optional(),
          input: z.json().optional(),
        }),
      ]),
      outputSchema: z.unknown(),
      description:
        "Create, read, update, run or activate an ordinary private workflow owned by this member independently of this chat. Source stays outside project files and Git. Read/update use artifact revisions; preview returns the consent digest for activate. Updating source does not change the active pin until activation. Stop disables future triggers; discard retires the source. Uses the normal scheduler and workflow runs.",
      authorize: ({ identity, projectId }) =>
        identity.scope === undefined ||
        identity.scope.some(
          (ref) => ref.kind === "workflow" && ref.projectId === projectId,
        ),
      execute: async (context, input) => {
        const address = {
          identity: context.identity,
          projectId: context.projectId,
        };
        if (input.action === "create")
          return services.artifacts().create({
            ...address,
            ...input,
            lifetime: "member",
            kind: "workflow",
          });
        if (input.action === "list")
          return services.artifacts().list({ ...address, lifetime: "member" });
        const artifact = await services
          .artifacts()
          .get({ ...address, artifactId: input.artifactId });
        if (artifact.lifetime !== "member")
          throw new Error("This operation requires a member-owned workflow");
        switch (input.action) {
          case "read":
            return {
              artifact,
              files: await services
                .artifacts()
                .files({ ...address, artifactId: input.artifactId }),
            };
          case "update":
            return services.artifacts().update({ ...address, ...input });
          case "preview":
            return services.workflows().preview({ ...address, ...input });
          case "activate":
            return services.workflows().activate({ ...address, ...input });
          case "stop":
            return services
              .workflows()
              .stop({ ...address, ...input, signal: context.signal });
          case "run":
            return services.workflows().run({ ...address, ...input });
          case "discard":
            await services
              .workflows()
              .stop({ ...address, ...input, signal: context.signal });
            return services.artifacts().discard({ ...address, ...input });
        }
      },
    }),
    defineAgentCapability({
      name: "private.state.read",
      revision: "1",
      effect: "read",
      inputSchema: PrivateStateReadSchema,
      outputSchema: PrivateStateSchema,
      description:
        "Read this member's private JSON state and current version. State stays outside project files and sync. Missing state has value null and version 0; deletion preserves its version.",
      authorize: ({ identity, projectId }) =>
        hasProjectPermission(identity, projectId, "private-state:read"),
      execute: (context, input) =>
        services.state().read({
          identity: context.identity,
          projectId: context.projectId,
          ...input,
        }),
    }),
    defineAgentCapability({
      name: "private.state.write",
      revision: "1",
      effect: "write",
      inputSchema: PrivateStateWriteSchema,
      outputSchema: PrivateStateSchema,
      description:
        "Write this member's private JSON state using its read version as ifVersion. A stale version returns a conflict; reread before reconciling. No file lock or last-write-wins write.",
      authorize: ({ identity, projectId }) =>
        hasProjectPermission(identity, projectId, "private-state:write"),
      execute: (context, input) =>
        services.state().write({
          identity: context.identity,
          projectId: context.projectId,
          signal: context.signal,
          ...input,
        }),
    }),
    defineAgentCapability({
      name: "private.state.delete",
      revision: "1",
      effect: "write",
      inputSchema: PrivateStateDeleteSchema,
      outputSchema: z.object({ version: z.number().int() }),
      description:
        "Delete this member's private state at its current version, retaining its version history.",
      authorize: ({ identity, projectId }) =>
        hasProjectPermission(identity, projectId, "private-state:write"),
      execute: (context, input) =>
        services.state().delete({
          identity: context.identity,
          projectId: context.projectId,
          signal: context.signal,
          ...input,
        }),
    }),
    defineAgentCapability({
      name: "notifications.publish",
      revision: "1",
      effect: "write",
      inputSchema: PublishNotificationSchema,
      outputSchema: z.object({ published: z.literal(true) }),
      description:
        "Publish a durable notification to the calling member through this host's notification transports. An idempotencyKey deduplicates retries. No agent turn is required.",
      authorize: ({ identity, projectId }) =>
        hasProjectPermission(identity, projectId, "notifications:write"),
      execute: (context, input) =>
        services.notifications().notify({
          identity: context.identity,
          projectId: context.projectId,
          signal: context.signal,
          ...input,
        }),
    }),
  ];
}
