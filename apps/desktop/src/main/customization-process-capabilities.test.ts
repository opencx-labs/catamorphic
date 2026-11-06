import type {
  AgentCapabilityInvocation,
  HostCallContext,
} from "@catamorphic/core";
import { describe, expect, it, vi } from "vitest";
import { customizationProcessCapabilities } from "./customization-process-capabilities.js";
import type { CustomizationProcess } from "./customization-processes.js";

function fixture() {
  const process: CustomizationProcess = {
    key: "service",
    processId: "proc-test",
    sandboxId: "package",
    command: "bun service.ts",
    cwd: "/project",
    lifetime: "application",
    enabled: true,
    status: "running",
    exitCode: null,
    signal: null,
    startedAt: new Date().toISOString(),
    endedAt: null,
    outputBytes: 0,
  };
  const manager = {
    start: vi.fn(async () => process),
    list: vi.fn(async () => [process]),
    stop: vi.fn(async () => ({ ...process, status: "exited" as const })),
    read: vi.fn(async () => ({
      processId: process.processId,
      chunk: "ready",
      cursor: 0,
      nextCursor: 5,
      more: false,
      outputBytes: 5,
      status: "running" as const,
      exitCode: null,
      signal: null,
    })),
  };
  const owner = vi.fn(
    async ({ projectId }: { projectId: string; sourcePath: string }) => ({
      projectId,
      profileId: "profile",
      modulePath: "/project/package/source.ts",
    }),
  );
  const declaredPermissions = vi.fn(async (): Promise<readonly string[]> => []);
  const authorizeWorkflow = vi.fn(
    async (context: HostCallContext) => context.caller,
  );
  const capabilities = customizationProcessCapabilities({
    member: { tenantId: "tenant", externalUserId: "member" },
    manager: () => manager,
    owner,
    declaredPermissions,
    authorizeWorkflow,
  });
  const context: HostCallContext = {
    caller: { tenantId: "tenant", externalUserId: "member" },
    projectId: "project",
    runId: "run",
    workflowName: "reminder",
    signal: new AbortController().signal,
    deadlineAt: new Date(Date.now() + 30_000).toISOString(),
  };
  const invocation: AgentCapabilityInvocation = {
    identity: context.caller,
    projectId: context.projectId,
    sessionId: "chat",
    allocationId: "allocation",
    requestId: "request",
    progress: async () => {},
  };
  return {
    ...capabilities,
    manager,
    owner,
    declaredPermissions,
    context,
    invocation,
    authorizeWorkflow,
  };
}

