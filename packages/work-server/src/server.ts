import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type { AgentCapabilityOptions } from "@catamorphic/core";
import {
  type ConnectionActionGuard,
  type ConnectionProvider,
  DurableToolPermissionBroker,
  type Identity,
  startEventDispatcher,
  WorkerNodesService,
} from "@catamorphic/core";
import {
  createDatabase,
  type DB,
  DEFAULT_SCHEMA,
  migrateToLatest,
} from "@catamorphic/db";
import {
  createApp,
  identityFromBearer,
  instrumentHttpServer,
  serveSpaDist,
} from "@catamorphic/fastify-plugin";
import {
  aiToolCall,
  aiToolKind,
  type Catamorphic,
  connectionAuthorizationPage,
  createCatamorphic,
  EncryptedCredentialVault,
  FsBackend,
  FsBundleStore,
  GITHUB_PROJECT_EVENT_TRIGGER_KINDS,
  ObjectRemoteBackend,
  PostgresObjectStore,
  ProjectManager,
  SESSION_TRIGGER_KINDS,
  schedule,
  webhook,
} from "@catamorphic/server-sdk";
import { createPushTransport } from "@catamorphic/server-sdk/web-push";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import Fastify, { type FastifyInstance } from "fastify";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { z } from "zod";
import { WorkAdmissionService } from "./admission/admission-service.js";
import { registerWorkAdmissionRoutes } from "./admission/routes.js";
import { workAgentCapabilities } from "./agent-capabilities.js";
import { buildAgentRegistry } from "./agents.js";
import { loadWorkAuthConfig } from "./auth/auth-config.js";
import { openWorkAuthDatabase } from "./auth/auth-database.js";
import { registerWorkAuthRoutes } from "./auth/fastify-auth.js";
import {
  createWorkAuth,
  loadWorkAuthSecret,
  type WorkAuth,
} from "./auth/work-auth.js";
import { workMark } from "./brand.js";
import {
  registerWorkMachine,
  workAuthorityId,
  workPushKeys,
} from "./cluster.js";
import type { WorkServerConfig } from "./config.js";
import { EncryptedFileCredentialVault } from "./credential-vault.js";
import { workExecution } from "./execution-config.js";
import { gatewayGuards, gatewayProviders } from "./gateway/gateway-config.js";
import { workGithub } from "./github-config.js";
import { AccountLifecycle } from "./identity/account-lifecycle.js";
import type { DirectoryProvider } from "./identity/directory.js";
import { GoogleWorkspaceDirectory } from "./identity/google-directory.js";
import { registerMachineSetup } from "./setup/machines.js";
import {
  loadWorkOperatorSecret,
  verifyWorkOperatorSecret,
} from "./setup/operator-access.js";
import {
  GrantWorkMembershipInputSchema,
  grantWorkMembership,
  ProvisionWorkUserInputSchema,
  provisionWorkUser,
} from "./setup/provision.js";
import {
  ProvisionWorkProjectInputSchema,
  provisionWorkProject,
} from "./setup/provision-project.js";
import { registerShareRoutes } from "./shares/share-routes.js";
import { shareTools } from "./shares/share-tools.js";
import { WorkSharesService } from "./shares/shares-service.js";
import {
  type MachineProvisioner,
  MachineReconciler,
} from "./workers/machine-rules.js";
import { WorkWorkerRegistry } from "./workers/worker-registry.js";
import { registerWorkerRoutes } from "./workers/worker-routes.js";

/**
 * The Work server, the prebuilt Catamorphic host (ADR 0059, 0159): everything on disk under one
 * data dir, zero external services. PGlite for the database, bare git
 * repos for project origins, local-process execution (the container is
 * the sandbox, single-tenant only per ADR 0047), Work server OAuth, and ordinary
 * project-role administration.
 */

/** Single-tenant, like the desktop: one fixed tenant for the machine. */
export const SERVER_TENANT_ID = "00000000-0000-4000-8000-0000000005e1";

const SETUP_AGENT_USER = "work-setup-agent";

/**
 * Extension points for a custom Work server (ADR 0160). Hooks add behavior;
 * they cannot bypass sign-in, admission, membership resolution, or fencing.
 */
