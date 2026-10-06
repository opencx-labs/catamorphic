import fs from "node:fs";
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
  SandboxVolume,
  SandboxVolumeProvider,
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
import {
  Image,
  type SandboxStatus as MsbSandboxStatus,
  type NetworkProfile,
  Sandbox,
  Volume,
} from "microsandbox";
import { microsandboxEgressPolicy } from "./egress-policy.js";
import { cachedImageBuilder, type ImageBuilder } from "./image-builder.js";
import { msbStdioRuntimeProvider } from "./stdio-runtime-provider.js";

const DEFAULT_IMAGE = "oven/bun";
const DEFAULT_MEMORY_MIB = 1024;
const DEFAULT_CPUS = 1;
const DEFAULT_CONTAINER_DISK_MIB = 8192;
/** Marks a VM whose Docker daemon should run whenever it boots. */
const CONTAINERS_MARKER = "/etc/work-containers";
const DOCKER_DATA = "/var/lib/docker";

function mapMsbStatus(status: MsbSandboxStatus): SandboxStatus {
  switch (status) {
    case "created":
    case "starting":
      return "creating";
    case "running":
    case "draining":
      return "started";
    // A paused VM is not serving; callers start it, which resumes it.
    case "paused":
    case "stopped":
      return "stopped";
    case "crashed":
      return "error";
  }
}

export interface MicrosandboxProviderConfig {
  /** Host-owned persistent data for a project's deployment runtimes. Never copied into source snapshots. */
  projectDataDirectory?: (input: {
    projectId: string;
  }) => Promise<string | undefined>;

  image?: string;
  memoryMib?: number;
  cpus?: number;
  /** Seconds of inactivity before the sandbox auto-stops. */
  idleTimeoutSeconds?: number;
  namePrefix?: string;
  /**
   * Network reach of every sandbox, as microsandbox profiles. Unset keeps
   * the runtime's default (public internet only). A development host adds
   * `"private"` and `"host"` so builds can fetch from a registry served by
   * the machine itself; production keeps sandboxes off the host network.
   */
  networkProfiles?: readonly NetworkProfile[];
  /**
   * Shell command run once inside every new sandbox before it is handed to
   * the caller. Defaults to installing git and bash when the image lacks
   * them — core's agent sessions require git for change detection, and
   * common runtime images (oven/bun, docker:dind) don't ship both. Pass an
   * empty string to disable.
   */
  setupCommand?: string;
  /**
   * Builds project Dockerfiles on this machine (ADR 0176), for example
   * `dockerImageBuilder()`. Without one the provider boots registry images
   * only and does not advertise `images.build`.
   */
  imageBuilder?: ImageBuilder;
  /**
   * Nested containers (ADR 0176): a sandbox that asks for them gets a
   * private disk for the image's Docker daemon, which runs inside the VM
   * and dies with it. Default on.
   */
  containers?: boolean;
  /** Size of each container sandbox's Docker disk. Default 8 GiB. */
  containerDiskMib?: number;
  /**
   * Where this machine keeps members' own harness sign-ins (ADR 0199),
   * one home per harness and member (`machineSignInHome`). A sandbox
   * created with `signIns` bind-mounts exactly those homes, read-write so
   * the CLI's own token refresh keeps working. Without it the provider
   * refuses `signIns`.
   */
  signInRoot?: string;
  /**
   * Where the provider records when each volume was last mounted (ADR
   * 0207). With it, sandboxes mount volumes (microsandbox named volumes:
   * directories, or disks for exclusive ones) and the provider advertises
   * `volumes`.
   */
  stateDirectory?: string;
}

/** Labels a sandbox with the volumes it mounts, so pruning keeps them. */
const VOLUMES_LABEL = "work.volumes";

/**
 * Runs once per new sandbox; ~20s on first use, no-op when everything
 * exists. Agent sessions need git and bash, and the agent runner needs Bun
 * or Node (ADR 0198); an image without them gets them from its package
 * manager (Node, the smaller of the two).
 */
