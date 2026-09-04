import { randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {
  type ConnectionProvider,
  startProjectEventMonitorWorker,
  startWatcherDispatcher,
  ToolPermissionBroker,
} from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { DEFAULT_SCHEMA } from "@catamorphic/db";
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";
import {
  type Catamorphic,
  createCatamorphic,
  defineStaticEnvironments,
  FsBundleStore,
} from "@catamorphic/server-sdk";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import cors from "@fastify/cors";
import { BrowserWindow } from "electron";
import Fastify, { type FastifyInstance } from "fastify";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import type { WorkspaceBridge } from "../agent-bridge.js";
import type { ConnectorsService } from "../connectors.js";
import { DesktopCredentialVault } from "../credential-vault.js";
import type { IncognitoSessionsStore } from "../incognito-sessions.js";
import {
  type McpAppsService,
  mcpAppViewCsp,
  mcpAppViewDocument,
} from "../mcp-apps.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { RemoteSessionMirror } from "../remote-mirror.js";
import { userSkillFiles, userSkillInfos } from "../user-skills.js";
import { syncProfileMcpWorkflowConnections } from "../workflow-mcp-connections.js";
import { DesktopAgentRegistry } from "./agent-registry.js";
import { E2eLocalSandboxProvider } from "./e2e-fakes.js";
import { FileGithubTokenStore, GITHUB_APP } from "./github.js";
import {
  type HostSkillsRuntime,
  materializeHostSkills,
} from "./host-skills.js";
import type { DataPaths } from "./paths.js";
import { ProjectRootsStore } from "./project-roots.js";
import { SessionCheckouts } from "./session-checkouts.js";
import {
  DESKTOP_MCP_TOOL_KINDS,
  DESKTOP_TRIGGER_KINDS,
  DesktopTriggers,
} from "./triggers.js";
import {
  effectiveSessionAgentId,
  isolationConflictPeerSessionIds,
  type ProjectSessionContext,
} from "./workspace-context-agent.js";
import {
  registerWorkspaceMcpRoute,
  workspaceMcpAuthorizationMatches,
  workspaceMcpCapability,
} from "./workspace-mcp.js";
import { WorkspaceStateStore } from "./workspace-state.js";

/** The desktop app is single-tenant: one fixed identity for the machine. */
export const DESKTOP_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
export const DESKTOP_USER_ID = "desktop-user";

export interface EmbeddedServer {
  url: string;
  catamorphic: Catamorphic;
  projectRoots: ProjectRootsStore;
  /** Desktop-local checkout assignment and Git worktree lifecycle. */
  sessionCheckouts: SessionCheckouts;
  /** Per-project open-workspace snapshots (tabs, chats, ordering). */
  workspaceStates: WorkspaceStateStore;
  /** Dynamic roster of configured agents (per-profile agents.json files). */
  agentRegistry: DesktopAgentRegistry;
  /** Desktop trigger kinds: firing helpers for chat/terminal event sources. */
  triggers: DesktopTriggers;
  hasCodingAgent: boolean;
  /**
   * Stop the execution worker and release in-flight job leases.
   *
   * Called on OS sleep: a lease held through sleep expires on the wall clock
   * while the process is frozen, discarding the step's work. Releasing before
   * the freeze parks the job as `pending` with its attempt refunded, so it is
   * reclaimed within a poll interval of waking.
   */
  suspendExecution: () => Promise<void>;
  /** Restart the execution worker after OS resume. No-op while running. */
  resumeExecution: () => void;
  /** Poll linked remote hosts for messages addressed to local sessions. */
  syncSessionMailboxes: () => void;
  sessionMoveEligibility: (
    projectId: string,
    sessionId: string,
  ) => Promise<{ canMove: boolean; reason: string | null }>;
  moveSessionToServer: (
    projectId: string,
    sessionId: string,
  ) => Promise<{ ok: true; serverUrl: string; remoteProjectId: string }>;
  shutdown: () => Promise<void>;
}

export async function startEmbeddedServer(
  paths: DataPaths,
  profiles: ProfilesStore,
  profileConfig: ProfileConfigManager,
  workspaceBridge?: WorkspaceBridge,
  connectors?: ConnectorsService,
  mcpApps?: McpAppsService,
  incognitoSessions?: IncognitoSessionsStore,
  connectionProviders?: readonly ConnectionProvider[],
): Promise<EmbeddedServer> {
  fs.mkdirSync(paths.db, { recursive: true });
  const hostId = loadOrCreateHostId(path.join(paths.root, "host-id"));

  const pglite = new PGlite(paths.db, { extensions: { pgcrypto } });
  const db = new Kysely<DB>({
    dialect: new PGliteDialect({ pglite }),
    plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
  });
  // WithSchemaPlugin only rewrites built queries; core's raw-SQL paths (the
  // worker's claim CTE) resolve tables via search_path, which createDatabase
  // configures per-connection on server deployments. PGlite is one session
  // for the process's lifetime, so set it once here — without this the
  // polling worker can never claim a job.
  await sql.raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`).execute(db);

  // E2E runs swap the real sandbox + agents for deterministic local fakes.
  const e2eFakeAgent = process.env.CATAMORPHIC_E2E_FAKE_AGENT === "1";
  const sandboxProvider = e2eFakeAgent
    ? new E2eLocalSandboxProvider()
    : new MicrosandboxSandboxProvider();
  const environmentProvider = defineStaticEnvironments([
    {
      descriptor: {
        id: "local",
        label: "This Mac",
        description: "Run on this desktop",
        trust: "local",
        isolation: "sandbox",
        workloads: ["agent", "workflow"],
        agentTopologies: ["controller", "native"],
        capabilities: ["network.egress"],
        resources: {},
      },
      sandboxProvider,
    },
  ]);

  // Desktop projects live in user-visible folders; the mapping is desktop
  // state (its own PGlite schema), injected into storage as a resolver so
  // the shared catamorphic schema never learns about filesystem paths.
  const projectRoots = new ProjectRootsStore(pglite);
  await projectRoots.init();
  const sessionCheckouts = new SessionCheckouts({
    pglite,
    projectRoot: (projectId) => projectRoots.getSync(projectId),
  });
  await sessionCheckouts.init();
  const workspaceStates = new WorkspaceStateStore(pglite);
  await workspaceStates.init();

  // Agents resolve dynamically from the per-profile agents.json files, so
  // adding or editing an agent in Settings needs no server restart. In e2e
  // mode the default profile is seeded with two fake-backed agents so the
  // renderer's agent flows (lists, switching, effort) run for real.
  // Known only after listen(); the resolver reads it lazily, and sessions
  // can only start once the server is up.
  let apiBaseUrl: string | undefined;
  // Derive a distinct capability for each spawned Codex task. The loopback
  // server also serves browser-visible HTTP, and an exposed task token must
  // not authorize another task's terminal or checkout tools.
  const workspaceMcpSecret = randomBytes(32);
  // Core's SecretsService only exists once createCatamorphic returns; the
  // registry reads it through this late-bound seam (same pattern as
  // apiBaseUrl above) for secret-credentialed project agents (ADR 0050).
  let projectSecretResolver:
    | ((projectId: string, name: string) => Promise<string | undefined>)
    | undefined;
  // Host-tier skills (ADR 0049) materialize from core's resolved set once
  // createCatamorphic returns; the registry reads them lazily (same seam).
  let hostSkillsRuntime: HostSkillsRuntime | undefined;
  let sessionPeersResolver:
    | ((
        projectId: string,
        sessionId: string,
      ) => Promise<ProjectSessionContext[]>)
    | undefined;
  let requiresIsolatedCheckout: (
    projectId: string,
    sessionId: string,
    checkoutPath: string,
  ) => Promise<boolean> = async () => false;
  let isolationConflictPeers: (
    projectId: string,
    sessionId: string,
  ) => Promise<string[]> = async () => [];
  let syncWorkflowConnections: (profileId?: string) => Promise<void> =
    async () => {};
  let workflowConnectionSync = Promise.resolve();
  // Tool-permission asks (ADR 0054) park on this broker so REMOTE clients
  // (the companion app) can list and answer them over HTTP; the registry
  // races it against the desktop's own consent modal — first answer wins.
  const toolPermissions = new ToolPermissionBroker();
  // Session mirroring to ADR 0055 remote links (late-bound: reads core
  // through the closure after createCatamorphic returns).
  const sessionMirror = new RemoteSessionMirror({
    hostId,
    identity: {
      tenantId: DESKTOP_TENANT_ID,
      externalUserId: DESKTOP_USER_ID,
    },
    getSessionSync: () => catamorphic.core.sessionSync,
    profiles,
    profileConfig,
    // Desktop-local privacy flag (ADR 0062): never crosses core.
    isIncognito: (sessionId) => incognitoSessions?.has(sessionId) ?? false,
    markIncognito: (sessionId) => incognitoSessions?.set(sessionId, true),
    sessionDetail: (projectId, sessionId) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.get(
            { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
            projectId,
            sessionId,
          )
        : Promise.reject(new Error("agent sessions unavailable")),
    listSessions: async (projectId) =>
      catamorphic.core.agentSessions
        ? (
            await catamorphic.core.agentSessions.list(
              {
                tenantId: DESKTOP_TENANT_ID,
                externalUserId: DESKTOP_USER_ID,
              },
              projectId,
              { limit: 1_000 },
            )
          ).items
        : [],
    beginHandoff: (projectId, sessionId, destinationHostId) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.beginHandoff(
            {
              tenantId: DESKTOP_TENANT_ID,
              externalUserId: DESKTOP_USER_ID,
            },
            projectId,
            sessionId,
            { destinationHostId },
          )
        : Promise.reject(new Error("agent sessions unavailable")),
    cancelHandoff: (projectId, sessionId) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.cancelHandoff(
            {
              tenantId: DESKTOP_TENANT_ID,
              externalUserId: DESKTOP_USER_ID,
            },
            projectId,
            sessionId,
          )
        : Promise.reject(new Error("agent sessions unavailable")),
    completeHandoff: (
      projectId,
      sessionId,
      destinationHostId,
      authorityRevision,
    ) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.completeHandoff(
            {
              tenantId: DESKTOP_TENANT_ID,
              externalUserId: DESKTOP_USER_ID,
            },
            projectId,
            sessionId,
            { destinationHostId, authorityRevision },
          )
        : Promise.reject(new Error("agent sessions unavailable")),
    markFork: (projectId, sessionId, fork) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.recordMirrorFork(
            { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
            projectId,
            sessionId,
            fork,
          )
        : Promise.resolve(),
    importMailbox: (projectId, item) =>
      catamorphic.core.agentSessions
        ? catamorphic.core.agentSessions.importMailbox(
            { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
            projectId,
            item,
          )
        : Promise.reject(new Error("agent sessions unavailable")),
  });
  const agentRegistry = new DesktopAgentRegistry({
    profiles,
    profileConfig,
    sandboxProvider,
    agentHomesDir: paths.agentHomesDir,
    e2eFake: e2eFakeAgent,
    workspaceBridge,
    toolPermissions,
    connectors,
    // Each chat session gets its project's workflow-tools MCP server, so
    // agents can call ai.tool-call workflows like any other MCP tool. The
    // embedded server defaults desktop identity headers, so no auth rides
    // the URL.
    projectMcpUrl: (projectId, sessionId) =>
      apiBaseUrl
        ? `${apiBaseUrl}/api/projects/${projectId}/mcp?sessionId=${encodeURIComponent(sessionId)}`
        : undefined,
    workspaceMcpServer: (projectId, sessionId, agentId) =>
      apiBaseUrl
        ? {
            transport: "http",
            url: `${apiBaseUrl}/desktop/workspace-mcp/${encodeURIComponent(projectId)}/${encodeURIComponent(sessionId)}/${encodeURIComponent(agentId)}`,
            // This endpoint is already capability-bound to the exact
            // agent, project, and session. Codex has no interactive MCP
            // approval bridge, so authorize these host-owned tools at the
            // server boundary instead of letting the CLI cancel them.
            defaultToolsApprovalMode: "approve",
            headers: {
              Authorization: `Bearer ${workspaceMcpCapability({
                secret: workspaceMcpSecret,
                projectId,
                sessionId,
                agentId,
              })}`,
            },
          }
        : undefined,
    // Project agents (`project:<id>:<slug>`, ADR 0050): definitions are
    // read from the project's folder; secrets resolve through core.
    projectRootPath: (projectId) => projectRoots.getSync(projectId),
    projectSecret: (projectId, name) =>
      projectSecretResolver?.(projectId, name) ?? Promise.resolve(undefined),
    hostSkills: () => hostSkillsRuntime,
    // The profile's personal skill tier (ADR 0056), read live per turn.
    userSkills: (profileId) =>
      userSkillInfos(profileConfig.userSkillsDir(profileId)),
    sessionPeers: (projectId, sessionId) =>
      sessionPeersResolver?.(projectId, sessionId) ?? Promise.resolve([]),
    checkoutNotice: (_projectId, sessionId) =>
      Promise.resolve(sessionCheckouts.takeRecoveryWarning(sessionId)),
  });
  if (e2eFakeAgent) {
    const agents = profileConfig.forDefaultProfile().agents;
    if (agents.list().length === 0) {
      agents.create({ name: "Fake Agent", harness: "ai-sdk" });
      agents.create({ name: "Other Fake", harness: "ai-sdk" });
    }
  }

  const catamorphic = createCatamorphic({
    hostId,
    toolPermissions,
    database: { db },
    storage: {
      projectsPath: paths.projects,
      remotesPath: paths.remotes,
      projectPathResolver: (_tenantId, projectId) =>
        projectRoots.get(projectId),
    },
    sandboxProvider,
    environmentProvider,
    credentialVault: new DesktopCredentialVault(
      path.join(paths.root, "credentials.json"),
    ),
    connectionProviders,
    connectionMcpUrl: () =>
      apiBaseUrl ? `${apiBaseUrl}/api/connection-mcp` : undefined,
    codingAgent: agentRegistry,
    // Native agents (Claude Code, Codex) run in the project's user-visible
    // WorkerNode folder.
    nativeAgentCheckout: {
      resolve: async (input) => {
        const current = await sessionCheckouts.describe(input);
        if (
          await requiresIsolatedCheckout(
            input.projectId,
            input.sessionId,
            current.path,
          )
        ) {
          if (current.kind !== "primary") {
            throw new Error(
              "Isolation policy prevents sharing this assigned worktree with another running session. Choose another worktree or wait for that session to finish.",
            );
          }
          const created = await sessionCheckouts.createManaged({
            ...input,
            ensureAvailable: async (checkoutPath) => {
              if (
                await requiresIsolatedCheckout(
                  input.projectId,
                  input.sessionId,
                  checkoutPath,
                )
              ) {
                throw new Error(
                  "Isolation policy prevents sharing the new worktree with another running session.",
                );
              }
            },
          });
          return created.path;
        }
        return current.path;
      },
      checkpoint: (input) => sessionCheckouts.checkpoint(input),
    },
    appBundleStore: new FsBundleStore(paths.appBundles),
    // Local projects: the folder IS the store; remote projects sync their
    // store/ explicitly (Ship). No per-turn pull/ship into the local store.
    storeSyncAroundTurns: false,
    github: {
      app: GITHUB_APP,
      tokenStore: new FileGithubTokenStore(paths.githubFile),
    },
    triggerKinds: DESKTOP_TRIGGER_KINDS,
    mcpToolKinds: DESKTOP_MCP_TOOL_KINDS,
    projectHooks: [
      {
        onProjectCreated: async () => syncWorkflowConnections(),
      },
    ],
    // The user's personal skill tier (ADR 0056): profile-local files,
    // listed and readable beside project and host skills, never shared.
    userSkills: (_identity, projectId) =>
      userSkillFiles(
        profileConfig.userSkillsDir(profiles.profileForProject(projectId).id),
      ),
    // `triggers` is assigned right after construction; turns can only
    // settle later, once a chat message round-trips.
    onAgentTurnSettled: (event) => {
      triggers.onAgentTurnSettled(event);
      // Linked projects converge with their remote after every settled
      // turn (ADR 0044); no-remote projects no-op on one row read.
      const primary = projectRoots.getSync(event.projectId);
      if (
        primary &&
        path.resolve(primary) === path.resolve(event.workingDirectory)
      ) {
        catamorphic.core.remoteSync.syncInBackground(
          { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
          event.projectId,
        );
      }
      // Local-first, synced (ADR 0061): the settled transcript mirrors to
      // the ADR 0055 remote link, so phones on that server see this chat
      // and can continue it there when this desktop is gone.
      sessionMirror.mirrorInBackground(event.projectId, event.sessionId);
      // The turn checkpoint just moved git state; a sidebar waiting on
      // its 15s poll would show stale rows (and stale rows diff against
      // a HEAD that already contains them — two identical panes).
      for (const window of BrowserWindow.getAllWindows()) {
        if (window.isDestroyed()) continue;
        window.webContents.send("catamorphic:git-changed", {
          projectId: event.projectId,
        });
      }
    },
  });
  const triggers = new DesktopTriggers(catamorphic);

  // Secret-credentialed project agents (credentials.source: "secret") read
  // their key from the project's secrets — production value first, test
  // value as the fallback for projects only configured for test runs.
  projectSecretResolver = async (projectId, name) => {
    const secrets = catamorphic.core.secrets;
    if (!secrets) return undefined;
    const identity = {
      tenantId: DESKTOP_TENANT_ID,
      externalUserId: DESKTOP_USER_ID,
    };
    for (const stage of ["production", "test"] as const) {
      const { values } = await secrets.loadForRun({
        identity,
        projectId,
        stage,
      });
      if (values[name] !== undefined && values[name] !== "") {
        return values[name];
      }
    }
    return undefined;
  };

  const { applied } = await catamorphic.migrate();
  if (applied.length > 0) {
    console.log(`[desktop] Applied migrations: ${applied.join(", ")}`);
  }

  const desktopIdentity = {
    tenantId: DESKTOP_TENANT_ID,
    externalUserId: DESKTOP_USER_ID,
  };
  syncWorkflowConnections = (profileId?: string) => {
    // OAuth discovery, registration, token exchange, and tool probing can
    // each update the profile store. Serialize their projections so two
    // snapshots never race the connection service's compare-and-swap.
    workflowConnectionSync = workflowConnectionSync
      .then(() =>
        syncProfileMcpWorkflowConnections({
          core: catamorphic.core,
          profiles,
          profileConfig,
          identity: desktopIdentity,
          profileId,
        }),
      )
      .catch((error) =>
        console.warn(
          `[desktop] workflow connection sync failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
    return workflowConnectionSync;
  };
  await syncWorkflowConnections();
  profileConfig.onConnectionsChanged((profileId) => {
    void syncWorkflowConnections(profileId);
  });
  isolationConflictPeers = async (projectId, sessionId) => {
    const detail = await catamorphic.core.agentSessions?.get(
      desktopIdentity,
      projectId,
      sessionId,
    );
    if (!detail) return [];
    const peers = await catamorphic.core.agentSessions?.listPeers(
      desktopIdentity,
      projectId,
      sessionId,
    );
    return isolationConflictPeerSessionIds({
      projectId,
      agentId: detail.agentId,
      peers: (peers ?? [])
        .filter(
          (peer) => peer.running && !(incognitoSessions?.has(peer.id) ?? false),
        )
        .map((peer) => ({ id: peer.id, agentId: peer.agentId })),
      defaultAgentId: (id) => agentRegistry.defaultAgentId(id),
      coordinationForAgent: (id) => agentRegistry.coordinationForAgent(id),
    });
  };
  requiresIsolatedCheckout = async (projectId, sessionId, checkoutPath) => {
    const peerSessionIds = await isolationConflictPeers(projectId, sessionId);
    return sessionCheckouts.isOccupied({
      projectId,
      sessionId,
      path: checkoutPath,
      peerSessionIds,
    });
  };
  sessionPeersResolver = async (projectId, sessionId) => {
    const peers =
      (await catamorphic.core.agentSessions?.listPeers(
        desktopIdentity,
        projectId,
        sessionId,
      )) ?? [];
    const visible = peers.filter(
      (peer) => !(incognitoSessions?.has(peer.id) ?? false),
    );
    return Promise.all(
      visible.map(async (peer) => {
        const checkout = await sessionCheckouts.describe({
          projectId,
          sessionId: peer.id,
        });
        return {
          ...peer,
          checkout: { kind: checkout.kind, branch: checkout.branch },
        };
      }),
    );
  };

  agentRegistry.workspaceToolkit?.setSessionCoordinationBridge({
    list: (projectId, sessionId) =>
      sessionPeersResolver?.(projectId, sessionId) ?? Promise.resolve([]),
    read: async (projectId, ownSessionId, peerSessionId) => {
      const peers = await sessionPeersResolver?.(projectId, ownSessionId);
      if (!peers?.some((peer) => peer.id === peerSessionId)) return null;
      const detail = await catamorphic.core.agentSessions?.get(
        desktopIdentity,
        projectId,
        peerSessionId,
      );
      if (!detail) return null;
      return {
        title: detail.title,
        messages: detail.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    },
    setActivity: async (projectId, sessionId, activity) => {
      await catamorphic.core.agentSessions?.setActivity(
        desktopIdentity,
        projectId,
        sessionId,
        activity,
      );
    },
  });
  agentRegistry.workspaceToolkit?.setTodoListBridge({
    read: async (projectId, sessionId) => {
      const detail = await catamorphic.core.agentSessions?.get(
        desktopIdentity,
        projectId,
        sessionId,
      );
      if (!detail) throw new Error("Agent sessions are not configured");
      return detail.todos;
    },
    replace: async (projectId, sessionId, items) => {
      const service = catamorphic.core.agentSessions;
      if (!service) throw new Error("Agent sessions are not configured");
      return service.replaceTodos(desktopIdentity, projectId, sessionId, items);
    },
  });
  agentRegistry.workspaceToolkit?.setCheckoutBridge({
    current: (projectId, sessionId) =>
      sessionCheckouts.describe({ projectId, sessionId }),
    list: (projectId) => sessionCheckouts.list(projectId),
    create: async (projectId, sessionId) => {
      return sessionCheckouts.createManaged({
        projectId,
        sessionId,
        ensureAvailable: async (checkoutPath) => {
          if (
            await requiresIsolatedCheckout(projectId, sessionId, checkoutPath)
          ) {
            throw new Error(
              "Isolation policy prevents sharing the new worktree with another running session.",
            );
          }
        },
      });
    },
    use: (projectId, sessionId, checkoutPath) =>
      sessionCheckouts.withAssignmentLock({
        projectId,
        operation: async () => {
          if (
            await requiresIsolatedCheckout(projectId, sessionId, checkoutPath)
          ) {
            throw new Error(
              "Isolation policy prevents using a checkout occupied by another running session.",
            );
          }
          return sessionCheckouts.adopt({
            projectId,
            sessionId,
            path: checkoutPath,
          });
        },
      }),
    usePrimary: (projectId, sessionId) =>
      sessionCheckouts.withAssignmentLock({
        projectId,
        operation: async () => {
          const root = projectRoots.getSync(projectId);
          if (!root) throw new Error(`Project '${projectId}' has no folder`);
          if (await requiresIsolatedCheckout(projectId, sessionId, root)) {
            throw new Error(
              "Isolation policy prevents using the primary checkout while another protected session is running there.",
            );
          }
          return sessionCheckouts.returnPrimary({ projectId, sessionId });
        },
      }),
  });
  agentRegistry.workspaceToolkit?.setSessionVisibility(
    async (_projectId, sessionId) =>
      !(incognitoSessions?.has(sessionId) ?? false),
  );

  // The workspace toolkit's read_tab expands chat tabs into transcripts;
  // the chat store only exists from here on.
  agentRegistry.workspaceToolkit?.setChatTranscriptReader(
    async (projectId, sessionId) => {
      if (incognitoSessions?.has(sessionId)) return null;
      const detail = await catamorphic.core.agentSessions?.get(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
        sessionId,
      );
      if (!detail) return null;
      return {
        title: detail.title ?? null,
        messages: detail.messages.map((message) => ({
          role: message.role,
          content: message.content,
        })),
      };
    },
  );

  // The agent's set_chat_icon tool writes straight through the chat store
  // (works for every harness — ai-sdk mounts it as a tool, Claude Code as
  // an MCP tool).
  agentRegistry.workspaceToolkit?.setChatIconSetter(
    async (projectId, sessionId, icon) => {
      await catamorphic.core.agentSessions?.setIcon(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
        sessionId,
        icon,
      );
    },
  );

  // The agent's build_app tool: compile in the dev sandbox and (usually)
  // publish, so "build me a dashboard" ends with something the user can
  // open — not an unpublished draft.
  agentRegistry.workspaceToolkit?.setAppBuilder(
    async (projectId, appName, publish) => {
      const apps = catamorphic.core.apps;
      if (!apps) return { status: "failed", error: "Apps are not configured" };
      const identity = {
        tenantId: DESKTOP_TENANT_ID,
        externalUserId: DESKTOP_USER_ID,
      };
      // Published builds compile a pinned commit: commit the dev tree
      // (pulling any in-flight sandbox work back first) and build that sha.
      const commitSha = publish
        ? await apps.commitDevTree({
            identity,
            projectId,
            message: `Publish ${appName}`,
          })
        : undefined;
      const version = await apps.build({
        identity,
        projectId,
        appName,
        kind: publish ? "published" : "preview",
        commitSha,
      });
      if (version.status !== "ready") {
        return {
          status: "failed",
          versionId: version.id,
          error: version.error ?? "Build failed",
        };
      }
      if (!publish) return { status: "preview_ready", versionId: version.id };
      await apps.publish({ identity, projectId, versionId: version.id });
      return { status: "published", versionId: version.id };
    },
  );

  // The agent's git tools (ADR 0044): explicit sync and PR creation on the
  // project's linked remote, through the provider-agnostic core service.
  agentRegistry.workspaceToolkit?.setGitBridge({
    sync: async (projectId, sessionId) => {
      const checkout = await sessionCheckouts.describe({
        projectId,
        sessionId,
      });
      if (checkout.kind !== "primary") {
        return {
          status: "isolated",
          branch: checkout.branch,
          note: "This session is isolated, so main was not synced. Use create_pull_request to share this worktree's changes.",
        };
      }
      const outcome = await catamorphic.core.remoteSync.sync(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
      );
      return {
        status: outcome.status,
        ...("rescueBranch" in outcome && outcome.rescueBranch
          ? { rescueBranch: outcome.rescueBranch }
          : {}),
      };
    },
    createPullRequest: async (projectId, sessionId, input) => {
      const checkout = await sessionCheckouts.describe({
        projectId,
        sessionId,
      });
      if (checkout.kind === "primary") {
        return catamorphic.core.remoteSync.createPullRequest(
          desktopIdentity,
          projectId,
          input,
        );
      }
      const prepared = await sessionCheckouts.preparePullRequest({
        projectId,
        sessionId,
        message: input.title,
      });
      return catamorphic.core.remoteSync.createPullRequestFromRef(
        desktopIdentity,
        projectId,
        { ...input, localRef: prepared.branch },
      );
    },
  });

  // Host-tier skills (ADR 0049): the desktop passes no hook, so this is the
  // framework default set, staged as a native Claude Code plugin and listed
  // in every harness's system prompt.
  try {
    hostSkillsRuntime = materializeHostSkills(
      paths.hostSkillsDir,
      catamorphic.core.hostSkillFiles,
    );
  } catch (cause) {
    // Skills are additive; a failed materialization must not stop boot.
    console.warn("[desktop] host-skills materialization failed:", cause);
  }

  // The agent's read_skill tool: by-name skill content from either tier,
  // through core's SkillsService (project files win name collisions).
  agentRegistry.workspaceToolkit?.setSkillReader(async (projectId, name) => {
    const result = await catamorphic.core.skills.read(
      { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
      projectId,
      name,
    );
    if (!result) return null;
    return {
      name: result.skill.name,
      source: result.skill.source,
      path: result.skill.path,
      content: result.content,
    };
  });

  // Fastify's default 1MB body cap rejects a single pasted screenshot;
  // media attachments are ~10MB each (base64 4/3), the composer caps the
  // total it sends well below this.
  const app: FastifyInstance = Fastify({
    logger: { level: "warn" },
    bodyLimit: 96 * 1024 * 1024,
  });
  registerWorkspaceMcpRoute(
    app,
    async ({ projectId, sessionId, agentId, authorization }) => {
      if (
        !workspaceMcpAuthorizationMatches({
          secret: workspaceMcpSecret,
          projectId,
          sessionId,
          agentId,
          authorization,
        })
      ) {
        return null;
      }
      const detail = await catamorphic.core.agentSessions?.get(
        desktopIdentity,
        projectId,
        sessionId,
      );
      if (
        !detail ||
        effectiveSessionAgentId({
          projectId,
          agentId: detail.agentId,
          defaultAgentId: (id) => agentRegistry.defaultAgentId(id),
        }) !== agentId
      ) {
        return null;
      }
      const tools = agentRegistry.workspaceToolsForAgent(agentId);
      if (!tools) return null;
      const workingDirectory = await sessionCheckouts.resolve({
        projectId,
        sessionId,
      });
      return {
        tools,
        context: {
          projectId,
          sessionId,
          ...(workingDirectory ? { workingDirectory } : {}),
          caller: desktopIdentity,
        },
      };
    },
  );
  await app.register(cors, {
    origin: true,
    methods: ["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"],
  });
  // The desktop is a single-user host: every request is the one local user,
  // a builder with the full project surface. This line is the whole of the
  // desktop's identity story — there is no default inside the plugin.
  await app.register(catamorphicPlugin, {
    core: catamorphic.core,
    identity: () => ({
      tenantId: DESKTOP_TENANT_ID,
      externalUserId: DESKTOP_USER_ID,
    }),
    prefix: "/api",
  });

  // MCP Apps view documents, served (not srcdoc'd) so each carries its own
  // CSP instead of inheriting the shell's, which would block inline scripts.
  if (mcpApps) {
    app.get("/desktop/mcp-app-view", async (request, reply) => {
      const { profileId, toolKey } = request.query as {
        profileId?: string;
        toolKey?: string;
      };
      if (!profileId || !toolKey) {
        return reply.status(400).send({ error: "Missing profileId/toolKey" });
      }
      const view = await mcpApps.view(profileId, toolKey);
      return reply
        .header("content-type", "text/html; charset=utf-8")
        .header("content-security-policy", mcpAppViewCsp(view))
        .header("cache-control", "no-store")
        .send(mcpAppViewDocument(view));
    });
  }

  await app.listen({ port: 0, host: "127.0.0.1" });
  const address = app.server.address();
  if (address === null || typeof address === "string") {
    throw new Error("Embedded server bound to an unexpected address");
  }
  const url = `http://127.0.0.1:${address.port}`;
  apiBaseUrl = url;
  console.log(`[desktop] API ready on ${url}/api`);

  let shutdownDone: Promise<void> | undefined;

  // PGlite is a single serialized connection; more worker concurrency would
  // only queue on the connection mutex.
  const startWorker = () =>
    catamorphic.startExecutionWorker({ name: "desktop", concurrency: 1 });
  let worker: ReturnType<typeof startWorker> | null = startWorker();
  const projectEventWorker = startProjectEventMonitorWorker({
    monitors: catamorphic.core.projectEventMonitors,
    providers: catamorphic.core.projectEventSources,
    placement: "local",
  });
  const watcherDispatcher = catamorphic.core.watchers
    ? startWatcherDispatcher({ watchers: catamorphic.core.watchers })
    : null;
  const suspendExecution = async () => {
    const current = worker;
    worker = null;
    await current?.stop().catch(() => {});
  };
  const resumeExecution = () => {
    if (shutdownDone || worker) return;
    worker = startWorker();
  };

  // Project workspaces type-check `trigger()` against a generated
  // catamorphic-triggers.d.ts; refresh it everywhere in the background so
  // the coding agent always sees the host's current kinds.
  void triggers.syncAllProjectTypes().catch(() => {});

  // Remote sync sweep (ADR 0044): converge every linked project at boot and
  // on an interval. Sync also fires after each settled turn; the service
  // coalesces overlapping calls per project.
  const identity = {
    tenantId: DESKTOP_TENANT_ID,
    externalUserId: DESKTOP_USER_ID,
  };
  const syncAllRemotes = async () => {
    const { items } = await catamorphic.core.projects.list(identity, {
      limit: 100,
    });
    for (const project of items) {
      catamorphic.core.remoteSync.syncInBackground(identity, project.id);
    }
  };
  void syncAllRemotes().catch(() => {});
  const remoteSyncTimer = setInterval(
    () => void syncAllRemotes().catch(() => {}),
    10 * 60 * 1000,
  );
  const tickSchedules = async () => {
    const { items } = await catamorphic.core.projects.list(identity, {
      limit: 1_000,
    });
    for (const project of items) {
      const remoteProjects = profileConfig.forProfile(
        profiles.profileForProject(project.id).id,
      ).remoteProjects;
      // A linked project's canonical hosting server owns its schedules.
      // This desktop does not shadow-run them or become an implicit fallback.
      if (remoteProjects.get(project.id)) continue;
      await catamorphic.core.schedules.tick({
        identity,
        projectId: project.id,
      });
    }
  };
  void tickSchedules().catch(() => {});
  const scheduleTimer = setInterval(
    () => void tickSchedules().catch(() => {}),
    15_000,
  );
  sessionMirror.syncMailboxesInBackground();
  const sessionMailboxTimer = setInterval(
    () => sessionMirror.syncMailboxesInBackground(),
    5_000,
  );
  sessionMirror.syncMirrorsInBackground();
  const sessionMirrorTimer = setInterval(
    () => sessionMirror.syncMirrorsInBackground(),
    30_000,
  );

  const shutdown = () => {
    shutdownDone ??= (async () => {
      clearInterval(remoteSyncTimer);
      clearInterval(sessionMailboxTimer);
      clearInterval(sessionMirrorTimer);
      clearInterval(scheduleTimer);
      projectEventWorker.stop();
      watcherDispatcher?.stop();
      await suspendExecution();
      await app.close().catch(() => {});
      await catamorphic.close().catch(() => {});
      // catamorphic.close() leaves the host-owned Kysely alone; destroying it
      // closes the PGlite instance (flushes WAL to the data dir).
      await db.destroy().catch(() => {});
    })();
    return shutdownDone;
  };

  return {
    url,
    catamorphic,
    projectRoots,
    sessionCheckouts,
    workspaceStates,
    agentRegistry,
    triggers,
    get hasCodingAgent() {
      return agentRegistry.hasAgents();
    },
    suspendExecution,
    resumeExecution,
    syncSessionMailboxes: () => sessionMirror.syncMailboxesInBackground(),
    sessionMoveEligibility: (projectId, sessionId) =>
      sessionMirror.eligibility(projectId, sessionId),
    moveSessionToServer: (projectId, sessionId) =>
      sessionMirror.moveToServer(projectId, sessionId),
    shutdown,
  };
}

function loadOrCreateHostId(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First boot creates a stable identity below.
  }
  const hostId = `desktop:${randomUUID()}`;
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${hostId}\n`, { mode: 0o600 });
  return hostId;
}
