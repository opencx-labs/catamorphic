import { createHash } from "node:crypto";
import type {
  RuntimeArtifactIdentity,
  RuntimeBatchStepSuspension,
  RuntimeInvocationEvent,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationRequest,
  RuntimeStepEntry,
  RuntimeSupervisorHealth,
  RuntimeTerminalResult,
} from "@catamorphic/runtime";
import type { SandboxProcessProvider } from "./processes.js";
import type {
  SandboxCapability,
  SandboxEgress,
  SandboxImage,
} from "./sandbox-environment.js";

export type SandboxType = "execution" | "dev";

/**
 * Where in a sandbox that runs commands apart (ADR 0332) an operation
 * happens: beside the agent (its runner, grants and state) or where its
 * commands run. `commands` is the default everywhere, so an operation that
 * names no side runs where the pull request's code already is. A provider
 * without `commands.separate` has one side and ignores it.
 */
export type SandboxSide = "agent" | "commands";

/** Options naming the side of a file operation (ADR 0332). */
export interface SandboxFileOpts {
  side?: SandboxSide;
}

export type SandboxStatus =
  | "creating"
  | "started"
  | "stopped"
  | "archived"
  | "error";

export interface SandboxHandle {
  id: string;
  providerId: string;
  sandboxType: SandboxType;
  status: SandboxStatus;
  /**
   * Read-only cache generations it was handed and did not mount, because
   * the machine no longer has them (ADR 0334). The control plane forgets
   * those copies and fills the machine again.
   */
  skippedVolumes?: string[];
}

/** Hard sandbox limits. A provider must reject limits it cannot enforce. */
export interface SandboxResources {
  cpuMillis?: number;
  memoryMb?: number;
  storageMb?: number;
  gpu?: boolean;
}

export function assertSandboxResources(
  resources: SandboxResources | undefined,
  supported: readonly (keyof SandboxResources)[],
): void {
  for (const [key, value] of Object.entries(resources ?? {})) {
    if (value === undefined || value === false) continue;
    if (!supported.some((item) => item === key)) {
      throw new Error(`Sandbox provider cannot enforce '${key}'`);
    }
    if (
      typeof value === "number" &&
      (!Number.isSafeInteger(value) || value <= 0)
    ) {
      throw new Error(`Sandbox limit '${key}' must be a positive integer`);
    }
  }
}

export interface CreateSandboxOpts {
  resources?: SandboxResources;
  snapshotName?: string;
  /**
   * The image the Environment chose (ADR 0176). Needs the `images`
   * capability, and `images.build` for a Dockerfile.
   */
  image?: SandboxImage;
  /** Give the sandbox its own container runtime; needs `containers`. */
  containers?: boolean;
  /** Outbound reach; anything but open needs `network.policy`. */
  egress?: SandboxEgress;
  language?: string;
  envVars?: Record<string, string>;
  autoStopInterval?: number;
  labels?: Record<string, string>;
  /**
   * Members' own harness sign-ins to make available inside the sandbox
   * (ADR 0199), from the machine's own disk: mounted (or linked) at
   * {@link signInHomePath}. The machine never sends them anywhere; a
   * provider without the `sign-ins` capability refuses.
   */
  signIns?: ReadonlyArray<{ harness: SignInHarness; member: string }>;
  /**
   * Directories kept on the machine across sandboxes (ADR 0208), mounted
   * at their paths. Needs the `volumes` capability.
   */
  volumes?: readonly SandboxVolume[];
  /**
   * Run commands apart from the agent (ADR 0332): needs
   * `commands.separate`. The sandbox becomes an agent side and a command
   * side sharing only the `shared` directories (the checkout). The
   * provider serves {@link SEPARATE_COMMANDS_SOCKET} on the agent side;
   * every command it runs there for the agent first loads `envFiles` (the
   * command side's own session files) where they exist.
   */
  separateCommands?: {
    shared: readonly string[];
    envFiles?: readonly string[];
    /**
     * The agent side's own limits; `resources` are the command side's,
     * where the change's tests and services run. Defaults to
     * {@link SEPARATE_AGENT_DEFAULT_RESOURCES}.
     */
    agentResources?: SeparateAgentResources;
  };
  /**
   * A sandbox Work makes for its own commands alone, such as checking a
   * filled cache generation (ADR 0334): no network at all, no setup command,
   * no proxy, nothing of an Environment's. Needs the `caches` capability; a
   * provider that cannot cut a sandbox off entirely refuses it.
   */
  internal?: boolean;
}