const DEFAULT_SETUP_COMMAND =
  "{ command -v git && command -v bash && { command -v bun || command -v node; }; } >/dev/null 2>&1 || " +
  "if command -v apt-get >/dev/null 2>&1; then " +
  "apt-get update -qq && apt-get install -y -qq git bash && " +
  "{ command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || apt-get install -y -qq nodejs; }; " +
  "elif command -v apk >/dev/null 2>&1; then apk add --no-cache -q git bash && " +
  "{ command -v bun >/dev/null 2>&1 || command -v node >/dev/null 2>&1 || apk add --no-cache -q nodejs; }; " +
  "else echo 'The image has neither git nor a known package manager' >&2; exit 1; fi; " +
  // The runner needs Bun, or Node 20 or later; a distribution's Node can be older.
  "command -v bun >/dev/null 2>&1 || node -e 'process.exit(Number(process.versions.node.split(\".\")[0]) >= 20 ? 0 : 1)' || " +
  "{ echo 'The agent runner needs Bun, or Node 20 or later, and this image has an older Node: use an image with Bun or Node 20+' >&2; exit 1; }";

/** Start the image's Docker daemon unless it already answers. */
const ENSURE_DOCKER = [
  "docker info >/dev/null 2>&1 && exit 0",
  "command -v dockerd >/dev/null 2>&1 || { echo 'This image has no Docker daemon: use an image with Docker (docker:dind, or a Dockerfile FROM it)' >&2; exit 1; }",
  "(dockerd >/var/log/dockerd.log 2>&1 &)",
  "i=0; while [ $i -lt 120 ]; do docker info >/dev/null 2>&1 && exit 0; i=$((i+1)); sleep 0.5; done",
  "tail -20 /var/log/dockerd.log >&2; exit 1",
].join("\n");

export class MicrosandboxSandboxProvider implements SandboxProvider {
  readonly isolation = "sandbox";
  readonly workspaceRoot = "/workspace";
  /** `storageMb` sizes the VM's root disk, which holds the workspace. */
  readonly resourceLimits = ["cpuMillis", "memoryMb", "storageMb"] as const;
  readonly capabilities: readonly SandboxCapability[];
  readonly deploymentRuntime: DeploymentRuntimeProvider;
  /**
   * Background processes (ADR 0174) run inside the VM in their own session;
   * their output and state live in the VM, so they end when it does.
   */
  readonly processes: SandboxProcessProvider = shellSandboxProcesses({
    executeCommand: (sandboxId, command, opts) =>
      this.executeCommand(sandboxId, command, opts),
    workspaceRoot: this.workspaceRoot,
  });
  /** Named volumes kept across sandboxes (ADR 0207), with `stateDirectory`. */
  readonly volumes?: SandboxVolumeProvider;
  private readonly config: Required<
    Omit<
      MicrosandboxProviderConfig,
      | "projectDataDirectory"
      | "networkProfiles"
      | "imageBuilder"
      | "signInRoot"
      | "stateDirectory"
    >
  > &
    Pick<
      MicrosandboxProviderConfig,
      | "projectDataDirectory"
      | "networkProfiles"
      | "imageBuilder"
      | "signInRoot"
      | "stateDirectory"
    >;
  private readonly connections = new Map<string, Sandbox>();
  private readonly usage: VolumeUsageLog | undefined;

