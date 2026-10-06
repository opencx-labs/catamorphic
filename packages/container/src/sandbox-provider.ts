import { createHash, randomUUID } from "node:crypto";
import fs from "node:fs";
import net from "node:net";
import path from "node:path";
import type {
  CreateSandboxOpts,
  DeploymentRuntimeProvider,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  SandboxCapability,
  SandboxHandle,
  SandboxProcessProvider,
  SandboxProvider,
  SandboxStatus,
  SandboxVolumeProvider,
  SupervisorProcessHandle,
} from "@catamorphic/sandbox";
import {
  assertSandboxResources,
  assertSandboxVolumes,
  dockerfileImageReference,
  gitCloneFailure,
  gitCloneUrl,
  imageUserHome,
  machineSignInHome,
  SANDBOX_CAPABILITIES,
  StdioDeploymentRuntimeProvider,
  shellSandboxProcesses,
  signInHomePath,
  VOLUME_KEY_PATTERN,
  VolumeUsageLog,
  volumeMountPath,
} from "@catamorphic/sandbox";
import {
  APP_DATA_ENV,
  APP_DATA_MOUNT,
} from "@catamorphic/workflow/project-layout";
import { DockerApiError, DockerClient } from "./docker-client.js";
import {
  type EgressLookup,
  type EgressPolicy,
  type EgressProxy,
  FORWARDER_SOURCE,
  startEgressProxy,
} from "./egress-proxy.js";
import { type HostPathOf, hostPathResolver } from "./host-paths.js";
import type { ContainerRuntime } from "./support.js";
import { tarArchive } from "./tar.js";

const DEFAULT_IMAGE = "oven/bun";
const DEFAULT_MEMORY_MB = 1024;
const DEFAULT_CPU_MILLIS = 1000;
/** Processes one sandbox may run at once: a fork bomb stays in its sandbox. */
const DEFAULT_PIDS_LIMIT = 4096;
const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

/** Every sandbox container carries it; its value is always `1`. */
export const SANDBOX_LABEL = "work.sandbox";
/**
 * Which provider made a container or volume: a digest of its state
 * directory, so two providers sharing one daemon (a server and a worker on
 * one machine) never reclaim or remove each other's.
 */
const OWNER_LABEL = "work.sandbox.owner";
/**
 * The bridge network open sandboxes join, created on demand: containers on
 * it cannot reach each other (inter-container traffic is off), so open
 * sandboxes of different people on one machine stay apart (ADR 0204).
 */
export const SANDBOX_NETWORK = "work-sandboxes";
const NETWORK_LABEL = "work.network";
const NO_ICC = "com.docker.network.bridge.enable_icc";
/** Docker's own fallback when the machine names only local resolvers. */
const FALLBACK_NAMESERVERS = ["8.8.8.8", "8.8.4.4"];
/** The sandbox's egress proxy policy, as JSON; absent when it has none. */
const EGRESS_LABEL = "work.sandbox.egress";
/** Present when the sandbox runs its own Docker daemon. */
const CONTAINERS_LABEL = "work.sandbox.containers";
/** The persistent volumes it mounts, comma-separated keys. */
const VOLUMES_LABEL = "work.sandbox.volumes";
/** Names a Docker volume as one of this machine's sandbox volumes. */
export const VOLUME_LABEL = "work.volume";
const VOLUME_PREFIX = "work-volume-";

/** Where a sandbox sees its proxy's socket and forwarder. */
const PROXY_MOUNT = "/run/work";
const PROXY_PORT = 3128;
/** Process state of tracked commands, inside the sandbox. */
const EXEC_STATE = "/tmp/.work-exec";

/** The same preparation microsandbox runs (git, bash, Bun or Node 20+). */
const DEFAULT_SETUP_COMMAND =
  "{ command -v git && command -v bash && { command -v bun || command -v node; }; } >/dev/null 2>&1 || " +
  "if command -v apt-get >/dev/null 2>&1; then " +
  "apt-get update -qq && apt-get install -y -qq git bash && " +
  "{ command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || apt-get install -y -qq nodejs; }; " +
  "elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q git bash && " +
  "{ command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || apk add --no-cache -q nodejs; }; " +
  "else echo 'The image has neither git nor a known package manager' >&2; exit 1; fi; " +
  "command -v bun >/dev/null 2>&1 || node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)' || " +
  "{ echo 'The agent runner needs Bun, or Node 20 or later, and this image has an older Node: use an image with Bun or Node 20+' >&2; exit 1; }";

/**
 * Runs a command in its own process group and records the group, so a
 * timeout or cancellation stops everything it started. A command that ends
 * normally leaves what it detached running, as on microsandbox: stopping
 * its group then would race with children still on their way into a
 * session of their own (`setsid`), which is how background processes
 * start. Arguments: a token naming the record, the working directory, then
 * the command's argv.
 */
const TRACKED = [
  't="$1"; d="$2"; shift 2',
  `mkdir -p -m 1777 ${EXEC_STATE} 2>/dev/null`,
  'if [ -n "$d" ]; then mkdir -p "$d" 2>/dev/null; cd "$d" || exit 1; fi',
  "exec 3<&0",
  "if command -v setsid >/dev/null 2>&1; then",
  '  setsid "$@" <&3 3<&- &',
  "else",
  "  set -m",
  '  "$@" <&3 3<&- &',
  "fi",
  "p=$!",
  `echo "$p" > "${EXEC_STATE}/$t" 2>/dev/null`,
  'wait "$p"; s=$?',
  `rm -f "${EXEC_STATE}/$t"`,
  'exit "$s"',
].join("\n");

/** Stops a tracked command's process group (it may not have recorded it yet). */
const KILL_TRACKED = [
  `f="${EXEC_STATE}/$1"`,
  'i=0; while [ ! -s "$f" ] && [ $i -lt 50 ]; do sleep 0.1; i=$((i+1)); done',
  'p=$(cat "$f" 2>/dev/null)',
  '[ -n "$p" ] && kill -9 -"$p" 2>/dev/null',
  "exit 0",
].join("\n");