/** The limits of the agent side of a sandbox that runs commands apart (ADR 0332). */
export interface SeparateAgentResources {
  cpuMillis?: number;
  memoryMb?: number;
}

/**
 * What the agent side of a sandbox that runs commands apart gets unless its
 * Environment says otherwise (ADR 0332): enough for a harness and its
 * runner, which run no tests or services. Its Allocation reserves it on
 * top of the command side's limits.
 */
export const SEPARATE_AGENT_DEFAULT_RESOURCES = {
  cpuMillis: 1000,
  memoryMb: 2048,
} as const;

/**
 * What the command side of such a sandbox gets when neither its
 * Environment nor its machine names limits: the container backend's own
 * default, named so the Allocation reserves it and the container is given
 * it (ADR 0332).
 */
export const SEPARATE_COMMANDS_DEFAULT_RESOURCES = {
  cpuMillis: 1000,
  memoryMb: 1024,
} as const;

/**
 * Refuse to run an agent's commands apart from it (ADR 0332) on a provider
 * that cannot: placement never asks such a provider, and one asked anyway
 * says so rather than running the commands beside the agent.
 */
export function refuseSeparateCommands(input: {
  separateCommands: CreateSandboxOpts["separateCommands"];
  provider: string;
}): void {
  if (input.separateCommands)
    throw new Error(
      `${input.provider} sandboxes cannot run an agent's commands apart from the agent; place the Environment on a machine whose container backend offers commands.separate`,
    );
}

/**
 * Who the harness runs as on the agent side of a sandbox whose commands
 * run apart, and where (ADR 0332). Work's runner and every operation of
 * Work's run as root there; the harness as this user, which owns none of
 * the checkout (it edits it through the shared group) and can read no
 * grant or runner state: `/workspace/.work-session` is root's alone, and
 * the shim root's to write.
 */
export const SEPARATE_HARNESS = {
  uid: 10001,
  /** The group the checkout shares between both sides. */
  gid: 10001,
  home: "/workspace/.work-harness/home",
  temporary: "/workspace/.work-harness/tmp",
  shim: "/workspace/.work-shim",
  media: "/workspace/.work-harness/media",
  config: "/workspace/.work-harness/config",
} as const;

/**
 * Where a provider offering `commands.separate` serves its command socket
 * inside the agent side of a sandbox (ADR 0332). Nothing on the command
 * side can reach it.
 */
export const SEPARATE_COMMANDS_SOCKET = "/run/work-commands/commands.sock";

/**
 * A directory that persists on the machine across sandboxes (ADR 0208).
 * The control plane names it with {@link volumeKey}, so every sandbox of
 * the same owner, project and volume name sees the same directory.
 */
export interface SandboxVolume {
  /** Machine-unique and filesystem-safe; see {@link volumeKey}. */
  key: string;
  /** Absolute inside the sandbox, or `~/...` under the sandbox user's home. */
  path: string;
  /**
   * One sandbox at a time (a Docker data root, a database). Providers that
   * need a block device for that give it one, sized by `sizeMb`.
   */
  exclusive?: boolean;
  sizeMb?: number;
  /**
   * An empty volume removed with the sandbox: the persistent one is held
   * by another sandbox of the same owner.
   */
  temporary?: boolean;
  /**
   * Mounted read only (ADR 0334): a cache generation only a trusted fill
   * writes. Needs the `caches` capability; a provider that cannot enforce
   * it refuses. Mounting a cache generation read only lets the provider
   * remove that cache's older generations no sandbox mounts.
   */
  readOnly?: boolean;
  /**
   * Other generations of the same cache to remove once no sandbox mounts
   * them (ADR 0334): those that are neither published nor being filled.
   * The control plane names them; a provider removes only keys of the same
   * cache, never one it mounts here.
   */
  retire?: readonly string[];
}

