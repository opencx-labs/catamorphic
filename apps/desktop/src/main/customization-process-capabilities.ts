import {
  type AgentCapability,
  type CapabilityProviderRuntime,
  defineAgentCapability,
  type HostCallContext,
  hasProjectPermission,
  type Identity,
  permissionCovers,
} from "@catamorphic/core";
import { z } from "zod";
import {
  type CustomizationProcesses,
  type CustomizationProcessOwner,
  customizationProcessReadSchema,
  customizationProcessStartSchema,
  customizationProcessStopSchema,
} from "./customization-processes.js";

const source = z.object({ sourcePath: z.string().min(1).max(4096) });
const start = customizationProcessStartSchema.extend({
  sourcePath: source.shape.sourcePath,
  // An agent or workflow has no source-view lease. Temporary commands already
  // belong to its ordinary terminal or execution sandbox.
  lifetime: z.literal("application"),
});
const read = customizationProcessReadSchema.extend({
  sourcePath: source.shape.sourcePath,
});
const stop = customizationProcessStopSchema.extend({
  sourcePath: source.shape.sourcePath,
});
const callSchema = z.discriminatedUnion("action", [
  start.extend({ action: z.literal("start") }),
  source.extend({ action: z.literal("list") }),
  read.extend({ action: z.literal("read") }),
  stop.extend({ action: z.literal("stop") }),
]);
type ProcessCall = z.infer<typeof callSchema>;

/** One authorized dispatcher for native agents and ordinary workflow host calls. */
export function customizationProcessCapabilities(input: {
  member: { tenantId: string; externalUserId: string };
  manager: () => Pick<
    CustomizationProcesses,
    "start" | "list" | "read" | "stop"
  >;
  owner: (input: {
    projectId: string;
    sourcePath: string;
  }) => Promise<CustomizationProcessOwner>;
  /** Read the declaration pinned to this actual run, even for an unscoped member. */
  declaredPermissions: (input: {
    identity: Identity;
    projectId: string;
    runId: string;
    workflowName: string;
  }) => Promise<readonly string[]>;
  authorizeWorkflow: (context: HostCallContext) => Promise<Identity>;
}): { provider: CapabilityProviderRuntime; agents: AgentCapability[] } {
  const permission = (action: ProcessCall["action"]) =>
    `work.processes:${action === "read" || action === "list" ? "read" : "write"}`;
  const allowed = (identity: Identity, projectId: string, wanted: string) =>
    identity.tenantId === input.member.tenantId &&
    identity.externalUserId === input.member.externalUserId &&
    hasProjectPermission(identity, projectId, wanted);
  const dispatch = async (
    identity: Identity,
    projectId: string,
    call: ProcessCall,
    beforeEffect?: () => Promise<void>,
  ) => {
    if (!allowed(identity, projectId, permission(call.action)))
      throw new Error("This caller cannot control Work's background services.");
    const owner = await input.owner({ projectId, sourcePath: call.sourcePath });
    if (owner.projectId !== projectId)
      throw new Error("A process belongs to its calling project.");
    const manager = input.manager();
    await beforeEffect?.();
    if (call.action === "start")
      return manager.start(owner, call, beforeEffect);
    if (call.action === "list") return manager.list(owner, beforeEffect);
    if (call.action === "read") return manager.read(owner, call, beforeEffect);
    return manager.stop(owner, call, beforeEffect);
  };
  const provider: CapabilityProviderRuntime = {
    name: "work.processes",
    calls: {},
  };
  provider.calls = Object.fromEntries(
    (["start", "list", "read", "stop"] as const).map((action) => [
      action,
      async (context: HostCallContext, raw: unknown) => {
        context.signal.throwIfAborted();
        const call = callSchema.parse({
          ...z.record(z.string(), z.unknown()).parse(raw),
          action,
        });
        const wanted = permission(action);
        if (!allowed(context.caller, context.projectId, wanted))
          throw new Error(
            "This workflow cannot control Work's background services.",
          );
        const declared = await input.declaredPermissions({
          identity: context.caller,
          projectId: context.projectId,
          runId: context.runId,
          workflowName: context.workflowName,
        });
        if (!declared.some((held) => permissionCovers(held, wanted)))
          throw new Error(`This workflow must declare ${wanted}.`);
        context.signal.throwIfAborted();
        const beforeEffect = async () => {
          context.signal.throwIfAborted();
          const live = await input.authorizeWorkflow(context);
          if (!allowed(live, context.projectId, wanted))
            throw new Error(
              "This workflow's current process authority was revoked.",
            );
          context.signal.throwIfAborted();
        };
        return dispatch(context.caller, context.projectId, call, beforeEffect);
      },
    ]),
  );
  return {
    provider,
    agents: [
      defineAgentCapability({
        name: "work.processes.read",
        revision: "1",
        effect: "read",
        description:
          "List or read this member's approved package services, independent of the creating chat. sourcePath selects an entry in the package; keys belong to that canonical package. Output uses byte cursors.",
        inputSchema: z.discriminatedUnion("action", [
          source.extend({ action: z.literal("list") }),
          read.extend({ action: z.literal("read") }),
        ]),
        outputSchema: z.unknown(),
        authorize: ({ identity, projectId }) =>
          allowed(identity, projectId, "work.processes:read"),
        execute: (context, call) =>
          dispatch(context.identity, context.projectId, call),
      }),
      defineAgentCapability({
        name: "work.processes.write",
        revision: "1",
        effect: "write",
        description:
          "Start or stop a confined application service for an already approved package. It keeps running after Work quits and restarts after exit or engine transfer until stopped. This cannot approve package access, inherit credentials, or select another member. sourcePath selects a project package entry.",
        inputSchema: z.discriminatedUnion("action", [
          start.extend({ action: z.literal("start") }),
          stop.extend({ action: z.literal("stop") }),
        ]),
        outputSchema: z.unknown(),
        authorize: ({ identity, projectId }) =>
          allowed(identity, projectId, "work.processes:write"),
        execute: (context, call) =>
          dispatch(context.identity, context.projectId, call),
      }),
    ],
  };
}