  constructor(config?: MicrosandboxProviderConfig) {
    this.config = {
      projectDataDirectory: config?.projectDataDirectory,
      image: config?.image ?? DEFAULT_IMAGE,
      memoryMib: config?.memoryMib ?? DEFAULT_MEMORY_MIB,
      cpus: config?.cpus ?? DEFAULT_CPUS,
      idleTimeoutSeconds: config?.idleTimeoutSeconds ?? 15 * 60,
      namePrefix: config?.namePrefix ?? "cata",
      networkProfiles: config?.networkProfiles,
      setupCommand: config?.setupCommand ?? DEFAULT_SETUP_COMMAND,
      imageBuilder: config?.imageBuilder
        ? cachedImageBuilder(config.imageBuilder)
        : undefined,
      containers: config?.containers ?? true,
      containerDiskMib: config?.containerDiskMib ?? DEFAULT_CONTAINER_DISK_MIB,
      signInRoot: config?.signInRoot,
      stateDirectory: config?.stateDirectory,
    };
    const stateDirectory = this.config.stateDirectory;
    this.usage = stateDirectory
      ? new VolumeUsageLog(path.join(stateDirectory, "volumes.json"))
      : undefined;
    if (this.usage)
      this.volumes = {
        prune: (args) => this.pruneVolumes(args),
        removeAll: () => this.removeAllVolumes(),
      };
    this.capabilities = [
      SANDBOX_CAPABILITIES.images,
      SANDBOX_CAPABILITIES.egressPolicy,
      ...(this.config.containers ? [SANDBOX_CAPABILITIES.containers] : []),
      ...(this.config.imageBuilder ? [SANDBOX_CAPABILITIES.imageBuild] : []),
      ...(this.usage ? [SANDBOX_CAPABILITIES.volumes] : []),
    ];
    this.deploymentRuntime = msbStdioRuntimeProvider({
      connect: (sandboxId) => this.connect(sandboxId),
      uploadFiles: (sandboxId, files, basePath) =>
        this.uploadFiles(sandboxId, files, basePath),
    });
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    assertSandboxResources(opts.resources, this.resourceLimits);
    const cpuMillis = opts.resources?.cpuMillis ?? this.config.cpus * 1000;
    if (cpuMillis % 1000 !== 0)
      throw new Error(
        "Microsandbox CPU limits must be whole cores (multiples of 1000 millicores)",
      );
    if (opts.containers && !this.config.containers)
      throw new Error("This machine does not run containers in sandboxes");
    if (opts.volumes?.length && !this.usage)
      throw new Error("This machine keeps no volumes for its sandboxes");
    assertSandboxVolumes(opts.volumes);
    const signIns = this.signInMounts(opts);
    const image = await this.imageFor(opts);
    const volumes = await this.volumeMounts({ image, volumes: opts.volumes });
    const name = `${this.config.namePrefix}-${crypto.randomUUID().slice(0, 12)}`;
    let builder = Sandbox.builder(name)
      .image(image)
      .memory(opts.resources?.memoryMb ?? this.config.memoryMib)
      .cpus(cpuMillis / 1000)
      .idleTimeout(
        opts.autoStopInterval !== undefined
          ? opts.autoStopInterval * 60
          : this.config.idleTimeoutSeconds,
      )
      // The workdir must exist before boot; images like oven/bun don't ship it.
      .patch((patch) => patch.mkdir(this.workspaceRoot, { mode: 0o755 }))
      .workdir(this.workspaceRoot)
      .detached(true);
    if (opts.resources?.storageMb)
      builder = builder.rootDisk(opts.resources.storageMb);
    if (opts.envVars) builder = builder.envs(opts.envVars);
    const persistent = volumes.filter((volume) => !volume.temporary);
    const labels = {
      ...opts.labels,
      ...(persistent.length > 0
        ? { [VOLUMES_LABEL]: persistent.map((volume) => volume.key).join(",") }
        : {}),
    };
    if (Object.keys(labels).length > 0) builder = builder.labels(labels);
    const policy = microsandboxEgressPolicy({
      egress: opts.egress,
      profiles: this.config.networkProfiles,
    });
    if (policy) builder = builder.network((network) => network.policy(policy));
    for (const volume of volumes)
      builder = builder.volume(volume.target, volume.mount);
    this.usage?.touch(persistent.map((volume) => volume.key));
    // A volume the Environment keeps at the Docker data root replaces the
    // sandbox's own Docker disk.
    if (
      opts.containers &&
      !volumes.some((volume) => volume.target === DOCKER_DATA)
    ) {
      // Docker's overlay storage cannot sit on the VM's overlay root; a
      // disk owned by this sandbox can, and is removed with it.
      builder = builder.volume(DOCKER_DATA, (mount) =>
        mount.owned({ kind: "disk", sizeMib: this.config.containerDiskMib }),
      );
    }
    const dataDirectory =
      opts.labels?.purpose === "deployment-runtime" && opts.labels.projectId
        ? await this.config.projectDataDirectory?.({
            projectId: opts.labels.projectId,
          })
        : undefined;
    if (dataDirectory) {
      builder = builder
        .volume(APP_DATA_MOUNT, (mount) => mount.bind(dataDirectory))
        .env(APP_DATA_ENV, APP_DATA_MOUNT);
    }
    for (const signIn of signIns)
      builder = builder.volume(signIn.guest, (mount) =>
        mount.bind(signIn.host),
      );
    const sandbox = await builder.create();
    this.connections.set(name, sandbox);
    const prepare = async (command: string, what: string) => {
      const result = await shellIn(sandbox, command, 300);
      if (result.exitCode !== 0) {
        await this.destroySandbox(name).catch(() => {});
        throw new Error(`${what} failed: ${result.result}`);
      }
    };
    if (this.config.setupCommand)
      await prepare(
        this.config.setupCommand,
        opts.egress?.mode === "allowlist"
          ? "Sandbox setup command (egress is restricted, so the image must already have git, bash, and Bun or Node)"
          : "Sandbox setup command",
      );
    if (opts.containers)
      await prepare(
        `touch ${CONTAINERS_MARKER}\n${ENSURE_DOCKER}`,
        "Starting the sandbox's container runtime",
      );
    return {
      id: name,
      providerId: name,
      sandboxType: "execution",
      status: "started",
    };
  }