describe("Work process capabilities", () => {
  it("checks current enablement and member permission after awaited package resolution", async () => {
    const {
      provider,
      owner,
      manager,
      context,
      declaredPermissions,
      authorizeWorkflow,
    } = fixture();
    const start = provider.calls?.start;
    if (!start) throw new Error("No process start provider.");
    const original = owner.getMockImplementation();
    if (!original) throw new Error("No host owner resolver.");
    let allow: (() => void) | undefined;
    const pendingOwner = new Promise<void>((resolve) => {
      allow = resolve;
    });
    owner.mockImplementationOnce(async (input) => {
      await pendingOwner;
      return original(input);
    });
    declaredPermissions.mockResolvedValue(["work.processes:write"]);
    const pending = start(context, {
      sourcePath: "package/source.ts",
      key: "service",
      command: "bun service.ts",
      lifetime: "application",
    });
    await vi.waitFor(() => expect(owner).toHaveBeenCalledOnce());
    authorizeWorkflow.mockRejectedValue(new Error("Enablement disabled"));
    allow?.();
    await expect(pending).rejects.toThrow("Enablement disabled");
    expect(manager.start).not.toHaveBeenCalled();
    authorizeWorkflow.mockResolvedValue({
      ...context.caller,
      scope: [],
      projectPermissions: [],
    });
    await expect(
      start(context, {
        sourcePath: "package/source.ts",
        key: "service",
        command: "bun service.ts",
        lifetime: "application",
      }),
    ).rejects.toThrow("authority was revoked");
    expect(manager.start).not.toHaveBeenCalled();
  });
  it("requires an explicit pinned workflow permission even for the root member", async () => {
    const { provider, manager, context, declaredPermissions } = fixture();
    const start = provider.calls?.start;
    if (!start) throw new Error("No process start provider.");
    const request = {
      sourcePath: "package/source.ts",
      key: "service",
      command: "bun service.ts",
      lifetime: "application",
    };
    await expect(start(context, request)).rejects.toThrow(
      "must declare work.processes:write",
    );
    expect(manager.start).not.toHaveBeenCalled();
    declaredPermissions.mockResolvedValue(["work.processes:write"]);
    await expect(start(context, request)).resolves.toMatchObject({
      key: "service",
    });
    expect(manager.start).toHaveBeenCalledWith(
      {
        profileId: "profile",
        projectId: "project",
        modulePath: "/project/package/source.ts",
      },
      expect.objectContaining(request),
      expect.any(Function),
    );
  });
  it("keeps workflow caller, project and package authority host-bound", async () => {
    const { provider, manager, context, declaredPermissions, owner } =
      fixture();
    const start = provider.calls?.start;
    if (!start) throw new Error("No process start provider.");
    declaredPermissions.mockResolvedValue(["work.processes:write"]);
    const request = {
      sourcePath: "package/source.ts",
      key: "service",
      command: "bun service.ts",
      lifetime: "application",
      projectId: "other-project",
      profileId: "other-profile",
      owner: { externalUserId: "another-member" },
    };
    await expect(
      start(
        {
          ...context,
          caller: { ...context.caller, externalUserId: "another-member" },
        },
        request,
      ),
    ).rejects.toThrow("cannot control");
    expect(manager.start).not.toHaveBeenCalled();
    await start(context, request);
    expect(owner).toHaveBeenCalledWith({
      projectId: "project",
      sourcePath: "package/source.ts",
    });
    await expect(
      start(context, { ...request, lifetime: "view" }),
    ).rejects.toThrow();
  });
  it("lets native discovery read and stop through the same manager and denies other members", async () => {
    const { agents, manager, invocation } = fixture();
    const read = agents.find(
      (capability) => capability.name === "work.processes.read",
    );
    const write = agents.find(
      (capability) => capability.name === "work.processes.write",
    );
    if (!read || !write) throw new Error("No native process capabilities.");
    expect(await read.authorize(invocation)).toBe(true);
    await read
      .prepare({ action: "list", sourcePath: "package/source.ts" })
      .execute(invocation);
    expect(manager.list).toHaveBeenCalledOnce();
    await write
      .prepare({
        action: "stop",
        sourcePath: "package/source.ts",
        key: "service",
      })
      .execute(invocation);
    expect(manager.stop).toHaveBeenCalledOnce();
    expect(
      await write.authorize({
        ...invocation,
        identity: { ...invocation.identity, externalUserId: "another-member" },
      }),
    ).toBe(false);
  });
  it("respects scoped member permissions and cancellation before invoking the manager", async () => {
    const { provider, manager, context, declaredPermissions } = fixture();
    const list = provider.calls?.list;
    const start = provider.calls?.start;
    if (!list || !start) throw new Error("No process providers.");
    const caller = {
      ...context.caller,
      scope: [],
      projectPermissions: [
        { projectId: "project", permission: "work.processes:read" },
      ],
    };
    declaredPermissions.mockResolvedValue(["work.processes:read"]);
    await list({ ...context, caller }, { sourcePath: "package/source.ts" });
    expect(manager.list).toHaveBeenCalledOnce();
    await expect(
      start(
        { ...context, caller },
        {
          sourcePath: "package/source.ts",
          key: "service",
          command: "bun service.ts",
          lifetime: "application",
        },
      ),
    ).rejects.toThrow("cannot control");
    const canceled = AbortSignal.abort(new Error("Canceled"));
    await expect(
      list(
        { ...context, caller, signal: canceled },
        { sourcePath: "package/source.ts" },
      ),
    ).rejects.toThrow("Canceled");
    expect(manager.list).toHaveBeenCalledOnce();
  });
});
