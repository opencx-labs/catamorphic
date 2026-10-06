import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { ACTIVE_TURN_STATUSES } from "@catamorphic/agent-protocol";
import type { AgentCapabilityOptions } from "@catamorphic/core";
import {
  type ConnectionActionGuard,
  type ConnectionProvider,
  type Identity,
  startEventDispatcher,
  WorkerNodesService,
} from "@catamorphic/core";
import {
  createDatabase,
  type DB,
  DEFAULT_SCHEMA,
  migrateToLatest,
  withJsonArrayParameters,
} from "@catamorphic/db";
import {
  createApp,
  identityFromBearer,
  instrumentHttpServer,
  serveSpaDist,
} from "@catamorphic/fastify-plugin";
import {
  type HetznerCloudClientOptions,
  HetznerCloudMachines,
} from "@catamorphic/hetzner";
import { gatewayHostOf, MACHINE_CAPABILITIES } from "@catamorphic/sandbox";
import {
  aiToolCall,
  aiToolKind,
  builtinModelConnectionProviders,
  type Catamorphic,
  connectionAuthorizationPage,
  createCatamorphic,
  DIRECTORY_TRIGGER_KINDS,
  defineGithubConnectionProvider,
  EncryptedCredentialVault,
  FsBackend,
  FsBundleStore,
  type GithubConnectionOptions,
  githubCodeHost,
  ObjectRemoteBackend,
  PostgresObjectStore,
  ProjectManager,
  SESSION_TRIGGER_KINDS,
  schedule,
  webhook,
} from "@catamorphic/server-sdk";
import { createPushTransport } from "@catamorphic/server-sdk/web-push";
import { PROJECT_AGENTS_DIR } from "@catamorphic/workflow/project-layout";
import { PGlite } from "@electric-sql/pglite";
import { pgcrypto } from "@electric-sql/pglite/contrib/pgcrypto";
import Fastify, { type FastifyInstance, type FastifyRequest } from "fastify";
import { Kysely, PGliteDialect, sql, WithSchemaPlugin } from "kysely";
import { z } from "zod";
import { WorkAdmissionService } from "./admission/admission-service.js";
import { registerWorkAdmissionRoutes } from "./admission/routes.js";
import { workAgentCapabilities } from "./agent-capabilities.js";
import { buildAgentRegistry } from "./agents.js";
import { parseWorkAuthConfig } from "./auth/auth-config.js";
import { openWorkAuthDatabase } from "./auth/auth-database.js";
import { trustedProxies } from "./auth/client-address.js";
import { registerWorkAuthRoutes } from "./auth/fastify-auth.js";
import {
  createWorkAuth,
  loadWorkAuthSecret,
  verifiedUserIdForEmail,
  type WorkAuth,
} from "./auth/work-auth.js";
import { workMark } from "./brand.js";
import {
  registerWorkMachine,
  workAuthorityId,
  workPushKeys,
} from "./cluster.js";
import { startCompanyProjectSync } from "./company-sync.js";
import type { WorkServerConfig } from "./config.js";
import { EncryptedFileCredentialVault } from "./credential-vault.js";
import {
  agentsReachMachine,
  resolveExecutionSettings,
  workExecution,
} from "./execution-config.js";
import {
  gatewayProviders,
  parseGatewayConfig,
} from "./gateway/gateway-config.js";
import { AccountLifecycle } from "./identity/account-lifecycle.js";
import { registerAdministratorRoutes } from "./identity/administrator-routes.js";
import { WorkAdministrators } from "./identity/administrators.js";
import type { DirectoryProvider } from "./identity/directory.js";
import { GoogleWorkspaceDirectory } from "./identity/google-directory.js";
import { registerConnectionSetup } from "./setup/connections.js";
import { registerGithubAppSetup } from "./setup/github-app.js";
import {
  registerMachineAdministration,
  registerMachineSetup,
} from "./setup/machines.js";
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
import { CodexSignIns } from "./workers/codex-sign-ins.js";
import {
  installTarget,
  registerInstallScriptRoute,
} from "./workers/install-script.js";
import {
  MachinesConfigSchema,
  machineClassesProblem,
} from "./workers/machine-classes.js";
import {
  type MachineProvisioner,
  MachineReconciler,
} from "./workers/machine-rules.js";
import { registerMemberMachineRoutes } from "./workers/member-machine-routes.js";
import { MemberMachines } from "./workers/member-machines.js";
import { signInCapabilities } from "./workers/sign-ins.js";
import { startVolumePruning } from "./workers/volume-pruning.js";
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
  /**
   * The built-in `github` connection provider (ADR 0177): an Enterprise
   * Server's URLs, the App's OAuth client for members' own connections, or
   * a `fetch` for tests. GitHub is always available as a connection; its
   * App installation is the `github` service connection an administrator
   * connects.
   */
  github?: GithubConnectionOptions;
  /** Replace or extend the files seeded into new projects (ADR 0049). */
  projectSeeds?: (
    defaults: Readonly<Record<string, string>>,
  ) => Record<string, string>;
  /**
   * Checks on every brokered connection action from agents and workflows
   * (ADR 0162): a query policy, a model classifier, a rate limit. Guards
   * are host code; Work ships none (ADR 0183). A throwing guard denies; one
   * slower than `config.connectionGuardTimeoutMs` escalates to a person.
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
   * Creates and destroys worker machines on a platform Work does not ship,
   * for `custom` machine classes (ADRs 0167, 0205). With no classes
   * configured, every class a rule names is custom.
   */
  machineProvisioner?: MachineProvisioner;
  /**
   * Hetzner Cloud API options for `hetzner-cloud` classes: another
   * endpoint, or a `fetch` for tests. The token is `config.hetznerToken`.
   */
  hetzner?: Omit<HetznerCloudClientOptions, "token">;
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
  /**
   * Resolves when a replica's machine lease is lost: lapsed or disabled,
   * it can never be renewed, so the host should shut down and let its
   * supervisor start a fresh process (ADR 0190). A single server never
   * loses its lease; it takes it again after a lapse.
   */
  lost: Promise<void>;
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
  // Config is data, validated by the schemas the image's files use; only
  // the image's environment layer reads files for it (ADR 0183).
  const workAuthConfig = parseWorkAuthConfig(config.auth ?? {});
  // Validated here too, for servers that build their config in code.
  trustedProxies(config.trustedProxies ?? []);
  if (config.authRateLimit === false) {
    log(
      "Warning: sign-in rate limits are off (WORK_AUTH_RATE_LIMIT=off). Passwords can be guessed without limit; use this only for tests.",
    );
  }
  const gateway = config.gateway ? parseGatewayConfig(config.gateway) : null;
  if (
    config.connectionGuardTimeoutMs !== undefined &&
    !(
      Number.isSafeInteger(config.connectionGuardTimeoutMs) &&
      config.connectionGuardTimeoutMs > 0
    )
  ) {
    throw new Error(
      "config.connectionGuardTimeoutMs must be a positive whole number of milliseconds",
    );
  }
  if (config.databaseUrl && !config.secret) {
    throw new Error(
      "Postgres deployments require the same WORK_SECRET on every instance",
    );
  }
  // Machine classes (ADR 0205) need what their platforms need.
  const machineClasses = config.machines
    ? MachinesConfigSchema.parse(config.machines).classes
    : {};
  const machinesProblem = machineClassesProblem({
    classes: machineClasses,
    hetznerToken: Boolean(config.hetznerToken),
    provisioner: Boolean(hooks.machineProvisioner),
  });
  if (machinesProblem) throw new Error(machinesProblem);
  // Every replica must answer the same loopback operator credential; one
  // generated into a replica's disposable data directory would not.
  if (config.databaseUrl && !config.operatorSecret) {
    throw new Error(
      "Postgres deployments require the same WORK_OPERATOR_SECRET on every instance",
    );
  }

  // A replica on network Postgres is disposable (ADR 0190): everything
  // durable lives in the database, so its node is new at every start and
  // its disk holds only working copies and sandboxes. Sandboxes a previous
  // process left behind belong to a node that no longer exists. A single
  // server keeps its PGlite database, origins, and machine identity here.
  if (config.databaseUrl) {
    fs.rmSync(path.join(data, "sandboxes"), { recursive: true, force: true });
  }
  const dirs = config.databaseUrl
    ? ["projects", "sandboxes"]
    : ["db", "projects", "remotes", "app-bundles", "sandboxes"];
  for (const dir of dirs) {
    fs.mkdirSync(path.join(data, dir), { recursive: true });
  }
  const disposable = Boolean(config.databaseUrl);
  const hostId = config.databaseUrl
    ? workAuthorityId(publicBase)
    : loadOrCreateHostId(path.join(data, "host-id"));
  const nodeId = disposable
    ? `node.${randomUUID()}`
    : `node.${createHash("sha256").update(hostId).digest("hex").slice(0, 24)}`;
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
    ownDb = withJsonArrayParameters(
      new Kysely<DB>({
        dialect: new PGliteDialect({ pglite }),
        plugins: [new WithSchemaPlugin(DEFAULT_SCHEMA)],
      }),
    );
    disposers.push(() => ownDb!.destroy());
    // WithSchemaPlugin only rewrites built queries; core's raw-SQL paths
    // (the worker's claim CTE) resolve tables via search_path. PGlite is
    // one session for the process's lifetime, so set it once here.
    await sql
      .raw(`SET search_path TO "${DEFAULT_SCHEMA}", public`)
      .execute(ownDb);
    databaseConfig = { db: ownDb };
  }

  // --- execution: the best backend this machine offers (ADR 0204) ------
  // A shared control plane holds every member's credentials. Agent code run
  // as its plain subprocess could read them from the server's environment,
  // so it needs a VM or container sandbox, enrolled workers, or an explicit
  // opt-in. The policy is known before the machine is probed.
  const agentsHere =
    config.execution.workloads.includes("agent") &&
    !config.execution.trustControlPlaneAgents;
  const agentRefusal =
    "A Postgres deployment runs agents on the control plane only in a sandbox: set WORK_SANDBOX=microsandbox or container (or auto on a machine that offers one) without privileged runc containers, or WORK_CONTROL_PLANE_WORKLOADS=workflow and enroll workers (ADR 0164).";
  if (
    config.databaseUrl &&
    agentsHere &&
    config.execution.backend === "local-process"
  )
    throw new Error(agentRefusal);
  const resolvedExecution = await resolveExecutionSettings({
    settings: config.execution,
  });
  log(`Sandboxes: ${resolvedExecution.backend} (${resolvedExecution.reason})`);
  // A privileged runc container can reach the machine as a process can.
  if (config.databaseUrl && agentsHere && agentsReachMachine(resolvedExecution))
    throw new Error(agentRefusal);
  const execution = workExecution({
    settings: resolvedExecution,
    dataDir: data,
    log,
  });
  const sandboxProvider = execution.provider;
  // Volumes nobody used for long leave this machine too (ADR 0208).
  const stopVolumePruning = startVolumePruning({
    provider: sandboxProvider,
    retentionMs: execution.volumeRetentionMs,
    log,
  });
  disposers.push(async () => stopVolumePruning());
  if (!ownDb) throw new Error("Database was not initialized");
  await migrateToLatest({ db: ownDb });
  const objectStore = config.databaseUrl
    ? new PostgresObjectStore(ownDb)
    : undefined;
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
  // Enrolled remote workers (ADR 0164). Each worker owns its node lease
  // (ADR 0192), so any replica serves its calls and runs its agents.
  const workers = new WorkWorkerRegistry({
    db: ownDb,
    nodes: new WorkerNodesService(ownDb),
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    log,
  });
  // A single person's server whose operator accepted personal credentials
  // holds its members' own sign-ins (ADR 0213); a replica never does.
  const singleServerSignIns =
    !disposable &&
    execution.machineCapabilities.includes(
      MACHINE_CAPABILITIES.personalCredentials,
    );
  const machine = await registerWorkMachine({
    db: ownDb,
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    nodeId,
    disposable,
    label: config.machineName,
    labels: config.machineLabels,
    capacity: execution.capacity,
    defaults: execution.defaults,
    isolation: execution.isolation,
    workloads: config.execution.workloads,
    capabilities: execution.machineCapabilities,
    backend: execution.backend,
    signIns: () => signInCapabilities(execution.signInRoot),
    ownSignIns: singleServerSignIns,
    sandboxProvider,
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
  const agents = buildAgentRegistry({ settings: config.agent });
  // GitHub is an ordinary connection (ADR 0177): built in, always offered,
  // backed by the `github` service connection an administrator connects.
  const github = defineGithubConnectionProvider(hooks.github);

  const gatewayConnectionProviders = gateway ? gatewayProviders(gateway) : [];
  disposers.push(() =>
    Promise.all(
      gatewayConnectionProviders.map((provider) => provider.close?.()),
    ),
  );
  const catamorphic = createCatamorphic({
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
    // Workflows name members by the email they sign in with (ADR 0210).
    // Only a verified email names someone (ADR 0210).
    memberIdForEmail: ({ email }) =>
      verifiedUserIdForEmail({ auth: workAuth, email }),
    workerNode: machine.lease,
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
    ...(hooks.connectionGuards
      ? { connectionGuards: hooks.connectionGuards }
      : {}),
    ...(config.connectionGuardTimeoutMs
      ? { connectionGuardTimeoutMs: config.connectionGuardTimeoutMs }
      : {}),
    connectionProviders: [
      github,
      // Model keys are connections too (ADR 0180): harnesses in sandboxes
      // reach them through the gateway's model routes.
      ...builtinModelConnectionProviders().filter(
        (provider) =>
          !gatewayConnectionProviders.some(
            (configured) => configured.kind === provider.kind,
          ),
      ),
      ...gatewayConnectionProviders,
      ...(hooks.connectionProviders ?? []),
    ],
    codeHosts: [githubCodeHost(github)],
    connectionMcpUrl: () => `${publicBase}/api/connection-mcp`,
    // Sandboxes with restricted egress still reach the gateway (ADR 0176).
    gatewayHosts: config.publicBases.map((base) => gatewayHostOf(base)),
    gatewayUrl: () => `${publicBase}/api/gateway`,
    ...(agents.registry ? { codingAgent: agents.registry } : {}),
    appBundleStore:
      objectStore ?? new FsBundleStore(path.join(data, "app-bundles")),
    documentBlobStore:
      objectStore ?? new FsBundleStore(path.join(data, "document-blobs")),
    // Directory events (ADR 0210) start onboarding and offboarding
    // automations; the account lifecycle below appends them.
    triggerKinds: [
      aiToolCall,
      schedule,
      webhook,
      ...SESSION_TRIGGER_KINDS,
      ...DIRECTORY_TRIGGER_KINDS,
    ],
    // Workflows bound to `ai.tool-call` are tools on the project MCP, for
    // project agents and members' own MCP clients alike.
    mcpToolKinds: [aiToolKind],
    ...(config.webhookMaxBodyBytes
      ? { webhooks: { maxBodyBytes: config.webhookMaxBodyBytes } }
      : {}),
    projectSeeds: (defaults) => {
      const seeds = {
        ...defaults,
        [`${PROJECT_AGENTS_DIR}/assistant.json`]: JSON.stringify({
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
  // Members draft in the project origin (ADR 0191); an origin that cannot
  // keep drafts safely stops the boot instead of failing a member later.
  const drafts = await catamorphic.core.projectManager.draftSupport();
  if (!drafts.supported)
    throw new Error(`Project storage cannot keep drafts: ${drafts.reason}`);

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
    rateLimit: config.authRateLimit ?? true,
  });
  await workAuth.migrate();
  // Organization administrators hold the host-issued connections
  // permissions on the API they call (ADR 0172); roles never grant them.
  const administrators = new WorkAdministrators({
    db: ownDb,
    auth: workAuth,
  });

  // Stopping gives the node back for good once the workers below stopped
  // claiming, and moves its work to a live replica at once rather than
  // after its lease would have lapsed (ADR 0190). Placement still reads
  // sign-in, so this runs before that database closes.
  let recoverOwnNode: (() => Promise<void>) | undefined;
  disposers.push(async () => {
    await machine.stop();
    await recoverOwnNode?.();
  });
  // PGlite is a single serialized connection: one worker lane there;
  // real Postgres gets a few.
  const worker = catamorphic.startExecutionWorker({
    name: "work-server",
    concurrency: workerConcurrency,
  });
  disposers.push(() => worker.stop());
  const core = catamorphic.core;
  // Any replica recovers the work of replicas that are gone for good: runs
  // move to a live machine, chats are admitted again on their next turn.
  {
    const recover = (nodeIds?: readonly string[]) =>
      core.nodeRecovery
        .recoverLostNodes({
          authorityId: hostId,
          ...(nodeIds ? { nodeIds } : {}),
        })
        .then((result) => {
          if (
            result.movedRuns +
              result.failedRuns +
              result.releasedChats +
              result.deletedNodes >
            0
          )
            log(
              `Recovered ${result.nodes} stopped machine(s): ${result.movedRuns} run(s) moved, ${result.releasedChats} chat(s) released, ${result.failedRuns} run(s) failed, ${result.waitingRuns} run(s) waiting for a machine`,
            );
        })
        .catch((error) =>
          log(
            `Machine recovery failed: ${
              error instanceof Error ? error.message : String(error)
            }`,
          ),
        );
    if (disposable)
      recoverOwnNode = async () => {
        await recover([machine.lease.id]);
        // Every sandbox this machine still holds (moved off, released idle
        // or retired but not yet cleaned) lives here and no Allocation will
        // use it again: remove them before the process ends.
        const sandboxes = await core.db
          .selectFrom("execution_allocations")
          .select("sandbox_provider_id")
          .where("worker_node_id", "=", machine.lease.id)
          .where("sandbox_provider_id", "is not", null)
          .where((eb) =>
            eb.or([
              eb("capacity_released_at", "is", null),
              eb("release_reason", "=", "node_lost"),
            ]),
          )
          .execute();
        await Promise.allSettled(
          sandboxes.flatMap((row) =>
            row.sandbox_provider_id
              ? [sandboxProvider.destroySandbox(row.sandbox_provider_id)]
              : [],
          ),
        );
      };
    let recovering: Promise<void> | undefined;
    const tick = () => {
      recovering ??= recover().finally(() => {
        recovering = undefined;
      });
    };
    const timer = setInterval(tick, 10_000);
    timer.unref();
    disposers.push(async () => {
      clearInterval(timer);
      await recovering;
    });
    tick();
  }
  // Webhooks, chat and polled events start workflows whether or not
  // coding agents are configured.
  const eventDispatcher = startEventDispatcher({ core });
  disposers.push(() => eventDispatcher.stop());
  // Company projects attached to a code host receive what their default
  // branch accepts, through the organization's service connection.
  const rootIdentity: Identity = {
    tenantId: SERVER_TENANT_ID,
    externalUserId: SETUP_AGENT_USER,
  };
  const companySync = startCompanyProjectSync({
    services: core,
    identity: rootIdentity,
    holder: nodeId,
  });
  disposers.push(() => companySync.stop());
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
  // Every machine installs the same way (ADR 0205): the script this
  // server serves, with its public origin and worker image baked in.
  const install = installTarget({
    publicBase,
    ...(config.workerImage ? { workerImage: config.workerImage } : {}),
  });
  const machineReconciler =
    Object.keys(machineClasses).length > 0 || hooks.machineProvisioner
      ? new MachineReconciler({
          db: core.db,
          tenantId: SERVER_TENANT_ID,
          workers,
          classes: machineClasses,
          ...(hooks.machineProvisioner
            ? { provisioner: hooks.machineProvisioner }
            : {}),
          ...(config.hetznerToken
            ? {
                hetzner: new HetznerCloudMachines({
                  client: { ...hooks.hetzner, token: config.hetznerToken },
                }),
              }
            : {}),
          install,
          controlPlaneUrl: publicBase,
          emailOf: async (userId) =>
            (await workAuth.findUserById({ userId }))?.email?.toLowerCase(),
          log,
        })
      : undefined;
  const reconcileMachines = () => machineReconciler?.reconcileSoon();
  if (machineReconciler) {
    const machineTimer = setInterval(reconcileMachines, 60_000);
    machineTimer.unref();
    disposers.push(async () => {
      clearInterval(machineTimer);
      await machineReconciler.settle();
    });
  }
  const accountLifecycle = new AccountLifecycle({
    db: core.db,
    auth: workAuth,
    directories,
    sessions: workAuthConfig.sessions,
    directory: workAuthConfig.directory,
    tenantId: SERVER_TENANT_ID,
    projectEvents: core.projectEvents,
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
  const agentSessions = core.agentSessions;
  if (agentSessions) {
    const agentWorker = catamorphic.startAgentWorker({
      resolveIdentity: async (args) =>
        (await accountLifecycle.isActive(args.externalUserId))
          ? core.memberships.identityFor(args)
          : null,
    });
    // Stopping: this process's turns finish or stop before its machine and
    // their sandboxes go away (ADR 0190).
    disposers.push(async () => {
      await agentWorker.stop();
      // A lost machine's turns may already belong to another replica: stop
      // them at once rather than letting them finish.
      await agentSessions.stopLocalTurns(
        machine.isLost() ? { timeoutMs: 0 } : {},
      );
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
  // Directory events a transition could not deliver at once retry here
  // (ADR 0210); replicas share the queue through Postgres.
  let announcing: Promise<unknown> | undefined;
  const announceTimer = setInterval(() => {
    announcing ??= accountLifecycle
      .deliverAnnouncements()
      .catch((error) =>
        log(
          `Directory event delivery failed: ${
            error instanceof Error ? error.message : String(error)
          }`,
        ),
      )
      .finally(() => {
        announcing = undefined;
      });
  }, 15_000);
  announceTimer.unref();
  disposers.push(async () => {
    clearInterval(announceTimer);
    await announcing;
  });
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
  // A signed-in member's identity: their roles, plus the administrator's
  // connections permissions when they hold that flag.
  const memberIdentity = async (
    authorization: string,
  ): Promise<Identity | null> => {
    const authenticated = await workAuth.resolveAccessToken({ authorization });
    if (!authenticated) return null;
    if (!(await accountLifecycle.isActive(authenticated.userId))) return null;
    if (await shares.isGuest(authenticated.userId)) return null;
    return administrators.withPermissions(
      await core.memberships.identityForUser({
        tenantId: SERVER_TENANT_ID,
        externalUserId: authenticated.userId,
      }),
    );
  };
  const app = createApp({
    core,
    identity: identityFromBearer((token) => memberIdentity(`Bearer ${token}`)),
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
    // The Git gateway answers its own challenge (Basic, for Git's
    // credential helpers, ADR 0175).
    if (
      reply.statusCode !== 401 ||
      !request.url.startsWith("/api/") ||
      request.url.startsWith("/api/gateway/")
    ) {
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
  registerInstallScriptRoute(app, install);
  // Workers and machine rules: the operator on the loopback listener, and
  // organization administrators through the API (ADR 0205).
  const machineManagement = {
    nodes: machine.nodes,
    workers,
    tenantId: SERVER_TENANT_ID,
    authorityId: hostId,
    publicBase,
    classes: machineClasses,
    install,
    ...(machineReconciler ? { machines: machineReconciler } : {}),
  };
  registerWorkAuthRoutes(app, {
    auth: workAuth,
    baseURL: publicBase,
    methods: workAuthConfig.publicMethods(),
    shareMethods: workAuthConfig.publicMethods("shares"),
    tokenGate: accountLifecycle,
    trustedProxies: config.trustedProxies ?? [],
    log,
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
  const administratorAccess = {
    administrators,
    caller: async (request: FastifyRequest) => {
      const header = request.headers.authorization;
      const authorization = Array.isArray(header) ? header[0] : header;
      return authorization ? memberIdentity(authorization) : null;
    },
  };
  registerAdministratorRoutes(app, administratorAccess);
  registerMachineAdministration({
    app,
    ...administratorAccess,
    ...machineManagement,
  });
  // Members sign in to Codex on machines of their own from the app (ADR
  // 0213). A single server whose operator accepted personal credentials
  // is one of them for the first member to sign in there; a replica's own
  // machine never is.
  const ownSignIns = singleServerSignIns
    ? new CodexSignIns({
        signInRoot: execution.signInRoot,
        dataDir: data,
        env: { ...process.env, PATH: config.execution.path },
        onChange: () => machine.refreshSignIns(),
      })
    : undefined;
  if (ownSignIns) disposers.push(async () => ownSignIns.stop());
  const memberNodes = new WorkerNodesService(ownDb);
  registerMemberMachineRoutes(app, {
    caller: administratorAccess.caller,
    machines: new MemberMachines({
      nodes: () =>
        memberNodes.list({ tenantId: SERVER_TENANT_ID, authorityId: hostId }),
      placements: () => workers.placements(),
      owner: (userId) => placementOwner(userId),
      ...(ownSignIns
        ? { ownMachine: { nodeId: machine.lease.id, signIns: ownSignIns } }
        : {}),
      worker: (args) => workers.codexSignIn(args),
    }),
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

  // Liveness and readiness (ADR 0190). `/healthz` fails only once the
  // machine's lease is lost for good, so a database failover shorter than
  // the lease never restarts a replica. `/readyz` fails while renewals fail
  // or hang, or the machine is disabled, so a balancer can route around it.
  const health = () => ({
    machine: {
      id: nodeId,
      label: config.machineName,
      capacity: execution.capacity,
      defaults: execution.defaults,
      isolation: execution.isolation,
    },
    agentSessions: Boolean(core.agentSessions),
  });
  app.get("/healthz", async (_request, reply) => {
    const ok = !machine.isLost();
    return reply.status(ok ? 200 : 503).send({ ok, ...health() });
  });
  app.get("/readyz", async (_request, reply) => {
    const ok = !machine.isLost() && machine.ready();
    return reply.status(ok ? 200 : 503).send({ ok, ...health() });
  });

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
    operatorSecret,
    ...machineManagement,
  });
  registerConnectionSetup({
    app: operatorApp,
    operatorSecret,
    operatorIdentity: rootIdentity,
    connections: () => core.connections,
    administrators,
    publicBase,
  });
  registerGithubAppSetup({
    operatorApp,
    publicApp: app,
    operatorSecret,
    operatorIdentity: rootIdentity,
    core: () => core,
    provider: github,
    publicBase,
    db: ownDb,
    vault: credentialVault,
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
          codeHosts: core.codeHosts,
          projects: core.projects,
          deployment: core.deployment,
          roles: core.roles,
          proposals: core.proposals,
          admission,
        },
        operatorIdentity: rootIdentity,
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
      if (parsed.data.administrator) {
        await administrators.set({
          userId: result.user.id,
          administrator: true,
        });
      }
      return reply.status(201).send({
        ...result,
        administrator: parsed.data.administrator ?? false,
      });
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
    lost: machine.lost,
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
    .distinct()
    .where("session.external_user_id", "=", args.userId)
    .where("turn.status", "in", [...ACTIVE_TURN_STATUSES])
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