  async startSandbox(sandboxId: string): Promise<void> {
    const handle = await Sandbox.get(sandboxId);
    if (handle.status === "running") return;
    this.connections.set(sandboxId, await booted(await bringUp(handle)));
    this.usage?.touch(volumeKeysOf(handle));
  }

  /**
   * How each volume mounts (ADR 0207): a named volume, a directory, or a
   * disk for an exclusive one (a Docker data root needs a filesystem of
   * its own); a temporary one is owned by the sandbox and removed with it.
   */
  private async volumeMounts(args: {
    image: string;
    volumes: readonly SandboxVolume[] | undefined;
  }): Promise<
    Array<{
      key: string;
      temporary: boolean;
      target: string;
      mount: MountConfigure;
    }>
  > {
    const volumes = args.volumes ?? [];
    if (volumes.length === 0) return [];
    // `~` is the image user's home; an image not yet cached counts as root's.
    const detail = volumes.some((volume) => volume.path.startsWith("~"))
      ? await Image.inspect(args.image).catch(() => undefined)
      : undefined;
    const home = imageUserHome({
      user: detail?.config?.user ?? null,
      env: detail?.config?.env ?? null,
    });
    // A disk keeps the size it was made with: one that exists mounts as is.
    const existing = new Set(
      (await Volume.list().catch(() => [])).map((volume) => volume.name),
    );
    return volumes.map((volume) => {
      const disk = volume.exclusive === true;
      const sizeMib = volume.sizeMb ?? this.config.containerDiskMib;
      return {
        key: volume.key,
        temporary: volume.temporary === true,
        target: volumeMountPath({ path: volume.path, home }),
        mount: (mount) =>
          volume.temporary
            ? mount.owned(disk ? { kind: "disk", sizeMib } : { kind: "dir" })
            : existing.has(volume.key)
              ? mount.named(volume.key)
              : mount.namedWith(
                  volume.key,
                  "ensure-exists",
                  disk ? "disk" : "dir",
                  disk ? sizeMib : undefined,
                ),
      };
    });
  }

  /** Remove volumes no sandbox mounts that went unused for `unusedForMs`. */
  private async pruneVolumes(args: { unusedForMs: number }): Promise<string[]> {
    const usage = this.usage;
    if (!usage) return [];
    const mounted = await mountedVolumeKeys();
    const removed: string[] = [];
    for (const volume of await Volume.list()) {
      if (!VOLUME_KEY_PATTERN.test(volume.name) || mounted.has(volume.name))
        continue;
      if (
        !usage.unused({
          key: volume.name,
          unusedForMs: args.unusedForMs,
          ...(volume.createdAt ? { since: volume.createdAt.getTime() } : {}),
        })
      )
        continue;
      await Volume.remove(volume.name).then(
        () => removed.push(volume.name),
        () => {},
      );
    }
    usage.forget(removed);
    return removed;
  }