export interface WorkServerHooks {
  agentCapabilities?: AgentCapabilityOptions;
  /** Added to the connections declared in `config.gateway`. */
  connectionProviders?: readonly ConnectionProvider[];
  /** Replace or extend the files seeded into new projects (ADR 0049). */
  projectSeeds?: (
    defaults: Readonly<Record<string, string>>,
  ) => Record<string, string>;
  /**
   * Checks on every brokered connection action from agents and workflows
   * (ADR 0162): a query policy, a model classifier, a rate limit.
   */
  connectionGuards?: readonly ConnectionActionGuard[];
  /**
   * Credential vault keys from a key service (for example a KMS unwrap at
   * boot), current first. Overrides `config.vaultKeys`.
   */
  vaultKeys?: () => Promise<Uint8Array[]>;
  /**
   * Upstream directories beyond the configured Google Workspace ones, each
   * governing the accounts of one sign-in provider (ADR 0161).
   */
  directories?: readonly DirectoryProvider[];
  /**
   * Creates and destroys worker machines on a platform, so machine rules
   * can give directory groups dedicated or shared machines (ADR 0167).
   */
  machineProvisioner?: MachineProvisioner;
  /** Mount additional host routes on the public application. */
  routes?: (args: {
    app: FastifyInstance;
    catamorphic: Catamorphic;
  }) => void | Promise<void>;
}

export interface WorkServerOptions {
  config: WorkServerConfig;
  hooks?: WorkServerHooks;
  log?: (line: string) => void;
}

export interface WorkServer {
  /** Public application, OAuth, PWA, and scoped Catamorphic API. */
  app: FastifyInstance;
  /** Machine-local setup API. The host must bind this only to loopback. */
  operatorApp: FastifyInstance;
  catamorphic: Catamorphic;
  /** Work server authentication and OAuth authorization server. */
  workAuth: WorkAuth;
  /** Account lifecycle: directory standing, disabling, sweeps (ADR 0161). */
  accounts: AccountLifecycle;
  agentsDescription: string;
  shutdown(): Promise<void>;
}

export async function createWorkServer(
  options: WorkServerOptions,
): Promise<WorkServer> {
  const disposers: Array<() => Promise<unknown>> = [];
  let closing: Promise<void> | undefined;
  const close = () =>
    (closing ??= (async () => {
      const errors: unknown[] = [];
      for (const dispose of disposers.reverse()) {
        try {
          await dispose();
        } catch (error) {
          errors.push(error);
        }
      }
      if (errors.length)
        throw new AggregateError(errors, "Server cleanup failed");
    })());
  try {
    return await createWorkServerInner(options, disposers, close);
  } catch (error) {
    await close().catch(() => {});
    throw error;
  }
}