export interface ContainerProviderConfig {
  /**
   * The Docker Engine API; `/var/run/docker.sock` by default. Hosts pass
   * a client for `DOCKER_HOST` (see `dockerEndpoint`).
   */
  docker?: DockerClient;
  /**
   * The runtime every sandbox runs under, as {@link probeContainerSupport}
   * found it: gVisor (`runsc`, isolation `sandbox`) or runc (`process`).
   */
  runtime: ContainerRuntime;
  /**
   * The provider's own state on this machine: egress sockets and volume
   * usage. Its sockets are bind-mounted, so it must be on the machine's
   * disk (or a mount from it) when the worker runs in a container.
   */
  stateDirectory: string;
  /** Image when an Environment names none. Default `oven/bun`. */
  image?: string;
  /** Default limits per sandbox: one core and 1024 MiB. */
  cpuMillis?: number;
  memoryMb?: number;
  /** Processes one sandbox may run at once; 4096 by default. */
  pidsLimit?: number;
  namePrefix?: string;
  /**
   * Shell command run once, as root, in every new sandbox before it is
   * handed over: microsandbox's default (git, bash, Bun or Node). An
   * empty string disables it.
   */
  setupCommand?: string;
  /** Build project Dockerfiles with the daemon (ADR 0176). Default on. */
  imageBuild?: boolean;
  /** Offer nested containers where the runtime supports them. Default on. */
  containers?: boolean;
  /**
   * Under runc, nested Docker needs a privileged container, which the
   * operator must accept explicitly. gVisor needs no such thing. A
   * privileged container can leave its network namespace and reach the
   * machine, so a machine that runs them does not enforce egress policies.
   */
  privilegedContainers?: boolean;
  /**
   * Name servers for sandboxes on the sandbox network. By default those
   * of this process's own `/etc/resolv.conf` that are not local, else
   * Docker's own fallback.
   */
  nameservers?: readonly string[];
  /** Members' own sign-ins on this machine (ADR 0199); see microsandbox. */
  signInRoot?: string;
  /** Host-owned persistent data for a project's deployment runtimes. */
  projectDataDirectory?: (input: {
    projectId: string;
  }) => Promise<string | undefined>;
  /**
   * How mount sources name this process's files on the daemon's machine.
   * Found by inspecting the worker's own container when it runs in one.
   */
  hostPathOf?: HostPathOf;
  /** Name resolution for egress proxies; the system resolver by default. */
  lookup?: EgressLookup;
  /** Machine log lines: refused egress, for example. */
  log?: (line: string) => void;
}

/** What the provider knows about one sandbox, rebuilt from its labels. */
interface SandboxRecord {
  proxy?: EgressPolicy;
  containers: boolean;
  volumes: string[];
  /** Whether this process saw it running and started what it needs. */
  ready: boolean;
}

/**
 * Sandboxes as OCI containers through the Docker Engine API (ADR 0204):
 * one long-running container per sandbox under gVisor or runc, with the
 * workspace on a Docker volume of its own. It offers images and
 * Dockerfile builds, CPU and memory limits, members' sign-ins, volumes,
 * background processes, egress policy through a proxy on a mounted socket,
 * and nested Docker run by the image's own daemon.
 */