  private async removeAllVolumes(): Promise<void> {
    const mounted = await mountedVolumeKeys();
    const kept: string[] = [];
    const removed: string[] = [];
    for (const volume of await Volume.list()) {
      if (!VOLUME_KEY_PATTERN.test(volume.name)) continue;
      if (mounted.has(volume.name)) kept.push(volume.name);
      else {
        await Volume.remove(volume.name);
        removed.push(volume.name);
      }
    }
    this.usage?.forget(removed);
    if (kept.length > 0)
      throw new Error(
        `Volumes still mounted by sandboxes were kept: ${kept.join(", ")}. Destroy those sandboxes first.`,
      );
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

  /** The image reference to boot, building a Dockerfile image when needed. */
  private async imageFor(opts: CreateSandboxOpts): Promise<string> {
    const image = opts.image;
    if (!image) return opts.snapshotName ?? this.config.image;
    if (image.kind === "oci") return image.reference;
    if (!this.config.imageBuilder)
      throw new Error(
        `This machine cannot build ${image.path}; place the Environment on a machine that builds images`,
      );
    const reference = dockerfileImageReference(image.digest);
    await this.config.imageBuilder.build({
      reference,
      dockerfile: image.content,
    });
    return reference;
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    this.connections.delete(sandboxId);
    const handle = await Sandbox.get(sandboxId);
    await handle.stop();
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const connected = this.connections.get(sandboxId);
    this.connections.delete(sandboxId);
    const handle = await Sandbox.get(sandboxId).catch((error: unknown) => {
      if (
        error instanceof Error &&
        "code" in error &&
        error.code === "sandboxNotFound"
      )
        return undefined;
      throw error;
    });
    if (!handle) {
      await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
      return;
    }
    if (handle.status === "running") {
      // A disk volume's writes wait in the guest's cache; killing the VM
      // would lose them, so they reach the disk first.
      if (volumeKeysOf(handle).length > 0)
        await shellIn(connected ?? (await handle.connect()), "sync", 60).catch(
          () => {},
        );
      await handle.kill();
    }
    await handle.remove();
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    const handle = await Sandbox.get(sandboxId);
    return mapMsbStatus(handle.status);
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const sandbox = await this.connect(sandboxId);
    const output = await sandbox.execWith("bash", (exec) => {
      exec = exec.args(["-lc", command]);
      if (opts?.cwd) exec = exec.cwd(opts.cwd);
      if (opts?.env) exec = exec.envs(opts.env);
      // ExecOpts.timeout is in seconds (Daytona convention); msb wants ms.
      if (opts?.timeout) exec = exec.timeout(opts.timeout * 1_000);
      return exec;
    });
    const stdout = output.stdout();
    const stderr = output.stderr();
    return {
      exitCode: output.code,
      result:
        stderr.length > 0 ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout,
    };
  }

  async uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    const sandbox = await this.connect(sandboxId);
    const fs = sandbox.fs();
    const dirs = new Set<string>();
    for (const filePath of Object.keys(files)) {
      const destination = basePath ? `${basePath}/${filePath}` : filePath;
      const dir = destination.slice(0, destination.lastIndexOf("/"));
      if (dir) dirs.add(dir);
    }
    if (dirs.size > 0) {
      await sandbox.shell(
        `mkdir -p ${[...dirs].map((dir) => `'${dir.replaceAll("'", `'\\''`)}'`).join(" ")}`,
      );
    }
    await Promise.all(
      Object.entries(files).map(([filePath, content]) =>
        fs.write(basePath ? `${basePath}/${filePath}` : filePath, content),
      ),
    );
  }

  async downloadFile(sandboxId: string, filePath: string): Promise<string> {
    const sandbox = await this.connect(sandboxId);
    return sandbox.fs().readToString(filePath);
  }