async function createWorkServerInner(
  options: WorkServerOptions,
  disposers: Array<() => Promise<unknown>>,
  close: () => Promise<void>,
): Promise<WorkServer> {
  const { config, hooks = {} } = options;
  const log = options.log ?? (() => {});
  const data = config.dataDir;
  const publicBase = config.publicBases[0] ?? "http://127.0.0.1:4700";
  if (config.databaseUrl && !config.secret) {
    throw new Error(
      "Postgres deployments require the same WORK_SECRET on every instance",
    );
  }

  for (const dir of ["db", "projects", "remotes", "app-bundles", "sandboxes"]) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }
  const machineIdentity = loadOrCreateHostId(path.join(data, "host-id"));
  const nodeId = `node.${createHash("sha256").update(machineIdentity).digest("hex").slice(0, 24)}`;
  const hostId = config.databaseUrl
    ? workAuthorityId(publicBase)
    : machineIdentity;
  const authSecret = loadWorkAuthSecret({
    dataDir: data,
    ...(config.secret ? { configuredSecret: config.secret } : {}),
  });

  // --- database: PGlite on disk, or DATABASE_URL for teams ------------
  // PGlite is the zero-dependency default (one serialized connection);
  // pointing DATABASE_URL at real Postgres is the scale-up path — the
  // rest of the server is identical.
  let ownDb: Kysely<DB> | undefined;
  let workerConcurrency = 1;
  let databaseConfig: { db: Kysely<DB> } | { connectionString: string };
  if (config.databaseUrl) {
    // Name the schema: the database user's default `"$user", public`
    // search path only finds Catamorphic's tables for a user named after it.
    ownDb = createDatabase({
      connectionString: config.databaseUrl,
      schema: DEFAULT_SCHEMA,
    });
    disposers.push(() => ownDb!.destroy());
    databaseConfig = { db: ownDb };
    workerConcurrency = 4;
  } else {
    const pglite = new PGlite(path.join(data, "db"), {
      extensions: { pgcrypto },
    });
    ownDb = new Kysely<DB>({
      dialect: new PGliteDialect({ pglite }),
      plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
    });
    disposers.push(() => ownDb!.destroy());
    // WithSchemaPlugin only rewrites built queries; core's raw-SQL paths
    // (the worker's claim CTE) resolve tables via search_path. PGlite is
    // one session for the process's lifetime, so set it once here.
    await sql
      .raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`)
      .execute(ownDb);
    databaseConfig = { db: ownDb };
  }

  // --- execution: the container is the sandbox (ADR 0047) -------------
  // A shared control plane holds every member's credentials. Agent code run
  // as its plain subprocess could read them from the server's environment,
  // so it needs a VM sandbox, enrolled workers, or an explicit opt-in.
  if (
    config.databaseUrl &&
    config.execution.backend === "local-process" &&
    config.execution.workloads.includes("agent") &&
    !config.execution.trustControlPlaneAgents
  ) {
    throw new Error(
      "A Postgres deployment runs agents on the control plane only in microsandbox. Set WORK_SANDBOX=microsandbox, or WORK_CONTROL_PLANE_WORKLOADS=workflow and enroll workers (ADR 0164).",
    );
  }
  const execution = workExecution({
    settings: config.execution,
    dataDir: data,
  });
  const sandboxProvider = execution.provider;
  if (!ownDb) throw new Error("Database was not initialized");
  await migrateToLatest({ db: ownDb });
  const objectStore = config.databaseUrl
    ? new PostgresObjectStore(ownDb)
    : undefined;
  const workAuthConfig = loadWorkAuthConfig({
    dataDir: data,
    ...(config.authConfigPath ? { configuredPath: config.authConfigPath } : {}),
  });
  // The credential vault key is its own secret (ADR 0162): never derived
  // from the sign-in secret, and supplied by a key service through a hook
  // when the deployment has one.
  const vaultKeys = (await hooks.vaultKeys?.()) ?? config.vaultKeys ?? [];
  if (objectStore && vaultKeys.length === 0) {
    throw new Error(
      "Postgres deployments require WORK_VAULT_KEY (or the vaultKeys hook) on every instance",
    );
  }
  const credentialVault = objectStore
    ? new EncryptedCredentialVault({ store: objectStore, keys: vaultKeys })
    : new EncryptedFileCredentialVault(
        path.join(data, "credentials"),
        vaultKeys,
      );
  if (objectStore) {
    const key = "work/deployment-fingerprint";
    const fingerprint = createHash("sha256")
      .update(publicBase)
      .update("\0")
      .update(authSecret)
      .update("\0")
      .update(
        JSON.stringify({
          local: workAuthConfig.local,
          providers: workAuthConfig.providers,
          sessions: workAuthConfig.sessions,
          directory: workAuthConfig.directory,
        }),
      )
      .digest("hex");
    await objectStore
      .put(key, Buffer.from(fingerprint), { ifNoneMatch: "*" })
      .catch(async (error) => {
        const current = await objectStore.get(key);
        if (!current || Buffer.from(current.data).toString() !== fingerprint) {
          throw new Error(
            "Server origin, signing secret, or authentication configuration does not match this Postgres deployment",
            { cause: error },
          );
        }
      });
    // Vault keys rotate (ADR 0162): an instance must open at least one key
    // the deployment already knows; its current key then joins the set.
    const keysRecord = "work/vault-key-ids";
    const known = await objectStore
      .get(keysRecord)
      .then((record) =>
        record
          ? z
              .array(z.string())
              .parse(JSON.parse(Buffer.from(record.data).toString()))
          : [],
      );
    const ids = credentialVault.keyIds;
    if (known.length > 0 && !ids.some((id) => known.includes(id))) {
      throw new Error(
        "WORK_VAULT_KEY and WORK_VAULT_PREVIOUS_KEYS share no key with this Postgres deployment",
      );
    }
    if (!known.includes(credentialVault.currentKeyId)) {
      await objectStore.put(
        keysRecord,
        Buffer.from(JSON.stringify([...new Set([...known, ...ids])])),
      );
    }
  }
  // Who owns a piece of work, for worker access (ADR 0167): their email and
  // directory groups. Sign-in is set up below; placement runs only later.
  let placementOwner: (
    userId: string,
  ) => Promise<{ userId: string; groups: string[] } | undefined> = async () =>
    undefined;
  // Enrolled remote workers (ADR 0164): this instance holds the leases of
  // the workers connected to it and forwards their sandbox operations.
  const workers = new WorkWorkerRegistry({
    db: ownDb,
    nodes: new WorkerNodesService(ownDb),
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    log,
  });
  disposers.push(() => workers.releaseAll());
  const machine = await registerWorkMachine({
    db: ownDb,
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    nodeId,
    label: config.machineName,
    labels: config.machineLabels,
    capacity: execution.capacity,
    defaults: execution.defaults,
    isolation: execution.isolation,
    workloads: config.execution.workloads,
    sandboxProvider,
    workers,
    placement: {
      workers: () => workers.placements(),
      owner: (userId) => placementOwner(userId),
    },
  });
  disposers.push(() => machine.stop());
  let maintaining: Promise<void> | undefined;
  const workerTimer = setInterval(() => {
    maintaining ??= workers
      .maintain()
      .catch((error) =>
        log(
          `Worker maintenance failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
      .finally(() => {
        maintaining = undefined;
      });
  }, 10_000);
  workerTimer.unref();
  disposers.push(async () => {
    clearInterval(workerTimer);
    await maintaining;
    await workers.settle();
  });
  const environmentProvider = machine.environmentProvider;
  const toolPermissions = new DurableToolPermissionBroker(ownDb);
  const agents = buildAgentRegistry({
    sandboxProvider,
    toolPermissions,
    settings: config.agent,
  });
  const github = workGithub({
    settings: config.github,
    tenantId: SERVER_TENANT_ID,
  });

  const catamorphic = createCatamorphic({
    ...(github ? { github: github.config, proposalBot: github.identity } : {}),
    hostId,
    agentCapabilities: workAgentCapabilities({
      core: () => catamorphic.core,
      auth: () => workAuth,
      custom: hooks.agentCapabilities,
    }),
    // Unattended work re-resolves its member on every dispatch; a disabled
    // account (ADR 0161) has no authority left to lend.
    resolveMemberIdentity: async ({ tenantId, externalUserId }) =>
      (await accountLifecycle.isActive(externalUserId))
        ? catamorphic.core.memberships.identityForUser({
            tenantId,
            externalUserId,
          })
        : null,
    workerNode: machine.lease,
    heldWorkerNodes: () => [machine.lease, ...workers.heldLeases()],
    clientExecution: true,
    database: databaseConfig,
    storage: objectStore
      ? {
          projectManager: new ProjectManager(
            new FsBackend(path.join(data, "projects")),
            new ObjectRemoteBackend({
              store: objectStore,
              keyPrefix: "origins/",
            }),
          ),
        }
      : {
          projectsPath: path.join(data, "projects"),
          remotesPath: path.join(data, "remotes"),
        },
    sandboxProvider,
    environmentProvider,
    credentialVault,
    connectionGuards: [
      ...(config.gateway ? gatewayGuards(config.gateway) : []),
      ...(hooks.connectionGuards ?? []),
    ],
    connectionProviders: [
      ...(config.gateway ? gatewayProviders(config.gateway) : []),
      ...(hooks.connectionProviders ?? []),
    ],
    connectionMcpUrl: () => `${publicBase}/api/connection-mcp`,
    ...(agents.registry ? { codingAgent: agents.registry } : {}),
    appBundleStore:
      objectStore ?? new FsBundleStore(path.join(data, "app-bundles")),
    documentBlobStore:
      objectStore ?? new FsBundleStore(path.join(data, "document-blobs")),
    toolPermissions,
    triggerKinds: [
      aiToolCall,
      schedule,
      webhook,
      ...SESSION_TRIGGER_KINDS,
      ...GITHUB_PROJECT_EVENT_TRIGGER_KINDS,
    ],
    // Workflows bound to `ai.tool-call` are tools on the project MCP, for
    // project agents and members' own MCP clients alike.
    mcpToolKinds: [aiToolKind],
    projectSeeds: (defaults) => {
      const seeds = {
        ...defaults,
        ".catamorphic/agents/assistant.json": JSON.stringify({
          version: 1,
          name: "Assistant",
          kind: "builtin",
          description: "Work with your project",
        }),
      };
      return hooks.projectSeeds ? hooks.projectSeeds(seeds) : seeds;
    },
    pushNotifications: createPushTransport({
      dataDir: data,
      keys: workPushKeys(authSecret),
      subject: config.webPushSubject,
    }),
  });
  disposers.push(() => catamorphic.close());
  await catamorphic.migrate();

  // Better Auth is a Work server concern. Its PGlite database is separate
  // from Catamorphic's long-lived PGlite session; network Postgres uses the
  // dedicated catamorphic_auth schema.
  const workAuthDatabase = await openWorkAuthDatabase({
    dataDir: data,
    ...(config.databaseUrl ? { databaseUrl: config.databaseUrl } : {}),
  });
  disposers.push(() => workAuthDatabase.close());
  const workAuth = createWorkAuth({
    database: workAuthDatabase,
    baseURL: publicBase,
    secret: authSecret,
    config: workAuthConfig,
    signInGate: (account) => accountLifecycle.admitSignIn(account),
  });
  await workAuth.migrate();

  // PGlite is a single serialized connection: one worker lane there;
  // real Postgres gets a few.
  const worker = catamorphic.startExecutionWorker({
    name: "work-server",
    concurrency: workerConcurrency,
  });
  disposers.push(() => worker.stop());
  const core = catamorphic.core;
  // Webhooks, chat and GitHub events start workflows whether or not
  // coding agents are configured.
  const eventDispatcher = startEventDispatcher({ core });
  disposers.push(() => eventDispatcher.stop());
  if (github && core.github) {
    await core.github.connect(github.identity, {
      accessToken: github.accessToken,
      expiresAt: null,
      refreshToken: null,
      refreshTokenExpiresAt: null,
    });
  }
  if (github) {
    let stopped = false;
    let activeSync: Promise<void> | undefined;
    const syncProjects = async () => {
      for (let offset = 0; !stopped; offset += 50) {
        const page = await core.projects.list(github.identity, {
          limit: 50,
          offset,
        });
        for (const project of page.items) {
          if (stopped) return;
          if (!project.remoteUrl) continue;
          try {
            const result = await core.remoteSync.syncPublished({
              identity: github.identity,
              projectId: project.id,
            });
            if (result.status === "pulled" || result.status === "merged") {
              core.roles.invalidate(project.id);
              console.info(
                `Company project ${project.id} received published updates`,
              );
            }
          } catch (error) {
            console.warn(
              `Company project sync failed for ${project.id}:`,
              error,
            );
          }
        }
        if (offset + page.items.length >= page.total) return;
      }
    };
    const tick = () => {
      if (activeSync || stopped) return;
      activeSync = syncProjects()
        .catch((error) => console.warn("Company project sync failed:", error))
        .finally(() => {
          activeSync = undefined;
        });
    };
    const timer = setInterval(tick, 60_000);
    timer.unref();
    disposers.push(async () => {
      stopped = true;
      clearInterval(timer);
      await activeSync;
    });
    tick();
  }
  const rootIdentity: Identity = {
    tenantId: SERVER_TENANT_ID,
    externalUserId: SETUP_AGENT_USER,
  };
  const admission = new WorkAdmissionService({
    db: core.db,
    membershipWriterIdentity: rootIdentity,
    roles: core.roles,
    memberships: core.memberships,
  });
  const directories: DirectoryProvider[] = [
    ...workAuthConfig.providers.flatMap((provider) =>
      provider.directory
        ? [
            new GoogleWorkspaceDirectory({
              providerId: provider.id,
              credentials: provider.directory.credentials,
              requiredGroups: provider.directory.requiredGroups,
            }),
          ]
        : [],
    ),
    ...(hooks.directories ?? []),
  ];
  const shares = new WorkSharesService({
    db: core.db,
    core,
    auth: workAuth,
    guestProviderIds: () => workAuthConfig.guestProviderIds(),
    tenantId: SERVER_TENANT_ID,
    publicBase,
  });
  placementOwner = async (userId) => {
    const [user, account] = await Promise.all([
      workAuth.findUserById({ userId }),
      core.db
        .selectFrom("work_accounts")
        .select("directory_groups")
        .where("user_id", "=", userId)
        .executeTakeFirst(),
    ]);
    const groups = Array.isArray(account?.directory_groups)
      ? account.directory_groups.filter(
          (group): group is string => typeof group === "string",
        )
      : [];
    return {
      userId: user?.email?.toLowerCase() ?? userId,
      groups: groups.map((group) => group.toLowerCase()),
    };
  };
  const machineReconciler = hooks.machineProvisioner
    ? new MachineReconciler({
        db: core.db,
        tenantId: SERVER_TENANT_ID,
        workers,
        provisioner: hooks.machineProvisioner,
        controlPlaneUrl: publicBase,
        emailOf: async (userId) =>
          (await workAuth.findUserById({ userId }))?.email?.toLowerCase(),
        log,
      })
    : undefined;
  const reconcileMachines = () => {
    void machineReconciler
      ?.reconcile()
      .catch((error) =>
        log(
          `Machine reconciliation failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      );
  };
  if (machineReconciler) {
    const machineTimer = setInterval(reconcileMachines, 60_000);
    machineTimer.unref();
    disposers.push(async () => {
      clearInterval(machineTimer);
      await machineReconciler.reconcile().catch(() => undefined);
    });
  }
  const accountLifecycle = new AccountLifecycle({
    db: core.db,
    auth: workAuth,
    directories,
    sessions: workAuthConfig.sessions,
    directory: workAuthConfig.directory,
    // Groups that decide roles or whose work a worker takes (ADR 0167).
    mappedGroups: async () => [
      ...new Set([
        ...(await admission.mappedDirectoryGroups()),
        ...(await workers.accessGroups()),
        ...((await machineReconciler?.groups()) ?? []),
      ]),
    ],
    reconcileRoles: (args) => admission.reconcileDirectoryRoles(args),
    onDisabled: async ({ userId }) => {
      await stopMemberWork({ core, identity: rootIdentity, userId, log });
      // A disabled member's dedicated machine goes on the next pass.
      reconcileMachines();
    },
    // Guests view shares in the browser; they never hold API tokens.
    refuseTokens: async (userId) =>
      (await shares.isGuest(userId))
        ? "guest accounts open shared links in a browser only"
        : undefined,
    log,
  });
  if (core.agentSessions) {
    catamorphic.startAgentWorker({
      resolveIdentity: async (args) =>
        (await accountLifecycle.isActive(args.externalUserId))
          ? core.memberships.identityFor(args)
          : null,
    });
  }
  if (directories.length > 0) {
    let sweeping: Promise<unknown> | undefined;
    const sweepTimer = setInterval(() => {
      sweeping ??= accountLifecycle
        .sweep()
        .catch((error) =>
          log(
            `Account sweep failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        )
        .finally(() => {
          sweeping = undefined;
        });
    }, workAuthConfig.directory.checkIntervalMs);
    sweepTimer.unref();
    disposers.push(async () => {
      clearInterval(sweepTimer);
      await sweeping;
    });
  }
  const notificationWorkerId = `work-notifications:${nodeId}`;
  let notificationWork: Promise<void> | undefined;
  const notificationTimer = setInterval(() => {
    if (notificationWork) return;
    notificationWork = core.notifications
      .publishFailedAgentTurns({ authorityHostId: hostId })
      .then(() =>
        core.notifications.publishPausedSessions({ authorityHostId: hostId }),
      )
      .then(() => core.notifications.drain(notificationWorkerId))
      .catch((error) => {
        log(
          `Notification delivery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        );
      })
      .then(() => {})
      .finally(() => {
        notificationWork = undefined;
      });
  }, 15_000);
  notificationTimer.unref();
  disposers.push(async () => {
    clearInterval(notificationTimer);
    await notificationWork;
  });
  let scheduleWork: Promise<void> | undefined;
  const scheduleTimer = setInterval(() => {
    if (scheduleWork) return;
    scheduleWork = core.projects
      .list(rootIdentity, { limit: 1_000 })
      .then(async ({ items }) => {
        for (const project of items) {
          await core.schedules.tick({
            identity: rootIdentity,
            projectId: project.id,
          });
        }
      })
      .catch((error) =>
        log(
          `Schedule dispatch failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
      .finally(() => {
        scheduleWork = undefined;
      });
  }, 15_000);
  scheduleTimer.unref();
  disposers.push(async () => {
    clearInterval(scheduleTimer);
    await scheduleWork;
  });

  const operatorSecret = loadWorkOperatorSecret({
    dataDir: data,
    ...(config.operatorSecret
      ? { configuredSecret: config.operatorSecret }
      : {}),
  });
  // --- HTTP: the standard API app + the server's own routes -----------
  const app = createApp({
    core,
    identity: identityFromBearer(async (token) => {
      const authenticated = await workAuth.resolveAccessToken({
        authorization: `Bearer ${token}`,
      });
      if (!authenticated) return null;
      if (!(await accountLifecycle.isActive(authenticated.userId))) return null;
      if (await shares.isGuest(authenticated.userId)) return null;
      return core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId: authenticated.userId,
      });
    }),
    features: { publications: "members" },
    projectMcp: {
      serverInfo: { name: "work", title: "Work" },
      instructions:
        "- Share with people outside the company: share_create gives a document, folder, or app its own sign-in link; shares_list and share_revoke manage them.",
      tools: (scope) => shareTools(shares, scope),
    },
    // Webhook URLs name the public origin when one is configured; without
    // one they follow the address the builder reached the server on.
    ...(isLoopbackBase(publicBase)
      ? {}
      : { publicApiBase: `${publicBase}/api` }),
  });
  disposers.push(() => app.close());
  app.addHook("onSend", (request, reply, payload, done) => {
    if (
      request.method === "GET" &&
      request.url.startsWith("/api/connection-authorizations/callback?") &&
      request.headers.accept?.includes("text/html")
    ) {
      reply
        .type("text/html; charset=utf-8")
        .header("cache-control", "no-store")
        .header(
          "content-security-policy",
          "default-src 'none'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        );
      done(
        null,
        connectionAuthorizationPage({ success: reply.statusCode < 400 }),
      );
    } else done(null, payload);
  });
  instrumentHttpServer(app);
  app.addHook("onSend", (request, reply, payload, done) => {
    if (reply.statusCode !== 401 || !request.url.startsWith("/api/")) {
      done(null, payload);
      return;
    }
    const authorization = request.headers.authorization;
    const hasBearer = /^Bearer\s+\S+/i.test(
      Array.isArray(authorization)
        ? (authorization[0] ?? "")
        : (authorization ?? ""),
    );
    const resourceMetadata = `${publicBase}/.well-known/oauth-protected-resource`;
    reply.header(
      "www-authenticate",
      `Bearer resource_metadata="${resourceMetadata}"${
        hasBearer ? ', error="invalid_token"' : ""
      }`,
    );
    done(null, payload);
  });
  registerWorkerRoutes(app, workers);
  registerWorkAuthRoutes(app, {
    auth: workAuth,
    baseURL: publicBase,
    methods: workAuthConfig.publicMethods(),
    shareMethods: workAuthConfig.publicMethods("shares"),
    tokenGate: accountLifecycle,
  });
  registerShareRoutes(app, {
    core,
    auth: workAuth,
    shares,
    publicBase,
    isActive: (userId) => accountLifecycle.isActive(userId),
    caller: async (request) => {
      const header = request.headers.authorization;
      const authorization = Array.isArray(header) ? header[0] : header;
      if (!authorization) return null;
      const authenticated = await workAuth.resolveAccessToken({
        authorization,
      });
      if (
        !authenticated ||
        !(await accountLifecycle.isActive(authenticated.userId)) ||
        (await shares.isGuest(authenticated.userId))
      )
        return null;
      return core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId: authenticated.userId,
      });
    },
  });
  registerWorkAdmissionRoutes(app, {
    publicBases: config.publicBases,
    auth: workAuth,
    identityForUser: ({ externalUserId }) =>
      core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId,
      }),
    mayAct: async (userId) =>
      (await accountLifecycle.isActive(userId)) &&
      !(await shares.isGuest(userId)),
    admission,
  });

  app.get("/healthz", async () => ({
    ok: machine.healthy(),
    machine: {
      id: nodeId,
      label: config.machineName,
      capacity: execution.capacity,
      defaults: execution.defaults,
      isolation: execution.isolation,
    },
    agentSessions: Boolean(core.agentSessions),
  }));

  // Machine-local setup authority lives on a separate server, not merely a
  // guarded route on the public app. Binding this app only to loopback keeps
  // reverse proxies and other public ingress from reaching the operations.
  // It is deliberately not an application user or role: a setup agent reads
  // the owner-only credential from the mounted data directory and invokes it
  // from the same machine or container.
  const operatorApp = Fastify();
  instrumentHttpServer(operatorApp);
  disposers.push(() => operatorApp.close());
  registerMachineSetup({
    app: operatorApp,
    nodes: machine.nodes,
    workers,
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    operatorSecret,
    publicBase,
    ...(machineReconciler ? { machines: machineReconciler } : {}),
  });
  operatorApp.post("/_work/operator/projects", async (request, reply) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (!verifyWorkOperatorSecret(authorization, operatorSecret)) {
      return reply.status(401).send({ error: "Operator credential required" });
    }
    const parsed = ProvisionWorkProjectInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid project setup input",
        issues: parsed.error.issues,
      });
    }
    try {
      const result = await provisionWorkProject({
        services: {
          ...(core.github ? { github: core.github } : {}),
          projects: core.projects,
          deployment: core.deployment,
          roles: core.roles,
          admission,
        },
        operatorIdentity: rootIdentity,
        githubIdentity: github?.identity,
        input: parsed.data,
      });
      return reply.status(201).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Project setup failed";
      return reply.status(400).send({ error: message });
    }
  });

  operatorApp.post("/_work/operator/users", async (request, reply) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (!verifyWorkOperatorSecret(authorization, operatorSecret)) {
      return reply.status(401).send({ error: "Operator credential required" });
    }
    const parsed = ProvisionWorkUserInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid provisioning input",
        issues: parsed.error.issues,
      });
    }
    try {
      const result = await provisionWorkUser({
        auth: workAuth,
        services: core,
        operatorIdentity: rootIdentity,
        input: parsed.data,
      });
      return reply.status(201).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Provision failed";
      return reply.status(400).send({ error: message });
    }
  });

  operatorApp.post("/_work/operator/memberships", async (request, reply) => {
    const authorization = Array.isArray(request.headers.authorization)
      ? request.headers.authorization[0]
      : request.headers.authorization;
    if (!verifyWorkOperatorSecret(authorization, operatorSecret)) {
      return reply.status(401).send({ error: "Operator credential required" });
    }
    const parsed = GrantWorkMembershipInputSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.status(400).send({
        error: "Invalid membership input",
        issues: parsed.error.issues,
      });
    }
    try {
      const result = await grantWorkMembership({
        auth: workAuth,
        services: core,
        operatorIdentity: rootIdentity,
        input: parsed.data,
      });
      return reply.status(201).send(result);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Membership grant failed";
      return reply.status(400).send({ error: message });
    }
  });

  // The mobile PWA, served from THIS origin (workspace sibling in dev,
  // WORK_PWA_DIST in the Docker image). Serving it here is what
  // makes phones work away from any LAN: invitation links can point at
  // `https://server/?server=…&project=…&invitation=…`, the app installs from a stable
  // (ideally https) origin, and its service worker caches the shell.
  // Without a bundle, a minimal landing page answers instead.
  const pwaDist =
    config.pwaDist ??
    path.resolve(import.meta.dirname, "../../../apps/pwa/dist");
  serveSpaDist(
    app,
    () => pwaDist,
    (reply) => reply.type("text/html").send(LANDING_PAGE),
  );

  await hooks.routes?.({ app, catamorphic });

  log(`agents: ${agents.description}`);

  return {
    app,
    operatorApp,
    catamorphic,
    workAuth,
    accounts: accountLifecycle,
    agentsDescription: agents.description,
    shutdown: close,
  };
}