/** Volume names an Environment may declare (ADR 0208). */
export const VOLUME_NAME_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}$/;

/**
 * The machine-unique key of one owner's volume in one project (ADR 0208):
 * readable name, then a digest of what identifies it.
 */
export function volumeKey(input: {
  projectId: string;
  /** A member's id, or the project principal for the project's own chats. */
  owner: string;
  name: string;
}): string {
  if (!VOLUME_NAME_PATTERN.test(input.name))
    throw new Error(`'${input.name}' is not a volume name`);
  const digest = createHash("sha256")
    .update(`${input.projectId}\0${input.owner}\0${input.name}`)
    .digest("hex")
    .slice(0, 24);
  return `${input.name}-${digest}`;
}

/** Keys {@link volumeKey} produces, for providers checking what they are handed. */
export const VOLUME_KEY_PATTERN = /^[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{24}$/;

/**
 * One generation of a project's Environment cache on a machine (ADR 0334):
 * `cache-<name>-<digest>-g<generation>`. Every generation of one cache
 * shares the part before `-g` (its family), so a provider can tell which
 * of its volumes an older generation of the same cache is.
 */
export function cacheVolumeKey(input: {
  projectId: string;
  environment: string;
  name: string;
  generation: number;
}): string {
  if (!VOLUME_NAME_PATTERN.test(input.name))
    throw new Error(`'${input.name}' is not a cache name`);
  if (!Number.isSafeInteger(input.generation) || input.generation < 1)
    throw new Error(`'${input.generation}' is not a cache generation`);
  const digest = createHash("sha256")
    .update(`cache\0${input.projectId}\0${input.environment}\0${input.name}`)
    .digest("hex")
    .slice(0, 24);
  return `cache-${input.name}-${digest}-g${input.generation}`;
}

/** Keys {@link cacheVolumeKey} produces. */
export const CACHE_VOLUME_KEY_PATTERN =
  /^cache-[a-z0-9][a-z0-9-]{0,39}-[0-9a-f]{24}-g[1-9][0-9]{0,15}$/;

/** A key any volume of a sandbox may have: a volume's or a cache generation's. */
export const SANDBOX_VOLUME_KEY_PATTERN = new RegExp(
  `${VOLUME_KEY_PATTERN.source}|${CACHE_VOLUME_KEY_PATTERN.source}`,
);

/** A cache generation's family and number, or undefined for another key. */
export function parseCacheVolumeKey(
  key: string,
): { family: string; generation: number } | undefined {
  if (!CACHE_VOLUME_KEY_PATTERN.test(key)) return undefined;
  const at = key.lastIndexOf("-g");
  return {
    family: key.slice(0, at),
    generation: Number(key.slice(at + 2)),
  };
}

/**
 * A provider's volumes on its machine (ADR 0208): forgotten when unused for
 * long, and all removed when a pooled machine is reset (ADR 0205).
 */
export interface SandboxVolumeProvider {
  /** Remove volumes no sandbox mounted for `unusedForMs`; returns their keys. */
  prune(args: { unusedForMs: number }): Promise<string[]>;
  /**
   * Remove every volume on this machine. A volume a sandbox still mounts
   * is kept, and the call fails naming it, unless `destroySandboxes` asks
   * to remove every sandbox of this provider first (a pooled machine's
   * reset, which owes the next person nothing of the last).
   */
  removeAll(args?: { destroySandboxes?: boolean }): Promise<void>;
}

/**
 * A harness a member signs in to on a machine with its own flow (ADR 0199).
 * Only Codex: Claude Code subscriptions run only on the member's own
 * computer (ADR 0213).
 */
export type SignInHarness = "codex";

export const SIGN_IN_HARNESSES: readonly SignInHarness[] = ["codex"];

/** Where a sandbox sees its owner's sign-in for a harness (ADR 0199). */
export function signInHomePath(input: {
  workspaceRoot: string;
  harness: SignInHarness;
}): string {
  return `${input.workspaceRoot}/.work-sign-in/${input.harness}`;
}

/**
 * The machine capability saying a member is signed in to a harness on it
 * (ADR 0199). Machines report only this fact, never a credential.
 */
export function signInCapability(input: {
  harness: SignInHarness;
  member: string;
}): string {
  return `sign-in:${input.harness}:${input.member}`;
}

export interface ExecOpts {
  /** Where in a sandbox that runs commands apart (ADR 0332); `commands` by default. */
  side?: SandboxSide;
  cwd?: string;
  /** Seconds. */
  timeout?: number;
  env?: Record<string, string>;
  /** Cancels the command; providers stop its whole process tree. */
  signal?: AbortSignal;
}

export interface ExecResult {
  exitCode: number;
  result: string;
}

export interface GitCloneOpts {
  branch?: string;
  commitId?: string;
  username?: string;
  password?: string;
}

export interface SandboxProvider {
  /**
   * Absolute directory inside the sandbox where provider-agnostic callers
   * should upload project files / run commands. Each provider's image
   * convention wins (`/workspace` for every built-in provider).
   */
  readonly workspaceRoot: string;
  readonly isolation?: "none" | "process" | "sandbox";
  readonly resourceLimits?: readonly (keyof SandboxResources)[];
  /**
   * What each sandbox can be given beyond commands (ADR 0176): images,
   * image builds, a container runtime, an enforced egress policy. A provider
   * refuses create options that need a capability it does not list.
   */
  readonly capabilities?: readonly SandboxCapability[];

  createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle>;
  startSandbox(sandboxId: string): Promise<void>;
  stopSandbox(sandboxId: string): Promise<void>;
  destroySandbox(sandboxId: string): Promise<void>;
  getSandboxStatus(sandboxId: string): Promise<SandboxStatus>;
  executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult>;
  uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
    opts?: SandboxFileOpts,
  ): Promise<void>;
  downloadFile(
    sandboxId: string,
    filePath: string,
    opts?: SandboxFileOpts,
  ): Promise<string>;
  gitClone(
    sandboxId: string,
    url: string,
    path: string,
    opts?: GitCloneOpts,
  ): Promise<void>;
  gitCheckout(sandboxId: string, path: string, ref: string): Promise<void>;

  /**
   * Widen a running sandbox's egress for one setup (ADR 0257), where the
   * provider lists `network.setup`. `id` names this widening, and `until`
   * (an ISO time) is when the provider itself returns the sandbox to the
   * policy it was created with, whoever asks or not, so a controller that
   * dies cannot leave it wide. A widening whose `id` already ended, or
   * whose `until` has passed, is refused. Every switch closes every
   * connection open through the sandbox.
   */
  widenEgress?(args: {
    sandboxId: string;
    egress: SandboxEgress;
    id: string;
    until: string;
  }): Promise<void>;
  /**
   * Return a sandbox to the policy it was created with, closing every
   * connection open through it, and remember `id` as ended, so a widening
   * still on its way is refused when it arrives. A sandbox that is not
   * wide stays as it is. Narrowing is always safe to ask for.
   */
  narrowEgress?(args: { sandboxId: string; id: string }): Promise<void>;

  /**
   * Optional warm deployment-runtime capability. Existing providers can omit
   * it and continue using command-based execution.
   */
  readonly deploymentRuntime?: DeploymentRuntimeProvider;

  /**
   * Background processes (ADR 0174): start a command, follow its output by
   * byte cursor, signal it. Processes belong to their sandbox and die with
   * it. A provider without it cannot run background commands; callers say
   * so instead of emulating them.
   */
  readonly processes?: SandboxProcessProvider;

  /** Persistent volumes (ADR 0208); present when the provider mounts them. */
  readonly volumes?: SandboxVolumeProvider;

  /**
   * The disk the provider writes to and what it leaves there (ADR 0335);
   * present when it has either.
   */
  readonly disk?: SandboxDiskProvider;
}