export class ContainerSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly isolation: "process" | "sandbox";
  readonly resourceLimits = ["cpuMillis", "memoryMb"] as const;
  readonly capabilities: readonly SandboxCapability[];
  readonly deploymentRuntime: DeploymentRuntimeProvider;
  /**
   * Background processes (ADR 0174) run inside the container in their own
   * session; their output and state live there, so they end with it.
   */
  readonly processes: SandboxProcessProvider = shellSandboxProcesses({
    executeCommand: (sandboxId, command, opts) =>
      this.executeCommand(sandboxId, command, opts),
    workspaceRoot: this.workspaceRoot,
  });
  /** Docker volumes named for their keys (ADR 0208). */
  readonly volumes: SandboxVolumeProvider = {
    prune: (args) => this.pruneVolumes(args),
    removeAll: (args) => this.removeAllVolumes(args),
  };

  private readonly docker: DockerClient;
  private readonly config: ContainerProviderConfig;
  private readonly usage: VolumeUsageLog;
  private readonly creations: CreationRegistry;
  private readonly owner: string;
  private readonly records = new Map<string, SandboxRecord>();
  private readonly proxies = new Map<string, Promise<EgressProxy>>();
  private readonly images = new Map<string, Promise<void>>();
  private hostPaths: Promise<HostPathOf> | undefined;
  private network: Promise<void> | undefined;
  /** Sandboxes an earlier process left half made, removed once (see {@link reclaim}). */
  private readonly reclaimed: Promise<void>;
  /** Whether egress through a mounted socket can be enforced here. */
  private readonly hostSockets: boolean;
  private readonly nested: boolean;

  constructor(config: ContainerProviderConfig) {
    this.config = config;
    this.docker = config.docker ?? new DockerClient();
    this.usage = new VolumeUsageLog(
      path.join(config.stateDirectory, "volumes.json"),
    );
    this.creations = new CreationRegistry(
      path.join(config.stateDirectory, "creating.json"),
    );
    this.owner = createHash("sha256")
      .update(path.resolve(config.stateDirectory))
      .digest("hex")
      .slice(0, 16);
    const runtime = config.runtime;
    this.isolation = runtime.kind === "runsc" ? "sandbox" : "process";
    // A privileged runc container can leave its network namespace.
    this.hostSockets =
      runtime.kind === "runc"
        ? !config.privilegedContainers
        : runtime.hostSockets;
    this.nested =
      (config.containers ?? true) &&
      (runtime.kind === "runsc"
        ? runtime.netRaw
        : Boolean(config.privilegedContainers));
    this.capabilities = [
      SANDBOX_CAPABILITIES.images,
      ...((config.imageBuild ?? true) ? [SANDBOX_CAPABILITIES.imageBuild] : []),
      ...(this.hostSockets ? [SANDBOX_CAPABILITIES.egressPolicy] : []),
      ...(this.nested ? [SANDBOX_CAPABILITIES.containers] : []),
      SANDBOX_CAPABILITIES.volumes,
    ];
    this.deploymentRuntime = new StdioDeploymentRuntimeProvider({
      uploadFiles: (sandboxId, files, basePath) =>
        this.uploadFiles(sandboxId, files, basePath),
      mkdirp: async (sandboxId, directory) => {
        const made = await this.execRunning(sandboxId, {
          cmd: ["mkdir", "-p", directory],
        });
        if (made.exitCode !== 0)
          throw new Error(`mkdir ${directory} failed: ${made.stderr}`);
      },
      openSupervisor: (args) => this.openSupervisor(args),
    });
    this.reclaimed = this.reclaim().catch((error: unknown) =>
      config.log?.(
        `Removing sandboxes an earlier worker left half made failed: ${error instanceof Error ? error.message : String(error)}`,
      ),
    );
  }

  /**
   * Remove sandboxes whose creation never finished: the process creating
   * them died before handing them over, so nothing will ever destroy them
   * and they would hold their volumes forever. Their anonymous volumes
   * (workspace, temporary volumes) go with them.
   */
  private async reclaim(): Promise<void> {
    for (const id of this.creations.abandoned()) {
      await this.docker.removeContainer(id);
      await this.closeProxy(id);
      fs.rmSync(this.egressDirectory(id), { recursive: true, force: true });
      this.creations.end(id);
      this.config.log?.(`Removed sandbox ${id}, left half made`);
    }
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    if (opts.resources?.storageMb !== undefined)
      throw new Error(
        "The container backend cannot limit a sandbox's disk ('storageMb'); place the Environment on a machine that does, or remove the limit",
      );
    assertSandboxResources(opts.resources, this.resourceLimits);
    if (opts.containers && !this.nested)
      throw new Error(
        this.config.runtime.kind === "runsc"
          ? "This machine's gVisor runtime has no --net-raw, so its sandboxes cannot run containers"
          : "This machine runs containers in sandboxes only when its operator accepts privileged containers (WORK_CONTAINER_PRIVILEGED=1)",
      );
    const restricted = opts.egress?.mode === "allowlist";
    if (restricted && !this.hostSockets)
      throw new Error(
        this.config.runtime.kind === "runsc"
          ? "This machine's gVisor runtime cannot open host sockets (--host-uds=open), so it cannot enforce an egress policy"
          : "This machine runs privileged containers, which can leave their network, so it cannot enforce an egress policy",
      );
    assertSandboxVolumes(opts.volumes);
    const signIns = this.signInMounts(opts);
    await this.reclaimed;
    const image = await this.imageFor(opts);
    const inspected = await this.docker.inspectImage(image);
    const imageConfig = objectField(inspected, "Config");
    const user = typeof imageConfig.User === "string" ? imageConfig.User : "";
    const home = imageUserHome({ user, env: stringList(imageConfig.Env) });
    const volumes = (opts.volumes ?? []).map((volume) => ({
      ...volume,
      target: volumeMountPath({ path: volume.path, home }),
    }));
    // `~/x` and `/root/x` are one place once the home is known.
    assertSandboxVolumes(
      volumes.map((volume) => ({ ...volume, path: volume.target })),
    );
    const hostPathOf = await this.hostPathOf();
    if (!restricted) await this.ensureNetwork();
    const id = `${this.config.namePrefix ?? "work"}-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
    // Nested containers under gVisor have no route but the proxy, so an
    // open sandbox that runs containers gets one that admits anything.
    const proxy: EgressPolicy | undefined =
      opts.egress?.mode === "allowlist"
        ? { allow: opts.egress.allow }
        : opts.containers &&
            this.config.runtime.kind === "runsc" &&
            this.hostSockets
          ? { any: true }
          : undefined;
    const persistent = volumes.filter((volume) => !volume.temporary);
    for (const volume of persistent)
      await this.docker.createVolume({
        name: `${VOLUME_PREFIX}${volume.key}`,
        labels: { [VOLUME_LABEL]: volume.key, [OWNER_LABEL]: this.owner },
      });
    this.usage.touch(persistent.map((volume) => volume.key));
    const dataDirectory =
      opts.labels?.purpose === "deployment-runtime" && opts.labels.projectId
        ? await this.config.projectDataDirectory?.({
            projectId: opts.labels.projectId,
          })
        : undefined;
    const env: Record<string, string> = {
      ...opts.envVars,
      ...(dataDirectory ? { [APP_DATA_ENV]: APP_DATA_MOUNT } : {}),
      ...(restricted ? PROXY_ENV : {}),
    };
    const mounts: unknown[] = [
      // The workspace is a volume of the container's own, removed with it:
      // gVisor's root filesystem does not survive a restart.
      { Type: "volume", Target: this.workspaceRoot },
      ...volumes.map((volume) => ({
        Type: "volume",
        Target: volume.target,
        ...(volume.temporary
          ? {}
          : { Source: `${VOLUME_PREFIX}${volume.key}` }),
      })),
      ...signIns.map((signIn) => ({
        Type: "bind",
        Source: hostPathOf(signIn.host),
        Target: signIn.guest,
      })),
      ...(dataDirectory
        ? [
            {
              Type: "bind",
              Source: hostPathOf(dataDirectory),
              Target: APP_DATA_MOUNT,
            },
          ]
        : []),
      ...(proxy
        ? [
            {
              Type: "bind",
              Source: hostPathOf(this.egressDirectory(id)),
              Target: PROXY_MOUNT,
              ReadOnly: true,
            },
          ]
        : []),
      // The sandbox network's own resolver may not answer inside gVisor;
      // sandboxes ask the machine's name servers, as on Docker's bridge.
      ...(restricted
        ? []
        : [
            {
              Type: "bind",
              Source: hostPathOf(this.resolvConf()),
              Target: "/etc/resolv.conf",
              ReadOnly: true,
            },
          ]),
    ];
    const cpuMillis =
      opts.resources?.cpuMillis ?? this.config.cpuMillis ?? DEFAULT_CPU_MILLIS;
    const memoryMb =
      opts.resources?.memoryMb ?? this.config.memoryMb ?? DEFAULT_MEMORY_MB;
    const runtime = this.config.runtime;
    const labels: Record<string, string> = {
      ...opts.labels,
      [SANDBOX_LABEL]: "1",
      [OWNER_LABEL]: this.owner,
      ...(proxy ? { [EGRESS_LABEL]: JSON.stringify(proxy) } : {}),
      ...(opts.containers ? { [CONTAINERS_LABEL]: "1" } : {}),
      ...(persistent.length > 0
        ? { [VOLUMES_LABEL]: persistent.map((volume) => volume.key).join(",") }
        : {}),
    };
    const record: SandboxRecord = {
      ...(proxy ? { proxy } : {}),
      containers: Boolean(opts.containers),
      volumes: persistent.map((volume) => volume.key),
      ready: false,
    };
    // Recorded before the container exists: a process that dies before it
    // hands the sandbox over leaves a record the next one reclaims.
    this.creations.begin(id);
    try {
      if (proxy) await this.ensureProxy(id, proxy);
      await this.docker.createContainer({
        name: id,
        body: {
          Image: image,
          // The sandbox stays up until stopped; tini reaps what commands
          // leave behind and forwards the stop signal.
          Entrypoint: ["sleep"],
          Cmd: ["infinity"],
          WorkingDir: this.workspaceRoot,
          Env: Object.entries(env).map(([name, value]) => `${name}=${value}`),
          Labels: labels,
          HostConfig: {
            ...(runtime.name ? { Runtime: runtime.name } : {}),
            Init: true,
            NanoCpus: cpuMillis * 1_000_000,
            Memory: memoryMb * 1024 * 1024,
            MemorySwap: memoryMb * 1024 * 1024,
            PidsLimit: this.config.pidsLimit ?? DEFAULT_PIDS_LIMIT,
            NetworkMode: restricted ? "none" : SANDBOX_NETWORK,
            Mounts: mounts,
            ...(opts.containers
              ? runtime.kind === "runsc"
                ? { CapAdd: ["ALL"] }
                : { Privileged: true }
              : {}),
          },
        },
      });
      this.records.set(id, record);
      await this.docker.startContainer(id);
      await this.prepare({ id, record, fresh: true });
    } catch (error) {
      // One that cannot be removed now stays recorded, for reclaiming.
      await this.destroySandbox(id).catch(() => {});
      throw error;
    }
    this.creations.end(id);
    return { id, providerId: id, sandboxType: "execution", status: "started" };
  }

  /**
   * The network open sandboxes join (see {@link SANDBOX_NETWORK}), made
   * once. One by that name without inter-container traffic off is refused
   * rather than used.
   */
  private ensureNetwork(): Promise<void> {
    this.network ??= (async () => {
      const existing =
        (await this.docker.inspectNetwork(SANDBOX_NETWORK)) ??
        (await this.docker
          .createNetwork({
            name: SANDBOX_NETWORK,
            labels: { [NETWORK_LABEL]: "1" },
            options: { [NO_ICC]: "false" },
          })
          .then(() => this.docker.inspectNetwork(SANDBOX_NETWORK)));
      if (objectField(existing, "Options")[NO_ICC] !== "false")
        throw new Error(
          `The Docker network ${SANDBOX_NETWORK} lets its containers reach each other; remove it (docker network rm ${SANDBOX_NETWORK}) and Work makes it again with that traffic off`,
        );
    })().catch((error: unknown) => {
      this.network = undefined;
      throw error;
    });
    return this.network;
  }

  /**
   * The resolver configuration open sandboxes read: the machine's name
   * servers that are not local (a stub resolver on loopback, such as
   * systemd-resolved's, answers nowhere else, so its upstream file is read
   * next), or Docker's own fallback.
   */
  private resolvConf(): string {
    const file = path.join(this.config.stateDirectory, "resolv.conf");
    const nameservers =
      this.config.nameservers ??
      ["/etc/resolv.conf", "/run/systemd/resolve/resolv.conf"]
        .map(remoteNameservers)
        .find((found) => found.length > 0) ??
      FALLBACK_NAMESERVERS;
    const content = `${nameservers.map((server) => `nameserver ${server}`).join("\n")}\n`;
    fs.mkdirSync(path.dirname(file), { recursive: true });
    if (fs.readFileSync(file, { encoding: "utf8", flag: "a+" }) !== content)
      fs.writeFileSync(file, content, { mode: 0o644 });
    return file;
  }

  /**
   * Start a stopped sandbox and what does not survive a stop. One still
   * running (this process restarted, the sandbox did not) only gets its
   * proxy served again.
   */
  async startSandbox(sandboxId: string): Promise<void> {
    const record = await this.record(sandboxId);
    if (record.proxy) await this.ensureProxy(sandboxId, record.proxy);
    const inspected = await this.docker.inspectContainer(sandboxId);
    if (!inspected) throw new Error(`Sandbox '${sandboxId}' does not exist`);
    if (objectField(inspected, "State").Running !== true) {
      await this.docker.startContainer(sandboxId);
      await this.prepare({ id: sandboxId, record, fresh: false });
    }
    record.ready = true;
    this.usage.touch(record.volumes);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    const record = this.records.get(sandboxId);
    if (record) record.ready = false;
    await this.docker.stopContainer(sandboxId, 5).catch((error: unknown) => {
      if (!(error instanceof DockerApiError && error.status === 404))
        throw error;
    });
    await this.closeProxy(sandboxId);
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  /** Remove the container and its temporary volumes; a missing one is gone already. */
  async destroySandbox(sandboxId: string): Promise<void> {
    this.records.delete(sandboxId);
    await this.docker.removeContainer(sandboxId);
    await this.closeProxy(sandboxId);
    fs.rmSync(this.egressDirectory(sandboxId), {
      recursive: true,
      force: true,
    });
    this.creations.end(sandboxId);
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    const inspected = await this.docker.inspectContainer(sandboxId);
    if (!inspected) throw new Error(`Sandbox '${sandboxId}' does not exist`);
    const state = objectField(inspected, "State");
    switch (state.Status) {
      case "running":
        return "started";
      case "restarting":
        return "creating";
      case "created":
      case "paused":
      case "exited":
        return "stopped";
      default:
        return "error";
    }
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const output = await this.tracked(sandboxId, {
      // bash as on microsandbox; an image without it still runs commands.
      argv: [
        "sh",
        "-c",
        'command -v bash >/dev/null 2>&1 && exec bash -lc "$1"; exec sh -lc "$1"',
        "work-shell",
        command,
      ],
      cwd: opts?.cwd ?? this.workspaceRoot,
      ...(opts?.env ? { env: opts.env } : {}),
      ...(opts?.timeout ? { timeoutSeconds: opts.timeout } : {}),
      ...(opts?.signal ? { signal: opts.signal } : {}),
    });
    const result =
      output.stderr.length > 0
        ? `${output.stdout}${output.stdout ? "\n" : ""}${output.stderr}`
        : output.stdout;
    if (output.ended === "timeout")
      return {
        exitCode: 124,
        result: `${result}\n[container] command timed out after ${opts?.timeout}s`,
      };
    if (output.ended === "cancelled")
      return {
        exitCode: 130,
        result: `${result}\n[container] command was cancelled`,
      };
    return { exitCode: output.exitCode, result };
  }

  /** One `tar -x` of an in-memory archive (Bun cannot half-close, so `head -c` bounds it). */
  async uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    const entries = Object.entries(files);
    if (entries.length === 0) return;
    const archive = tarArchive(
      entries.map(([filePath, content]) => ({ path: filePath, content })),
    );
    const extracted = await this.execRunning(sandboxId, {
      cmd: [
        "sh",
        "-c",
        'mkdir -p "$2" && head -c "$1" | tar -xof - -C "$2"',
        "work-upload",
        String(archive.length),
        basePath || "/",
      ],
      input: archive,
    });
    if (extracted.exitCode !== 0)
      throw new Error(
        `Upload to ${basePath || "/"} failed: ${extracted.stderr}`,
      );
  }

  async downloadFile(sandboxId: string, filePath: string): Promise<string> {
    const read = await this.execRunning(sandboxId, {
      cmd: ["cat", "--", filePath],
    });
    if (read.exitCode !== 0)
      throw new Error(`Reading ${filePath} failed: ${read.stderr.trim()}`);
    return read.stdout;
  }

  async gitClone(
    sandboxId: string,
    url: string,
    clonePath: string,
    opts?: GitCloneOpts,
  ): Promise<void> {
    const cloneUrl = gitCloneUrl(url, opts);
    const branchArg = opts?.branch
      ? ` --branch ${shellQuote(opts.branch)}`
      : "";
    const clone = await this.executeCommand(
      sandboxId,
      `git clone${branchArg} ${shellQuote(cloneUrl)} ${shellQuote(clonePath)}`,
      { timeout: 120 },
    );
    if (clone.exitCode !== 0)
      throw gitCloneFailure({
        output: clone.result,
        ...(opts ? { opts } : {}),
      });
    if (opts?.commitId)
      await this.gitCheckout(sandboxId, clonePath, opts.commitId);
  }

  async gitCheckout(
    sandboxId: string,
    repoPath: string,
    ref: string,
  ): Promise<void> {
    const result = await this.executeCommand(
      sandboxId,
      `git -C ${shellQuote(repoPath)} checkout ${shellQuote(ref)}`,
      { timeout: 60 },
    );
    if (result.exitCode !== 0)
      throw new Error(`git checkout failed: ${result.result}`);
  }

  /**
   * Make a started sandbox ready: its forwarder, the setup command, the
   * workspace and mount points for a non-root image user, and its Docker
   * daemon. A new sandbox runs all of it. A restarted one runs what does
   * not survive a stop: under gVisor the root filesystem starts over from
   * the image (only the workspace and volumes persist), so setup runs again.
   */
  private async prepare(args: {
    id: string;
    record: SandboxRecord;
    fresh: boolean;
  }): Promise<void> {
    const { id, record } = args;
    const inspected = await this.docker.inspectContainer(id);
    if (!inspected) throw new Error(`Sandbox '${id}' does not exist`);
    const config = objectField(inspected, "Config");
    const user = typeof config.User === "string" ? config.User : "";
    const home = imageUserHome({ user, env: stringList(config.Env) });
    const restricted = record.proxy !== undefined && "allow" in record.proxy;
    // A restricted sandbox's setup may reach only what the proxy admits;
    // an open one installs Bun or Node for its forwarder first.
    if (restricted) await this.startForwarder(id);
    const setup = this.config.setupCommand ?? DEFAULT_SETUP_COMMAND;
    if (setup && (args.fresh || this.config.runtime.kind === "runsc")) {
      const prepared = await this.exec(id, {
        cmd: ["sh", "-c", setup],
        user: "0",
        timeoutSeconds: 300,
      });
      if (prepared.exitCode !== 0)
        throw new Error(
          `${
            restricted
              ? "Sandbox setup command (egress is restricted, so the image must already have git, bash, and Bun or Node)"
              : "Sandbox setup command"
          } failed: ${prepared.stdout}${prepared.stderr}`,
        );
    }
    if (record.proxy && !restricted) await this.startForwarder(id);
    if (user && !isRoot(user)) {
      // Docker creates volumes (the workspace's included) and the
      // directories leading to them as root; the image's user owns them.
      // Bind mounts (sign-ins, project data) are the machine's own files.
      const volumes = (
        Array.isArray(inspected.Mounts) ? inspected.Mounts : []
      ).flatMap((mount: unknown) => {
        if (typeof mount !== "object" || mount === null) return [];
        const destination = Reflect.get(mount, "Destination");
        return Reflect.get(mount, "Type") === "volume" &&
          typeof destination === "string"
          ? [destination]
          : [];
      });
      const owned = await this.exec(id, {
        cmd: [
          "sh",
          "-c",
          'u="$1"; shift; for d in "$@"; do chown "$u" "$d" 2>/dev/null; done; exit 0',
          "work-own",
          user,
          ...new Set([...volumes, ...parentsWithin(home, volumes)]),
        ],
        user: "0",
      });
      if (owned.exitCode !== 0)
        throw new Error(`Preparing the workspace failed: ${owned.stderr}`);
    }
    if (record.containers) await this.ensureDocker(id, record, home);
    record.ready = true;
  }

  /**
   * The sandbox's way out (ADR 0204): its own Bun or Node pipes
   * `127.0.0.1:3128` to the mounted proxy socket. Nested containers get a
   * second forwarder on their bridge's gateway ({@link ensureDocker}); no
   * forwarder listens on an address other sandboxes reach.
   */
  private async startForwarder(sandboxId: string): Promise<void> {
    const started = await this.exec(sandboxId, {
      cmd: ["sh", "-c", forwarderScript({ listen: "127.0.0.1", name: "lo" })],
      user: "0",
      timeoutSeconds: 60,
    });
    if (started.exitCode !== 0)
      throw new Error(
        `The sandbox's egress forwarder did not start: ${started.stderr || started.stdout}`,
      );
  }

  /**
   * Start the image's Docker daemon unless it answers (ADR 0176). Under
   * gVisor it runs without iptables; when the sandbox has a proxy, the
   * daemon pulls through it, a forwarder listens on the bridge's gateway
   * (that address only), and the Docker CLI hands it to every nested
   * container and build.
   */
  private async ensureDocker(
    sandboxId: string,
    record: SandboxRecord,
    home: string,
  ): Promise<void> {
    const gvisor = this.config.runtime.kind === "runsc";
    const restricted = record.proxy !== undefined && "allow" in record.proxy;
    const script = [
      "if ! docker info >/dev/null 2>&1; then",
      "command -v dockerd >/dev/null 2>&1 || { echo 'This image has no Docker daemon: use an image with Docker (docker:dind, or a Dockerfile FROM it)' >&2; exit 1; }",
      ...(restricted
        ? [
            `export HTTP_PROXY=http://127.0.0.1:${PROXY_PORT} HTTPS_PROXY=http://127.0.0.1:${PROXY_PORT} NO_PROXY=localhost,127.0.0.1,::1`,
          ]
        : []),
      `set -- dockerd${gvisor ? " --iptables=false --ip6tables=false" : ""}`,
      "if command -v setsid >/dev/null 2>&1; then",
      '  setsid "$@" >/var/log/dockerd.log 2>&1 </dev/null &',
      "else",
      '  ("$@" >/var/log/dockerd.log 2>&1 </dev/null &)',
      "fi",
      "i=0; while [ $i -lt 240 ]; do docker info >/dev/null 2>&1 && break; i=$((i+1)); sleep 0.5; done",
      "docker info >/dev/null 2>&1 || { tail -20 /var/log/dockerd.log >&2; exit 1; }",
      "fi",
      ...(record.proxy
        ? [
            // Nested containers reach a forwarder at their gateway.
            "gw=$(docker network inspect bridge --format '{{(index .IPAM.Config 0).Gateway}}' 2>/dev/null)",
            '[ -n "$gw" ] || { echo "The sandbox Docker bridge has no gateway" >&2; exit 1; }',
            `( ${forwarderScript({ listen: '"$gw"', name: "gateway" })} ) || exit 1`,
            `proxy=http://$gw:${PROXY_PORT}`,
            'for h in "$1" /root; do',
            '  [ -f "$h/.docker/config.json" ] && continue',
            '  mkdir -p "$h/.docker"',
            '  printf \'{"proxies":{"default":{"httpProxy":"%s","httpsProxy":"%s","noProxy":"localhost,127.0.0.1,::1"}}}\\n\' "$proxy" "$proxy" > "$h/.docker/config.json"',
            "done",
          ]
        : []),
      "exit 0",
    ].join("\n");
    const started = await this.exec(sandboxId, {
      cmd: ["sh", "-c", script, "work-docker", home],
      user: "0",
      timeoutSeconds: 180,
    });
    if (started.exitCode !== 0)
      throw new Error(
        `The sandbox's container runtime did not start: ${started.stderr || started.stdout}`,
      );
  }

  /** The proxy server for a sandbox, started once per process. */
  private ensureProxy(
    sandboxId: string,
    policy: EgressPolicy,
  ): Promise<EgressProxy> {
    const running = this.proxies.get(sandboxId);
    if (running) return running;
    const directory = this.egressDirectory(sandboxId);
    fs.mkdirSync(directory, { recursive: true, mode: 0o755 });
    fs.writeFileSync(path.join(directory, "forwarder.mjs"), FORWARDER_SOURCE, {
      mode: 0o644,
    });
    const socketPath = path.join(directory, "proxy.sock");
    if (Buffer.byteLength(socketPath) > 100)
      throw new Error(
        `The egress socket path ${socketPath} is too long for a Unix socket; use a shorter data directory`,
      );
    const starting = startEgressProxy({
      socketPath,
      policy,
      ...(this.config.lookup ? { lookup: this.config.lookup } : {}),
      onRefused: (_target, reason) =>
        this.config.log?.(`Sandbox ${sandboxId}: ${reason}`),
    });
    this.proxies.set(sandboxId, starting);
    starting.catch(() => this.proxies.delete(sandboxId));
    return starting;
  }

  private async closeProxy(sandboxId: string): Promise<void> {
    const proxy = this.proxies.get(sandboxId);
    this.proxies.delete(sandboxId);
    await (await proxy?.catch(() => undefined))?.close();
  }

  private egressDirectory(sandboxId: string): string {
    return path.join(this.config.stateDirectory, "egress", sandboxId);
  }

  /** The record of a sandbox, from memory or its container's labels. */
  private async record(sandboxId: string): Promise<SandboxRecord> {
    const known = this.records.get(sandboxId);
    if (known) return known;
    const inspected = await this.docker.inspectContainer(sandboxId);
    if (!inspected) throw new Error(`Sandbox '${sandboxId}' does not exist`);
    const labels = objectField(objectField(inspected, "Config"), "Labels");
    const egress =
      typeof labels[EGRESS_LABEL] === "string"
        ? parsePolicy(labels[EGRESS_LABEL])
        : undefined;
    const record: SandboxRecord = {
      ...(egress ? { proxy: egress } : {}),
      containers: labels[CONTAINERS_LABEL] === "1",
      volumes:
        typeof labels[VOLUMES_LABEL] === "string"
          ? labels[VOLUMES_LABEL].split(",").filter(Boolean)
          : [],
      ready: false,
    };
    this.records.set(sandboxId, record);
    return record;
  }

  /**
   * A sandbox ready for commands: running, with its proxy served. One this
   * process has not seen running (after a restart of the worker) is
   * started as microsandbox boots a stopped VM.
   */
  private async ready(sandboxId: string): Promise<void> {
    if ((await this.record(sandboxId)).ready) return;
    await this.startSandbox(sandboxId);
  }

  /**
   * Run against a sandbox believed ready. One that stopped behind this
   * process's back (the daemon restarted) answers that it is not running:
   * it is started, once, and the call made again.
   */
  private async whileRunning<T>(
    sandboxId: string,
    run: () => Promise<T>,
  ): Promise<T> {
    await this.ready(sandboxId);
    try {
      return await run();
    } catch (error) {
      if (
        !(
          error instanceof DockerApiError &&
          error.status === 409 &&
          /not running|is paused|is restarting/i.test(error.message)
        )
      )
        throw error;
      const record = await this.record(sandboxId);
      record.ready = false;
      await this.startSandbox(sandboxId);
      return run();
    }
  }

  /** {@link exec} on a sandbox made ready first (see {@link whileRunning}). */
  private execRunning(
    sandboxId: string,
    args: Parameters<ContainerSandboxProvider["exec"]>[1],
  ): ReturnType<ContainerSandboxProvider["exec"]> {
    return this.whileRunning(sandboxId, () => this.exec(sandboxId, args));
  }

  /**
   * Run a command to its end, untracked: the provider's own short
   * commands. Callers make sure the sandbox is {@link ready} first.
   */
  private async exec(
    sandboxId: string,
    args: {
      cmd: readonly string[];
      user?: string;
      input?: Buffer;
      timeoutSeconds?: number;
    },
  ): Promise<{ exitCode: number; stdout: string; stderr: string }> {
    const run = this.docker.exec({
      container: sandboxId,
      cmd: args.cmd,
      ...(args.user ? { user: args.user } : {}),
      ...(args.input ? { input: args.input } : {}),
    });
    if (!args.timeoutSeconds) return run;
    const seconds = args.timeoutSeconds;
    let timer: NodeJS.Timeout | undefined;
    try {
      return await Promise.race([
        run,
        new Promise<never>((_, reject) => {
          timer = setTimeout(
            () =>
              reject(
                new Error(`A sandbox command took longer than ${seconds}s`),
              ),
            seconds * 1000,
          );
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Run a command in its own process group (see {@link TRACKED}), stopping
   * the group on timeout or cancellation.
   */
  private async tracked(
    sandboxId: string,
    args: {
      argv: readonly string[];
      cwd: string;
      env?: Record<string, string>;
      timeoutSeconds?: number;
      signal?: AbortSignal;
    },
  ): Promise<{
    exitCode: number;
    stdout: string;
    stderr: string;
    ended: "exited" | "timeout" | "cancelled";
  }> {
    const token = randomUUID();
    const session = await this.whileRunning(sandboxId, () =>
      this.docker.openExec({
        container: sandboxId,
        cmd: ["sh", "-c", TRACKED, "work-exec", token, args.cwd, ...args.argv],
        ...(args.env ? { env: args.env } : {}),
      }),
    );
    let ended: "exited" | "timeout" | "cancelled" = "exited";
    const stop = (reason: "timeout" | "cancelled") => {
      if (ended !== "exited") return;
      ended = reason;
      void this.killTracked(sandboxId, token).catch(() => {});
    };
    const timer = args.timeoutSeconds
      ? setTimeout(() => stop("timeout"), args.timeoutSeconds * 1000)
      : undefined;
    const onAbort = () => stop("cancelled");
    if (args.signal?.aborted) onAbort();
    args.signal?.addEventListener("abort", onAbort, { once: true });
    const out: Buffer[] = [];
    const err: Buffer[] = [];
    let bytes = 0;
    try {
      for await (const frame of session.frames) {
        bytes += frame.data.length;
        if (bytes > MAX_OUTPUT_BYTES) continue;
        (frame.stream === "stdout" ? out : err).push(frame.data);
      }
    } finally {
      clearTimeout(timer);
      args.signal?.removeEventListener("abort", onAbort);
    }
    return {
      exitCode: await this.docker.settledExitCode(session.execId),
      stdout: Buffer.concat(out).toString("utf8"),
      stderr: Buffer.concat(err).toString("utf8"),
      ended,
    };
  }

  private async killTracked(sandboxId: string, token: string): Promise<void> {
    await this.docker.exec({
      container: sandboxId,
      cmd: ["sh", "-c", KILL_TRACKED, "work-kill", token],
      user: "0",
    });
  }

  /** `bun run entry.mjs` with its stdin and stdout as the supervisor's channel. */
  private async openSupervisor(args: {
    sandboxId: string;
    runtimeDirectory: string;
    env: Record<string, string>;
  }): Promise<SupervisorProcessHandle> {
    const token = randomUUID();
    const session = await this.whileRunning(args.sandboxId, () =>
      this.docker.openExec({
        container: args.sandboxId,
        cmd: [
          "sh",
          "-c",
          TRACKED,
          "work-supervisor",
          token,
          args.runtimeDirectory,
          "bun",
          "run",
          "entry.mjs",
        ],
        env: args.env,
        stdin: true,
      }),
    );
    return {
      write: (data) => session.write(data),
      kill: async () => {
        await this.killTracked(args.sandboxId, token);
        session.close();
      },
      stdout: stdoutOf(session.frames),
    };
  }

  /** The image reference to boot, pulling or building it when missing. */
  private async imageFor(opts: CreateSandboxOpts): Promise<string> {
    const image = opts.image;
    if (!image || image.kind === "oci") {
      const reference =
        image?.reference ??
        opts.snapshotName ??
        this.config.image ??
        DEFAULT_IMAGE;
      await this.once(reference, async () => {
        if (!(await this.docker.inspectImage(reference)))
          await this.docker.pullImage(reference);
      });
      return reference;
    }
    if (!(this.config.imageBuild ?? true))
      throw new Error(
        `This machine cannot build ${image.path}; place the Environment on a machine that builds images`,
      );
    const reference = dockerfileImageReference(image.digest);
    await this.once(reference, async () => {
      if (!(await this.docker.inspectImage(reference)))
        await this.docker.buildImage({
          tag: reference,
          dockerfile: image.content,
        });
    });
    return reference;
  }

  /** One pull or build per reference at a time. */
  private once(reference: string, run: () => Promise<void>): Promise<void> {
    const running = this.images.get(reference);
    if (running) return running;
    const started = run().finally(() => this.images.delete(reference));
    this.images.set(reference, started);
    return started;
  }

  private hostPathOf(): Promise<HostPathOf> {
    if (this.config.hostPathOf) return Promise.resolve(this.config.hostPathOf);
    // A failed inspection is asked again next time, not remembered.
    this.hostPaths ??= hostPathResolver({ docker: this.docker }).catch(
      (error: unknown) => {
        this.hostPaths = undefined;
        throw error;
      },
    );
    return this.hostPaths;
  }

  /**
   * The sign-in homes a sandbox mounts (ADR 0199): each one this machine
   * keeps for the member named, nothing else of the sign-in root.
   */
  private signInMounts(
    opts: CreateSandboxOpts,
  ): Array<{ host: string; guest: string }> {
    const requested = opts.signIns ?? [];
    if (requested.length === 0) return [];
    const root = this.config.signInRoot;
    if (!root)
      throw new Error(
        "This machine keeps no members' sign-ins, so its sandboxes cannot run on one",
      );
    return requested.map((signIn) => {
      const host = machineSignInHome({ root, ...signIn });
      if (!fs.statSync(host, { throwIfNoEntry: false })?.isDirectory())
        throw new Error(
          `This machine has no ${signIn.harness} sign-in for ${signIn.member}. Sign in on it with: work worker sign-in ${signIn.harness} --member ${signIn.member}`,
        );
      return {
        host,
        guest: signInHomePath({
          workspaceRoot: this.workspaceRoot,
          harness: signIn.harness,
        }),
      };
    });
  }

  private async pruneVolumes(args: { unusedForMs: number }): Promise<string[]> {
    const removed: string[] = [];
    for (const volume of await this.docker.listVolumes({
      label: [VOLUME_LABEL, `${OWNER_LABEL}=${this.owner}`],
    })) {
      const key = volumeKeyOf(volume);
      if (!key) continue;
      const created = Date.parse(String(volume.CreatedAt ?? ""));
      if (
        !this.usage.unused({
          key,
          unusedForMs: args.unusedForMs,
          ...(Number.isFinite(created) ? { since: created } : {}),
        })
      )
        continue;
      // A sandbox that still exists, even stopped, keeps its volumes.
      if (await this.docker.removeVolume(String(volume.Name)))
        removed.push(key);
    }
    this.usage.forget(removed);
    return removed;
  }

  /**
   * Remove every volume this provider made. With `destroySandboxes`, every
   * sandbox it made goes first, those no caller knows of included (a
   * pooled machine's reset, ADR 0205); without, a volume a sandbox still
   * mounts is kept and named.
   */
  private async removeAllVolumes(args?: {
    destroySandboxes?: boolean;
  }): Promise<void> {
    await this.reclaimed;
    if (args?.destroySandboxes)
      for (const container of await this.docker.listContainers({
        label: [`${SANDBOX_LABEL}=1`, `${OWNER_LABEL}=${this.owner}`],
      })) {
        const names = container.Names;
        const name = Array.isArray(names)
          ? String(names[0] ?? "").replace(/^\//, "")
          : "";
        await this.destroySandbox(name || String(container.Id));
      }
    const kept: string[] = [];
    const removed: string[] = [];
    for (const volume of await this.docker.listVolumes({
      label: [VOLUME_LABEL, `${OWNER_LABEL}=${this.owner}`],
    })) {
      const key = volumeKeyOf(volume);
      if (!key) continue;
      if (await this.docker.removeVolume(String(volume.Name)))
        removed.push(key);
      else kept.push(key);
    }
    this.usage.forget(removed);
    if (kept.length > 0)
      throw new Error(
        `Volumes still mounted by sandboxes were kept: ${kept.join(", ")}. Destroy those sandboxes first.`,
      );
  }
}

const PROXY_ENV: Readonly<Record<string, string>> = {
  HTTP_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  HTTPS_PROXY: `http://127.0.0.1:${PROXY_PORT}`,
  http_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  https_proxy: `http://127.0.0.1:${PROXY_PORT}`,
  NO_PROXY: "localhost,127.0.0.1,::1",
  no_proxy: "localhost,127.0.0.1,::1",
  NODE_USE_ENV_PROXY: "1",
};

/**
 * Start a forwarder (see {@link FORWARDER_SOURCE}) listening on `listen`
 * (an address, or a shell expression for one), once per boot: one whose
 * pid its ready file names is left running.
 */
function forwarderScript(args: { listen: string; name: string }): string {
  const ready = `/tmp/.work/forwarder-${args.name}.ready`;
  const log = `/tmp/.work/forwarder-${args.name}.log`;
  return [
    "mkdir -p /tmp/.work",
    `p="$(cat ${ready} 2>/dev/null)"`,
    '[ -n "$p" ] && grep -q forwarder.mjs "/proc/$p/cmdline" 2>/dev/null && exit 0',
    'runner="$(command -v bun || command -v node)" || { echo "The egress forwarder needs Bun or Node in the image" >&2; exit 1; }',
    `rm -f ${ready}`,
    `set -- "$runner" ${PROXY_MOUNT}/forwarder.mjs ${PROXY_MOUNT}/proxy.sock ${args.listen} ${PROXY_PORT} ${ready}`,
    "if command -v setsid >/dev/null 2>&1; then",
    `  setsid "$@" >${log} 2>&1 </dev/null &`,
    "else",
    `  ("$@" >${log} 2>&1 </dev/null &)`,
    "fi",
    `i=0; while [ $i -lt 100 ]; do [ -s ${ready} ] && exit 0; i=$((i+1)); sleep 0.1; done`,
    `cat ${log} >&2; exit 1`,
  ].join("\n");
}

/** The IPv4 name servers a resolv.conf names that are not on loopback. */
function remoteNameservers(file: string): string[] {
  try {
    return fs
      .readFileSync(file, "utf8")
      .split("\n")
      .flatMap((line) => {
        const [key, value] = line.trim().split(/\s+/);
        return key === "nameserver" &&
          value &&
          net.isIPv4(value) &&
          !value.startsWith("127.")
          ? [value]
          : [];
      });
  } catch {
    return [];
  }
}

/** Live provider instances of this process, by the token each records. */
const liveInstances = new Set<string>();

/**
 * Sandboxes being created, in a small file in the provider's state
 * directory (ADR 0204): each with the process and provider instance making
 * it. A sandbox whose maker is gone was never handed over.
 */
export class CreationRegistry {
  private readonly instance = randomUUID();

  constructor(private readonly file: string) {
    liveInstances.add(this.instance);
  }

  begin(id: string): void {
    this.write([
      ...this.entries().filter((entry) => entry.id !== id),
      { id, pid: process.pid, instance: this.instance },
    ]);
  }

  end(id: string): void {
    const entries = this.entries();
    if (entries.some((entry) => entry.id === id))
      this.write(entries.filter((entry) => entry.id !== id));
  }

  /**
   * Sandboxes whose maker died: a process no longer running, or an earlier
   * one that had this process's pid (a worker is often pid 1 in its
   * container), whose instance this process never made.
   */
  abandoned(): string[] {
    return this.entries()
      .filter((entry) =>
        entry.pid === process.pid
          ? !liveInstances.has(entry.instance)
          : !processAlive(entry.pid),
      )
      .map((entry) => entry.id);
  }

  private entries(): Array<{ id: string; pid: number; instance: string }> {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(this.file, "utf8"));
      return Array.isArray(parsed)
        ? parsed.flatMap((entry: unknown) => {
            if (typeof entry !== "object" || entry === null) return [];
            const id = Reflect.get(entry, "id");
            const pid = Reflect.get(entry, "pid");
            const instance = Reflect.get(entry, "instance");
            return typeof id === "string" &&
              typeof pid === "number" &&
              typeof instance === "string"
              ? [{ id, pid, instance }]
              : [];
          })
        : [];
    } catch {
      return [];
    }
  }

  private write(
    entries: Array<{ id: string; pid: number; instance: string }>,
  ): void {
    fs.mkdirSync(path.dirname(this.file), { recursive: true });
    const temporary = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(temporary, JSON.stringify(entries), { mode: 0o600 });
    fs.renameSync(temporary, this.file);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM: alive, someone else's.
    return error instanceof Error && "code" in error && error.code === "EPERM";
  }
}

function isRoot(user: string): boolean {
  const name = user.split(":")[0];
  return name === "root" || name === "0";
}

/** Each directory from just below `home` down to every mount point. */
function parentsWithin(home: string, targets: readonly string[]): string[] {
  const directories = new Set<string>();
  for (const target of targets) {
    let current = target;
    while (current.startsWith(`${home}/`)) {
      directories.add(current);
      current = path.posix.dirname(current);
    }
  }
  return [...directories].sort();
}

function parsePolicy(raw: string): EgressPolicy | undefined {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    if (Reflect.get(parsed, "any") === true) return { any: true };
    const allow = Reflect.get(parsed, "allow");
    return Array.isArray(allow) ? { allow: allow.map(String) } : undefined;
  } catch {
    return undefined;
  }
}

function volumeKeyOf(volume: Record<string, unknown>): string | undefined {
  const labels = objectField(volume, "Labels");
  const key = labels[VOLUME_LABEL];
  return typeof key === "string" && VOLUME_KEY_PATTERN.test(key)
    ? key
    : undefined;
}

function objectField(
  value: Record<string, unknown> | undefined,
  key: string,
): Record<string, unknown> {
  const field = value?.[key];
  return typeof field === "object" && field !== null && !Array.isArray(field)
    ? Object.fromEntries(Object.entries(field))
    : {};
}

function stringList(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String) : [];
}

async function* stdoutOf(
  frames: AsyncIterable<{ stream: string; data: Buffer }>,
): AsyncGenerator<Uint8Array> {
  for await (const frame of frames)
    if (frame.stream === "stdout") yield frame.data;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
