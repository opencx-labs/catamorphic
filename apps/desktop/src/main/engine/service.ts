import { GithubApi } from "@catamorphic/github";
import { customizationHost } from "../customization-host.js";
import { githubCliToken } from "../github-cli.js";
import type { EmbeddedServer } from "../server/boot.js";
import { DESKTOP_TENANT_ID, DESKTOP_USER_ID } from "../server/identity.js";
import { voiceChatOf } from "../voice/conversation.js";
import type {
  EngineApi,
  EngineEvents,
  EngineHello,
  ProjectCreation,
} from "./api.js";
import type { Served } from "./channel.js";

/**
 * The named methods of what `target` answers with, and nothing else of it:
 * a method is asked across the channel only by being listed here.
 */
function allow<Target extends object, Name extends keyof Target>(
  target: () => Target,
  names: readonly Name[],
): Pick<Target, Name> {
  const allowed = Object.create(null);
  for (const name of names)
    allowed[name] = (...args: unknown[]) => {
      const owner = target();
      const method = owner[name];
      if (typeof method !== "function")
        throw new Error(`'${String(name)}' is not an operation`);
      return Reflect.apply(method, owner, args);
    };
  return allowed;
}

/**
 * What the engine answers the main process with (ADR 0341): the server's
 * members as operations on data, each named here. Until the engine is a
 * process of its own this runs beside the main process's code, and is
 * still reached only through the channel.
 */