/** What a provider tells its machine about disk (ADR 0335). */
export interface SandboxDiskProvider {
  /**
   * Paths on this process's filesystem, one on each filesystem the
   * provider writes to (its state, Docker's data root), that this process
   * can measure. The machine adds its own data folder.
   */
  paths(): Promise<readonly string[]>;
  /**
   * Remove what the provider left that nothing has used for `graceMs`:
   * images it built or pulled, build cache, dangling images and build
   * cache inside sandboxes with containers. Never anything a sandbox
   * still uses, a volume, or a tagged image inside a sandbox. Answers what
   * went, in words, for the machine's log.
   */
  clean?(args: { graceMs: number }): Promise<string[]>;
}

export type DeploymentRuntimeStatus =
  | "starting"
  | "healthy"
  | "stopped"
  | "error";

export interface DeploymentRuntime {
  runtimeId: string;
  sandboxId: string;
  deploymentArtifactId: string;
  artifactDigest: string;
  transformVersion: string;
  runtimeVersion: string;
  generation: string;
  status: DeploymentRuntimeStatus;
}

export interface EnsureDeploymentRuntimeArgs extends RuntimeArtifactIdentity {
  sandboxId: string;
  workingDirectory: string;
  maxConcurrency?: number;
  env?: Record<string, string>;
}