/**
 * Stop a disabled member's live work: in-flight agent turns end at once;
 * queued turns and unattended workflows fail their next identity check.
 */
async function stopMemberWork(args: {
  core: Catamorphic["core"];
  identity: Identity;
  userId: string;
  log: (line: string) => void;
}): Promise<void> {
  const running = await args.core.db
    .selectFrom("agent_turns as turn")
    .innerJoin("agent_sessions as session", "session.id", "turn.session_id")
    .select(["session.id", "session.project_id"])
    .where("session.external_user_id", "=", args.userId)
    .where("turn.status", "=", "running")
    .execute();
  for (const session of running) {
    try {
      await args.core.agentSessions?.interrupt(
        args.identity,
        session.project_id,
        session.id,
      );
    } catch (error) {
      args.log(
        `Could not interrupt session ${session.id}: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

function loadOrCreateHostId(file: string): string {
  try {
    const existing = fs.readFileSync(file, "utf8").trim();
    if (existing) return existing;
  } catch {
    // First boot creates a stable identity below.
  }
  const hostId = `server:${randomUUID()}`;
  fs.writeFileSync(file, `${hostId}\n`, { mode: 0o600 });
  return hostId;
}

const LANDING_PAGE = `<!doctype html>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Work server</title>
<body style="margin:0;display:grid;place-items:center;min-height:100dvh;background:#0a0a0b;color:#e6e6e9;font-family:system-ui">
<div style="text-align:center;padding:2rem">
${workMark({ size: 72 })}
<h1 style="font-size:1.2rem;margin:.7rem 0 .3rem">Work server</h1>
<p style="color:#9a9aa3;font-size:.9rem;margin:0">Running. Sign in here or connect from the Work app or an MCP client.</p>
</div>
`;

function isLoopbackBase(base: string): boolean {
  const { hostname } = new URL(base);
  return (
    hostname === "127.0.0.1" || hostname === "localhost" || hostname === "[::1]"
  );
}