export function engineService({
  server,
  emit,
}: {
  server: EmbeddedServer;
  emit: <Name extends keyof EngineEvents>(
    name: Name,
    payload: EngineEvents[Name],
  ) => void;
}): {
  api: Served<EngineApi>;
  hello: EngineHello;
  /** Stop saying what happens: the channel is closing. */
  dispose(): void;
} {
  const identity = {
    tenantId: DESKTOP_TENANT_ID,
    externalUserId: DESKTOP_USER_ID,
  };
  const core = server.catamorphic.core;
  const sessions = () => {
    if (!core.agentSessions) throw new Error("Agent sessions are unavailable");
    return core.agentSessions;
  };
  const connections = () => {
    if (!core.connections) throw new Error("Connections are unavailable");
    return core.connections;
  };
  const views = () => {
    if (!server.mcpAppViews) throw new Error("MCP apps are unavailable");
    return server.mcpAppViews;
  };

  const stops = [
    server.projectRoots.onChanged((change) =>
      emit("projectRootChanged", change),
    ),
    server.onSessionsChanged(() => emit("sessionsChanged", {})),
    server.personalEnvironment.subscribe((change) =>
      emit("personalEnvironmentChanged", change),
    ),
    server.agentRegistry.onHarnessDownloadProgress((progress) =>
      emit("harnessDownloadProgress", progress),
    ),
  ];

  /**
   * A source view's lease is an `AbortSignal` where the view lives. Here it
   * is the signal of a controller held by the view's id: aborted when the
   * main process says the view closed, and let go once it is released.
   */
  const leases = new Map<string, AbortController>();
  const lease = (owner: { viewId?: string; viewClosed?: boolean }) => {
    if (!owner.viewId) return undefined;
    const held = leases.get(owner.viewId) ?? new AbortController();
    leases.set(owner.viewId, held);
    if (owner.viewClosed) held.abort();
    return held.signal;
  };
  const hostCall = customizationHost(() => server);

  /**
   * The person's own GitHub connection reads the exact repository first; a
   * missing or narrower one gets one chance to adopt the `gh` CLI's
   * credential as that connection (ADR 0073), checked against the same
   * repository before it is stored.
   */
  const ensureGithubRepositoryAccess = async (
    fullName: string,
    allowCli: boolean,
  ) => {
    try {
      await core.codeHosts.repository({
        identity,
        provider: server.github.kind,
        fullName,
      });
      return;
    } catch {
      // Not connected, expired, or no access to this repository.
    }
    const cliToken = allowCli ? await githubCliToken() : null;
    if (cliToken && core.connections) {
      try {
        await new GithubApi(cliToken, {
          signal: AbortSignal.timeout(30_000),
        }).getRepo(fullName);
        await core.connections.savePersonal({
          identity,
          providerKind: server.github.kind,
          label: "GitHub (GitHub CLI)",
          authorized: await server.github.authorizeUser({
            tokens: {
              accessToken: cliToken,
              expiresAt: null,
              refreshToken: null,
              refreshTokenExpiresAt: null,
            },
          }),
        });
        return;
      } catch {
        // GitHub rejected this credential for the exact repository.
      }
    }
    throw new Error(
      `[github-required] GitHub access to ${fullName} is required for this builder project.`,
    );
  };
  const create = async (
    creation: ProjectCreation,
    id: string,
    rootPath: string,
  ) => {
    if (creation.kind === "project")
      return core.projects.create(identity, {
        id,
        name: creation.name,
        rootPath,
        ...(creation.importExisting === undefined
          ? {}
          : { importExisting: creation.importExisting }),
        ...(creation.empty ? { empty: true } : {}),
      });
    if (creation.ensureAccess)
      await ensureGithubRepositoryAccess(
        creation.fullName,
        creation.ensureAccess.allowCli,
      );
    return core.codeHosts.importRepository({
      identity,
      provider: server.github.kind,
      id,
      fullName: creation.fullName,
      ...(creation.name ? { name: creation.name } : {}),
      rootPath,
    });
  };

  const api: Served<EngineApi> = {
    hasCodingAgent: () => server.hasCodingAgent,
    hasBackgroundWork: () => server.hasBackgroundWork(),
    suspendExecution: () => server.suspendExecution(),
    resumeExecution: () => server.resumeExecution(),
    syncSessionMailboxes: () => server.syncSessionMailboxes(),
    refreshExternalSessions: () => server.refreshExternalSessions(),
    handBackTurns: async () => {
      await server.catamorphic.handBackTurns();
    },
    shutdown: async () => {
      try {
        await server.shutdown();
      } catch (error) {
        // Each step that failed, in full: only its summary crosses.
        console.error("[desktop] The engine did not shut down cleanly:", error);
        throw error;
      }
    },
    sessionMoveEligibility: (projectId, sessionId) =>
      server.sessionMoveEligibility(projectId, sessionId),
    moveSessionToServer: (projectId, sessionId) =>
      server.moveSessionToServer(projectId, sessionId),
    openRemotePreview: (address) => server.openRemotePreview(address),
    returnSessionToProjectFolder: (input) =>
      server.returnSessionToProjectFolder(input),

    projectRoots: {
      register: async ({ create: creation, ...input }) => {
        let reopened = false;
        const project = await server.projectRoots.register({
          ...input,
          reopen: async (id) => {
            reopened = true;
            return core.projects.get(identity, id);
          },
          create: (id, rootPath) => create(creation, id, rootPath),
        });
        return { id: project.id, name: project.name, reopened };
      },
      set: (projectId, rootPath) =>
        server.projectRoots.set(projectId, rootPath),
      delete: (projectId) => server.projectRoots.delete(projectId),
    },
    sessionCheckouts: allow(
      () => server.sessionCheckouts,
      [
        "resolve",
        "assigned",
        "detail",
        "worktreesAvailable",
        "plan",
        "bringToProjectFolder",
        "discard",
      ],
    ),
    workspaceStates: allow(
      () => server.workspaceStates,
      ["get", "set", "delete"],
    ),
    agentRegistry: allow(
      () => server.agentRegistry,
      [
        "claudeCodeStatus",
        "updateInstalledClaudeCode",
        "ensureHarnessExecutable",
        "listCommands",
        "defaultModel",
        "nativeToolchainEnvironment",
        "screenNow",
      ],
    ),
    signInRecovery: allow(
      () => server.signInRecovery,
      ["signedIn", "failed", "left", "returned", "probe"],
    ),
    triggers: allow(() => server.triggers, ["onTerminalIdle"]),
    clientRunners: allow(() => server.clientRunners, ["connect"]),
    personalEnvironment: allow(
      () => server.personalEnvironment,
      ["view", "syncNow", "nudge"],
    ),
    customizationProcesses: {
      recoverProfile: (input) =>
        server.customizationProcesses.recoverProfile(input),
      inspect: () => server.customizationProcesses.inspect(),
      release: async ({ viewClosed, ...owner }) => {
        const viewSignal = lease({ ...owner, viewClosed });
        await server.customizationProcesses.release({
          ...owner,
          ...(viewSignal ? { viewSignal } : {}),
        });
        // A released view never asks again; one that does says it closed.
        if (owner.viewId) leases.delete(owner.viewId);
      },
      stopByProcessId: async (input) => {
        await server.customizationProcesses.stopByProcessId(input);
      },
      viewClosed: (viewId) => {
        leases.get(viewId)?.abort();
      },
    },
    customizationHost: ({ viewClosed, ...call }) => {
      const viewSignal = lease({ ...call, viewClosed });
      return hostCall({ ...call, ...(viewSignal ? { viewSignal } : {}) });
    },
    mcpAppViews: allow(views, [
      "open",
      "call",
      "close",
      "closeOwner",
      "document",
    ]),
    chats: {
      get: async (projectId, sessionId) => {
        const { snapshot, turn, queued, ...session } = await sessions().get(
          identity,
          projectId,
          sessionId,
        );
        return session;
      },
      voice: async (projectId, sessionId) => {
        const { snapshot, turn, queued, ...session } = await sessions().get(
          identity,
          projectId,
          sessionId,
        );
        return { session, chat: voiceChatOf(snapshot) };
      },
      create: async (projectId, input) => {
        const session = await sessions().create(identity, projectId, {
          ...input,
          source: "desktop",
        });
        return { id: session.id };
      },
    },
    catamorphic: {
      core: {
        agentDefinitions: allow(() => core.agentDefinitions, ["list"]),
        agentSessions: allow(sessions, [
          "command",
          "interrupt",
          "close",
          "archiveSubsessionsOnAgent",
        ]),
        projects: allow(
          () => core.projects,
          ["get", "delete", "commitAll", "listFiles"],
        ),
        codeHosts: allow(
          () => core.codeHosts,
          [
            "originConnected",
            "commentOnPullRequest",
            "mergePullRequest",
            "reviewPullRequest",
            "pullRequestDiscussion",
            "pullRequest",
            "pullRequestFiles",
            "pullRequestStatus",
            "listPullRequests",
          ],
        ),
        connections: allow(connections, [
          "beginPersonalAuthorization",
          "completeAuthorization",
          "cancelAuthorization",
          "personal",
          "revoke",
        ]),
      },
    },
  };

  return {
    api,
    hello: {
      url: server.url,
      apiToken: server.apiToken,
      githubKind: server.github.kind,
      projectRoots: server.projectRoots.entries(),
    },
    dispose() {
      for (const stop of stops.splice(0)) stop();
    },
  };
}