export type RuntimeInvocation = RuntimeInvocationRequest & {
  runtimeId: string;
  eventSink?: RuntimeInvocationEventSink;
  signal?: AbortSignal;
};

/**
 * A runtime handoff or provider failure, distinct from a terminal result
 * produced by workflow code. Retrying may execute external effects again, so
 * workflow and batch effects remain at-least-once and must be idempotent.
 */
export class RuntimeInfrastructureError extends Error {
  constructor(args: { operation: string; cause: unknown }) {
    super(
      `Runtime infrastructure failed during ${args.operation}: ${errorMessage(args.cause)}`,
      { cause: args.cause },
    );
    this.name = "RuntimeInfrastructureError";
  }
}

export interface RuntimeInvocationEventBatch {
  runtimeId: string;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
}

export interface RuntimeInvocationEventSink {
  report(args: RuntimeInvocationEventBatch): Promise<void>;
}

export class RuntimeEventReportingError extends RuntimeInfrastructureError {
  constructor(args: { invocationId: string; cause: unknown }) {
    super({
      operation: `event reporting for invocation '${args.invocationId}'`,
      cause: args.cause,
    });
    this.name = "RuntimeEventReportingError";
  }
}

export interface RuntimeInvocationReceipt {
  runtimeId: string;
  invocationId: string;
  events: readonly RuntimeInvocationEvent[];
  terminal: RuntimeTerminalResult;
}

export interface CancelRuntimeInvocationArgs {
  runtimeId: string;
  invocationId: string;
}

export interface GetRuntimeHealthArgs {
  runtimeId: string;
}

export interface RuntimeHealth extends RuntimeSupervisorHealth {
  runtimeId: string;
  runtimeStatus: DeploymentRuntimeStatus;
}

