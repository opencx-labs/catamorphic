import fs from "node:fs";
import { ToolPermissionBroker } from "@catamorphic/core";
import type { DB } from "@catamorphic/db";
import { DEFAULT_SCHEMA } from "@catamorphic/db";
import { catamorphicPlugin } from "@catamorphic/fastify-plugin";
import { MicrosandboxSandboxProvider } from "@catamorphic/microsandbox";
import {
  type Catamorphic,
  createCatamorphic,
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
import {
  type McpAppsService,
  mcpAppViewCsp,
  mcpAppViewDocument,
} from "../mcp-apps.js";
import type { ProfileConfigManager } from "../profile-config.js";
import type { ProfilesStore } from "../profiles.js";
import { userSkillFiles, userSkillInfos } from "../user-skills.js";
import { DesktopAgentRegistry } from "./agent-registry.js";
import { E2eLocalSandboxProvider } from "./e2e-fakes.js";
import { FileGithubTokenStore, GITHUB_APP } from "./github.js";
import {
  type HostSkillsRuntime,
  materializeHostSkills,
} from "./host-skills.js";
import type { DataPaths } from "./paths.js";
import { ProjectRootsStore } from "./project-roots.js";
import {
  DESKTOP_MCP_TOOL_KINDS,
  DESKTOP_TRIGGER_KINDS,
  DesktopTriggers,
} from "./triggers.js";
import { WorkspaceStateStore } from "./workspace-state.js";

/** The desktop app is single-tenant: one fixed identity for the machine. */
export const DESKTOP_TENANT_ID = "00000000-0000-4000-8000-00000000d001";
export const DESKTOP_USER_ID = "desktop-user";

export interface EmbeddedServer {
  url: string;
  catamorphic: Catamorphic;
  projectRoots: ProjectRootsStore;
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
  shutdown: () => Promise<void>;
}

export async function startEmbeddedServer(
  paths: DataPaths,
  profiles: ProfilesStore,
  profileConfig: ProfileConfigManager,
  workspaceBridge?: WorkspaceBridge,
  connectors?: ConnectorsService,
  mcpApps?: McpAppsService,
): Promise<EmbeddedServer> {
  fs.mkdirSync(paths.db, { recursive: true });

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

  // Desktop projects live in user-visible folders; the mapping is desktop
  // state (its own PGlite schema), injected into storage as a resolver so
  // the shared catamorphic schema never learns about filesystem paths.
  const projectRoots = new ProjectRootsStore(pglite);
  await projectRoots.init();
  const workspaceStates = new WorkspaceStateStore(pglite);
  await workspaceStates.init();

  // Agents resolve dynamically from the per-profile agents.json files, so
  // adding or editing an agent in Settings needs no server restart. In e2e
  // mode the default profile is seeded with two fake-backed agents so the
  // renderer's agent flows (lists, switching, effort) run for real.
  // Known only after listen(); the resolver reads it lazily, and sessions
  // can only start once the server is up.
  let apiBaseUrl: string | undefined;
  // Core's SecretsService only exists once createCatamorphic returns; the
  // registry reads it through this late-bound seam (same pattern as
  // apiBaseUrl above) for secret-credentialed project agents (ADR 0050).
  let projectSecretResolver:
    | ((projectId: string, name: string) => Promise<string | undefined>)
    | undefined;
  // Host-tier skills (ADR 0049) materialize from core's resolved set once
  // createCatamorphic returns; the registry reads them lazily (same seam).
  let hostSkillsRuntime: HostSkillsRuntime | undefined;
  // Tool-permission asks (ADR 0054) park on this broker so REMOTE clients
  // (the companion app) can list and answer them over HTTP; the registry
  // races it against the desktop's own consent modal — first answer wins.
  const toolPermissions = new ToolPermissionBroker();
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
    projectMcpUrl: (projectId) =>
      apiBaseUrl ? `${apiBaseUrl}/api/projects/${projectId}/mcp` : undefined,
    // Project agents (`project:<id>:<slug>`, ADR 0050): definitions are
    // read from the project's folder; secrets resolve through core.
    projectRootPath: (projectId) => projectRoots.getSync(projectId),
    projectSecret: (projectId, name) =>
      projectSecretResolver?.(projectId, name) ?? Promise.resolve(undefined),
    hostSkills: () => hostSkillsRuntime,
    // The profile's personal skill tier (ADR 0056), read live per turn.
    userSkills: (profileId) =>
      userSkillInfos(profileConfig.userSkillsDir(profileId)),
  });
  if (e2eFakeAgent) {
    const agents = profileConfig.forDefaultProfile().agents;
    if (agents.list().length === 0) {
      agents.create({ name: "Fake Agent", harness: "ai-sdk" });
      agents.create({ name: "Other Fake", harness: "ai-sdk" });
    }
  }

  const catamorphic = createCatamorphic({
    toolPermissions,
    database: { db },
    storage: {
      projectsPath: paths.projects,
      remotesPath: paths.remotes,
      projectPathResolver: (_tenantId, projectId) =>
        projectRoots.get(projectId),
    },
    sandboxProvider,
    codingAgent: agentRegistry,
    // Host-execution agents (Claude Code, Codex) run right in the project's
    // user-visible folder.
    hostProjectPathResolver: async (projectId) =>
      (await projectRoots.get(projectId)) ?? undefined,
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
      catamorphic.core.remoteSync.syncInBackground(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        event.projectId,
      );
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
    for (const environment of ["production", "test"] as const) {
      const { values } = await secrets.loadForRun({
        identity,
        projectId,
        environment,
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

  // The workspace toolkit's read_tab expands chat tabs into transcripts;
  // the chat store only exists from here on.
  agentRegistry.workspaceToolkit?.setChatTranscriptReader(
    async (projectId, sessionId) => {
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
    sync: async (projectId) => {
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
    createPullRequest: (projectId, input) =>
      catamorphic.core.remoteSync.createPullRequest(
        { tenantId: DESKTOP_TENANT_ID, externalUserId: DESKTOP_USER_ID },
        projectId,
        input,
      ),
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

  const shutdown = () => {
    shutdownDone ??= (async () => {
      clearInterval(remoteSyncTimer);
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
    workspaceStates,
    agentRegistry,
    triggers,
    get hasCodingAgent() {
      return agentRegistry.hasAgents();
    },
    suspendExecution,
    resumeExecution,
    shutdown,
  };
}