  async gitClone(
    sandboxId: string,
    url: string,
    path: string,
    opts?: GitCloneOpts,
  ): Promise<void> {
    const cloneUrl = gitCloneUrl(url, opts);
    const branchArg = opts?.branch
      ? ` --branch ${shellQuote(opts.branch)}`
      : "";
    const clone = await this.executeCommand(
      sandboxId,
      `git clone${branchArg} ${shellQuote(cloneUrl)} ${shellQuote(path)}`,
      { timeout: 120 },
    );
    if (clone.exitCode !== 0) {
      throw gitCloneFailure({
        output: clone.result,
        ...(opts ? { opts } : {}),
      });
    }
    if (opts?.commitId) {
      await this.gitCheckout(sandboxId, path, opts.commitId);
    }
  }

  async gitCheckout(
    sandboxId: string,
    path: string,
    ref: string,
  ): Promise<void> {
    const result = await this.executeCommand(
      sandboxId,
      `git -C ${shellQuote(path)} checkout ${shellQuote(ref)}`,
      { timeout: 60 },
    );
    if (result.exitCode !== 0) {
      throw new Error(`git checkout failed: ${result.result}`);
    }
  }

  private async connect(sandboxId: string): Promise<Sandbox> {
    const cached = this.connections.get(sandboxId);
    if (cached) return cached;
    const handle = await Sandbox.get(sandboxId);
    const sandbox =
      handle.status === "running"
        ? await handle.connect()
        : await booted(await bringUp(handle));
    this.connections.set(sandboxId, sandbox);
    return sandbox;
  }
}

/**
 * A live connection to a sandbox that is not running. A paused VM resumes in
 * place (restarting one is refused by msb); anything else boots.
 */
async function bringUp(
  handle: Awaited<ReturnType<typeof Sandbox.get>>,
): Promise<Sandbox> {
  if (handle.status === "paused") {
    await handle.resume();
    return handle.connect();
  }
  return handle.startDetached();
}

/** Run a POSIX shell command: images without bash still prepare. */
async function shellIn(
  sandbox: Sandbox,
  command: string,
  timeoutSeconds: number,
): Promise<ExecResult> {
  const output = await sandbox.execWith("sh", (exec) =>
    exec.args(["-c", command]).timeout(timeoutSeconds * 1_000),
  );
  const stdout = output.stdout();
  const stderr = output.stderr();
  return {
    exitCode: output.code,
    result:
      stderr.length > 0 ? `${stdout}${stdout ? "\n" : ""}${stderr}` : stdout,
  };
}

/** Restart a container sandbox's Docker daemon after its VM boots again. */
async function booted(sandbox: Sandbox): Promise<Sandbox> {
  const result = await shellIn(
    sandbox,
    `[ -f ${CONTAINERS_MARKER} ] || exit 0\n${ENSURE_DOCKER}`,
    120,
  );
  if (result.exitCode !== 0)
    throw new Error(
      `The sandbox's container runtime did not start: ${result.result}`,
    );
  return sandbox;
}

/** How one volume mounts, as the sandbox builder takes it. */
type MountConfigure = Parameters<
  ReturnType<typeof Sandbox.builder>["volume"]
>[1];

/** The volumes a sandbox was created with, from its labels. */
function volumeKeysOf(handle: { config(): Record<string, unknown> }): string[] {
  try {
    const labels = handle.config().labels;
    const keys =
      typeof labels === "object" && labels !== null
        ? Reflect.get(labels, VOLUMES_LABEL)
        : undefined;
    return typeof keys === "string" ? keys.split(",").filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** Every volume an existing sandbox (running or not) mounts. */
async function mountedVolumeKeys(): Promise<Set<string>> {
  const keys = new Set<string>();
  let cursor: string | undefined;
  do {
    const after = cursor;
    const page = await Sandbox.listWith((list) =>
      after ? list.cursor(after) : list,
    );
    for (const handle of page.sandboxes)
      for (const key of volumeKeysOf(handle)) keys.add(key);
    cursor = page.nextCursor;
  } while (cursor);
  return keys;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