export interface DeploymentRuntimeProvider {
  /** Release host-side runtime resources after a sandbox stops or is destroyed. */
  releaseSandbox?(args: { sandboxId: string }): Promise<void>;
  ensureRuntime(args: EnsureDeploymentRuntimeArgs): Promise<DeploymentRuntime>;
  /**
   * Uses invocationId for supervisor deduplication. A caller that cannot
   * recover the original receipt may retry execution with a new invocationId;
   * external effects are therefore delivered at least once.
   */
  invoke(args: RuntimeInvocation): Promise<RuntimeInvocationReceipt>;
  cancel(args: CancelRuntimeInvocationArgs): Promise<void>;
  getHealth(args: GetRuntimeHealthArgs): Promise<RuntimeHealth>;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export type {
  RuntimeArtifactIdentity,
  RuntimeBatchStepSuspension,
  RuntimeInvocationEvent,
  RuntimeInvocationEventsResponse,
  RuntimeInvocationRequest,
  RuntimeStepEntry,
  RuntimeTerminalResult,
};

/**
 * Instruction for populating a sandbox's project directory via `git clone`
 * from a real git remote (e.g. Cloudflare Artifacts) instead of uploading
 * files from the host. Produced by remote backends that expose
 * `getCloneSource` (see `@catamorphic/git`).
 */
export interface CloneSource {
  url: string;
  username?: string;
  password?: string;
  branch?: string;
  /** Commit to check out after cloning (exec sandboxes pin to a SHA). */
  commitSha?: string;
}

export interface SandboxManager {
  ensureExecSandbox(opts: {
    projectId: string;
    commitSha: string;
    /** When set, freshly created sandboxes clone the project from git. */
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle>;

  ensureDevSandbox(opts: {
    projectId: string;
    userId: string;
    /** When set, freshly created sandboxes clone the project from git. */
    cloneSource?: CloneSource;
  }): Promise<SandboxHandle>;

  releaseSandbox(sandboxId: string): Promise<void>;
}

export interface RunResult {
  status: "completed" | "failed";
  result?: unknown;
  error?: string;
  steps: StepEntry[];
}

export interface StepEntry {
  nodeId: string;
  occurrence?: number;
  name: string;
  status: "completed" | "failed" | "skipped";
  attempt?: number;
  input?: unknown;
  output?: unknown;
  error?: string;
  startedAt: string;
  completedAt: string;
}

/**
 * Plugin package materialized for run-time upload. `files` maps paths
 * relative to the package root (e.g. `package.json`, `dist/index.js`) to
 * their UTF-8 contents.
 */
export interface RunPluginPayload {
  packageName: string;
  files: Record<string, string>;
}

export interface AgentQuestionOption {
  /** Concise display label (1-5 words). */
  label: string;
  /** Explanation of what this option means or implies. */
  description: string;
}

export interface AgentQuestion {
  /** The complete question, e.g. "Which library should we use?" */
  question: string;
  /** Very short chip/tag label (max ~12 chars), e.g. "Auth method". */
  header: string;
  /** Whether multiple options may be selected. */
  multiSelect: boolean;
  options: AgentQuestionOption[];
}

/**
 * Classified failure category on "error" events. Drives recovery UX:
 * `auth` offers a re-connect path, `rate_limit`/`unavailable` explain a
 * provider outage (retry requires a separate safety signal), `model_incompat` (e.g. reasoning blocks signed by another
 * model after a mid-conversation switch) retries with sanitized history.
 * `agent_missing`: the chat's agent no longer exists, so the person
 * chooses another to continue. Unclassified errors just offer a manual retry.
 */
export type AgentErrorKind =
  | "auth"
  | "rate_limit"
  | "unavailable"
  | "model_incompat"
  | "agent_missing";

/**
 * Per-turn token/cost accounting reported by a harness (ADR 0057). All
 * fields optional: each harness fills what its stream actually reports.
 * Counters are for the whole turn; `contextTokens`/`contextWindow` describe
 * the session's context occupancy after the turn.
 */
export interface AgentTurnUsage {
  /** Model that served the turn (the dominant one when several did). */
  model?: string;
  /** Uncached input tokens (never includes the cached portion). */
  inputTokens?: number;
  /** Cache-read input tokens. */
  cachedInputTokens?: number;
  /** Cache-write (creation) input tokens. */
  cacheCreationTokens?: number;
  outputTokens?: number;
  /** Subset of outputTokens; informational, never added to totals. */
  reasoningTokens?: number;
  /** Harness-reported cost in USD, when the harness computes one. */
  costUsd?: number;
  /** Tokens currently occupying the session's context window. */
  contextTokens?: number;
  /** The serving model's context window size, when reported. */
  contextWindow?: number;
}

/** Coerces a reported token counter to a usable count: a finite number > 0 truncated to an integer, anything else 0. */
export function positiveTokenCount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0
    ? Math.trunc(value)
    : 0;
}
