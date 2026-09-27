import { type ChildProcess, spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type {
  CreateSandboxOpts,
  DeploymentRuntimeProvider,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  ProcessOutput,
  ReadProcessOutputArgs,
  SandboxCapability,
  SandboxHandle,
  SandboxProcess,
  SandboxProcessProvider,
  SandboxProvider,
  SandboxStatus,
  SignalProcessArgs,
  StartProcessArgs,
  SupervisorProcessHandle,
  WriteProcessInputArgs,
} from "@catamorphic/sandbox";
import {
  assertProcessId,
  assertSandboxResources,
  assertWriteSize,
  decodeUtf8Prefix,
  newProcessId,
  PROCESS_SIGNALS,
  processReadBounds,
  SANDBOX_CAPABILITIES,
  StdioDeploymentRuntimeProvider,
} from "@catamorphic/sandbox";
import { APP_DATA_ENV } from "@catamorphic/workflow/project-layout";
import {
  type DockerProxy,
  removeDockerResources,
  startDockerProxy,
} from "./docker-proxy.js";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface LocalProcessProviderConfig {
  /** Host-owned persistent data for a project's deployment runtimes. Never copied into source snapshots. */
  projectDataDirectory?: (input: {
    projectId: string;
  }) => Promise<string | undefined>;

  /**
   * Directory that holds one subdirectory per sandbox. Defaults to a stable
   * path under the OS temp dir; pass a persistent directory for deployments
   * that must survive host restarts.
   */
  root?: string;
  /**
   * Extra base env entries for every spawned process (e.g. a custom PATH).
   * Merged under the per-call env, over the built-in base.
   */
  env?: Record<string, string>;
  /**
   * Containers for sandboxes that ask for them (ADR 0176): each gets its own
   * Docker endpoint in front of this host daemon, which labels what it
   * creates, shows it only its own, refuses host access, and removes it all
   * with the sandbox. Trusted machines only.
   */
  docker?: {
    socketPath: string;
    /**
     * Docker CLI plugins (`docker compose`, `docker buildx`) for sandboxes,
     * whose HOME is their own: linked as `~/.docker/cli-plugins`. Only
     * needed where plugins are installed per user (Docker Desktop).
     */
    cliPlugins?: string;
  };
  /**
   * The operator accepts that this machine cannot enforce an Environment's
   * egress policy and runs such Environments anyway (ADR 0176). Advertises
   * `network.policy`; nothing restricts the network.
   */
  acceptUnenforcedEgress?: boolean;
}

const CONTAINERS_MARKER = "containers";

/**
 * Sandboxless execution for trusted, single-tenant hosts (ADR 0047): each
 * "sandbox" is a directory, commands run as plain subprocesses. Selecting
 * this provider is a boot-time act in host code — core never knows the
 * difference.
 *
 * Isolation model, stated honestly: a process boundary and an explicit env,
 * nothing more. Workflow code can read the host filesystem and network.
 * Only use it where every deployed workflow is trusted — internal tools,
 * desktop-class hosts, single-tenant servers. Never multi-tenant.
 *
 * The spawned env is exactly: PATH (so `bun`/`git` resolve), a per-sandbox
 * HOME and TMPDIR, plus what the caller passes. It never inherits
 * `process.env` — that would leak every host secret into every workflow.
 */
export class LocalProcessSandboxProvider implements SandboxProvider {
  /**
   * Virtual prefix; each sandbox maps it onto `<root>/<id>/workspace`, so
   * provider-agnostic callers build paths exactly as they do for container
   * providers.
   */
  readonly isolation = "process";
  readonly workspaceRoot = "/workspace";
  readonly deploymentRuntime: DeploymentRuntimeProvider;
  readonly capabilities: readonly SandboxCapability[];
  /**
   * Background processes (ADR 0174): each writes its output to a log in
   * its sandbox directory, outside the workspace, and is stopped with the
   * sandbox like every other command.
   */
  readonly processes: SandboxProcessProvider = {
    startProcess: (args) => this.startProcess(args),
    readProcessOutput: (args) => this.readProcessOutput(args),
    signalProcess: (args) => this.signalProcess(args),
    writeProcessInput: (args) => this.writeProcessInput(args),
    listProcesses: async ({ sandboxId }) =>
      [...(this.background.get(sandboxId)?.values() ?? [])].map((entry) =>
        this.snapshot(entry),
      ),
  };
  private readonly background = new Map<
    string,
    Map<string, { process: SandboxProcess; child: ChildProcess; log: string }>
  >();
  private readonly root: string;
  private readonly projectDataDirectory: LocalProcessProviderConfig["projectDataDirectory"];
  private readonly children = new Map<string, Set<ChildProcess>>();
  private readonly stopped = new Set<string>();
  private readonly baseEnv: Record<string, string>;
  private readonly sandboxes = new Map<
    string,
    { envVars: Record<string, string> }
  >();
  private readonly docker?: LocalProcessProviderConfig["docker"];
  private readonly acceptUnenforcedEgress: boolean;
  private readonly dockerProxies = new Map<string, Promise<DockerProxy>>();

  constructor(config?: LocalProcessProviderConfig) {
    this.projectDataDirectory = config?.projectDataDirectory;
    this.docker = config?.docker;
    this.acceptUnenforcedEgress = config?.acceptUnenforcedEgress ?? false;
    this.capabilities = [
      ...(this.docker ? [SANDBOX_CAPABILITIES.containers] : []),
      ...(this.acceptUnenforcedEgress
        ? [SANDBOX_CAPABILITIES.egressPolicy]
        : []),
    ];
    this.root =
      config?.root ?? path.join(os.tmpdir(), "catamorphic-local-process");
    fs.mkdirSync(this.root, { recursive: true });
    this.baseEnv = {
      ...(process.env.PATH ? { PATH: process.env.PATH } : {}),
      ...(config?.env ?? {}),
    };
    this.deploymentRuntime = new StdioDeploymentRuntimeProvider({
      uploadFiles: (sandboxId, files, basePath) =>
        this.uploadFiles(sandboxId, files, basePath),
      mkdirp: async (sandboxId, directory) => {
        fs.mkdirSync(this.resolvePath(sandboxId, directory), {
          recursive: true,
        });
      },
      openSupervisor: async (args) =>
        this.spawnSupervisor(args.sandboxId, args.runtimeDirectory, args.env),
    });
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    assertSandboxResources(opts.resources, []);
    if (opts.image)
      throw new Error(
        "Local-process sandboxes run on this machine's own system and cannot boot an image",
      );
    if (opts.containers && !this.docker)
      throw new Error("This machine does not offer containers to sandboxes");
    if (opts.egress?.mode === "allowlist" && !this.acceptUnenforcedEgress)
      throw new Error(
        "Local-process sandboxes cannot enforce an egress policy; place the Environment on a microsandbox machine",
      );
    const id = `local-${crypto.randomUUID().slice(0, 12)}`;
    for (const dir of ["workspace", "home", "tmp"]) {
      fs.mkdirSync(path.join(this.root, id, dir), { recursive: true });
    }
    if (opts.containers) {
      fs.writeFileSync(path.join(this.root, id, CONTAINERS_MARKER), "");
      const plugins = this.docker?.cliPlugins;
      if (plugins) {
        const config = path.join(this.root, id, "home", ".docker");
        fs.mkdirSync(config, { recursive: true });
        fs.symlinkSync(plugins, path.join(config, "cli-plugins"));
      }
    }
    const dataDirectory =
      opts.labels?.purpose === "deployment-runtime" && opts.labels.projectId
        ? await this.projectDataDirectory?.({
            projectId: opts.labels.projectId,
          })
        : undefined;
    this.sandboxes.set(id, {
      envVars: {
        ...opts.envVars,
        ...(dataDirectory ? { [APP_DATA_ENV]: dataDirectory } : {}),
      },
    });
    await this.ensureDocker(id);
    return { id, providerId: id, sandboxType: "execution", status: "started" };
  }

  async startSandbox(sandboxId: string): Promise<void> {
    this.requireSandboxDir(sandboxId);
    this.stopped.delete(sandboxId);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    this.requireSandboxDir(sandboxId);
    this.stopped.add(sandboxId);
    const children = [...(this.children.get(sandboxId) ?? [])];
    await Promise.all(
      children.map(
        (child) =>
          new Promise<void>((resolve) => {
            if (child.exitCode !== null || child.signalCode !== null) {
              resolve();
              return;
            }
            child.once("close", () => resolve());
            this.killProcessTree(child);
          }),
      ),
    );
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const directory = path.join(this.root, sandboxId);
    if (fs.existsSync(directory)) {
      await this.stopSandbox(sandboxId);
      if (
        this.docker &&
        fs.existsSync(path.join(directory, CONTAINERS_MARKER))
      ) {
        // Everything the sandbox started goes with it. A failure keeps the
        // directory, so cleanup retries and capacity stays reserved.
        await (await this.dockerProxies.get(sandboxId))?.close();
        this.dockerProxies.delete(sandboxId);
        await removeDockerResources({
          upstreamSocket: this.docker.socketPath,
          owner: sandboxId,
        });
      }
      // Deployments are made read-only inside the sandbox; the owner takes
      // write access back so removal cannot leave the directory behind.
      restoreOwnerWrite(directory);
    }
    fs.rmSync(directory, { recursive: true, force: true });
    this.sandboxes.delete(sandboxId);
    this.stopped.delete(sandboxId);
    this.children.delete(sandboxId);
    this.background.delete(sandboxId);
    await this.deploymentRuntime.releaseSandbox?.({ sandboxId });
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    return !this.stopped.has(sandboxId) &&
      fs.existsSync(path.join(this.root, sandboxId))
      ? "started"
      : "stopped";
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    this.requireRunning(sandboxId);
    await this.ensureDocker(sandboxId);
    const cwd = this.resolvePath(sandboxId, opts?.cwd ?? this.workspaceRoot);
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn("/bin/bash", ["-c", command], {
      detached: process.platform !== "win32",
      cwd,
      env: this.envFor(sandboxId, opts?.env),
    });
    this.track(sandboxId, child);
    return this.collect(child, (opts?.timeout ?? 120) * 1_000);
  }

  async uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    const base = this.resolvePath(sandboxId, basePath);
    for (const [relativePath, content] of Object.entries(files)) {
      const filePath = path.join(base, relativePath);
      fs.mkdirSync(path.dirname(filePath), { recursive: true });
      fs.writeFileSync(filePath, content);
    }
  }

  async downloadFile(sandboxId: string, filePath: string): Promise<string> {
    return fs.readFileSync(this.resolvePath(sandboxId, filePath), "utf-8");
  }

  async gitClone(
    sandboxId: string,
    url: string,
    clonePath: string,
    opts?: GitCloneOpts,
  ): Promise<void> {
    const cloneUrl = withCredentials(url, opts);
    const target = this.resolvePath(sandboxId, clonePath);
    const args = ["clone"];
    if (opts?.branch) args.push("--branch", opts.branch);
    args.push(cloneUrl, target);
    const clone = await this.git(sandboxId, args, 120_000);
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed: ${clone.result}`);
    }
    if (opts?.commitId) {
      await this.gitCheckout(sandboxId, clonePath, opts.commitId);
    }
  }

  async gitCheckout(
    sandboxId: string,
    repoPath: string,
    ref: string,
  ): Promise<void> {
    const result = await this.git(
      sandboxId,
      ["-C", this.resolvePath(sandboxId, repoPath), "checkout", ref],
      60_000,
    );
    if (result.exitCode !== 0) {
      throw new Error(`git checkout failed: ${result.result}`);
    }
  }

  /**
   * Serve a container sandbox's Docker endpoint, again after this process
   * restarts. Its socket sits beside the sandbox (or in the temp dir when
   * that path is too long for a Unix socket).
   */
  private async ensureDocker(sandboxId: string): Promise<void> {
    const docker = this.docker;
    const directory = path.join(this.root, sandboxId);
    if (!docker || !fs.existsSync(path.join(directory, CONTAINERS_MARKER)))
      return;
    let proxy = this.dockerProxies.get(sandboxId);
    if (!proxy) {
      const beside = path.join(directory, "docker.sock");
      const socketPath =
        Buffer.byteLength(beside) < 100
          ? beside
          : path.join(os.tmpdir(), `work-docker-${sandboxId}.sock`);
      proxy = startDockerProxy({
        upstreamSocket: docker.socketPath,
        socketPath,
        owner: sandboxId,
        bindRoots: [directory],
      });
      this.dockerProxies.set(sandboxId, proxy);
      proxy.catch(() => this.dockerProxies.delete(sandboxId));
    }
    const { socketPath } = await proxy;
    const entry = this.sandboxes.get(sandboxId) ?? { envVars: {} };
    entry.envVars.DOCKER_HOST = `unix://${socketPath}`;
    this.sandboxes.set(sandboxId, entry);
  }

  private async startProcess(args: StartProcessArgs): Promise<SandboxProcess> {
    this.requireRunning(args.sandboxId);
    await this.ensureDocker(args.sandboxId);
    const virtualCwd = args.cwd ?? this.workspaceRoot;
    const cwd = this.resolvePath(args.sandboxId, virtualCwd);
    fs.mkdirSync(cwd, { recursive: true });
    const processId = newProcessId();
    const logs = path.join(this.root, args.sandboxId, "processes");
    fs.mkdirSync(logs, { recursive: true });
    const log = path.join(logs, `${processId}.log`);
    // The child writes straight to the log, so output never passes
    // through (or depends on) this process.
    const fd = fs.openSync(log, "a");
    let child: ChildProcess;
    try {
      child = spawn("/bin/bash", ["-c", args.command], {
        detached: process.platform !== "win32",
        cwd,
        env: this.envFor(args.sandboxId, args.env),
        stdio: [args.stdin ? "pipe" : "ignore", fd, fd],
      });
    } finally {
      fs.closeSync(fd);
    }
    const record: SandboxProcess = {
      processId,
      sandboxId: args.sandboxId,
      command: args.command,
      ...(args.name ? { name: args.name } : {}),
      cwd: virtualCwd,
      status: "running",
      exitCode: null,
      signal: null,
      startedAt: new Date().toISOString(),
      endedAt: null,
      outputBytes: 0,
    };
    const entry = { process: record, child, log };
    const ended = (exitCode: number | null, signal?: NodeJS.Signals | null) => {
      if (entry.process.status === "exited") return;
      entry.process.status = "exited";
      entry.process.exitCode = exitCode;
      entry.process.signal ??=
        PROCESS_SIGNALS.find((known) => known === signal) ?? null;
      entry.process.endedAt = new Date().toISOString();
    };
    child.once("exit", (code, signal) => ended(code, signal));
    // Writing to a process that stopped reading is not this host's error.
    child.stdin?.on("error", () => {});
    child.once("error", (error) => {
      fs.appendFileSync(log, `${error.message}\n`);
      ended(127);
    });
    this.track(args.sandboxId, child);
    const processes = this.background.get(args.sandboxId) ?? new Map();
    this.background.set(args.sandboxId, processes);
    processes.set(processId, entry);
    return this.snapshot(entry);
  }

  private async readProcessOutput(
    args: ReadProcessOutputArgs,
  ): Promise<ProcessOutput> {
    const entry = this.backgroundProcess(args);
    const bounds = processReadBounds(args);
    const deadline = Date.now() + bounds.waitMs;
    while (
      entry.process.status === "running" &&
      logSize(entry.log) <= bounds.cursor &&
      Date.now() < deadline
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // Status before bytes: an exited process's log is already complete.
    const status = entry.process.status;
    const size = logSize(entry.log);
    const cursor = Math.min(bounds.cursor, size);
    const length = Math.min(size - cursor, bounds.maxBytes);
    const bytes = new Uint8Array(length);
    if (length > 0) {
      const fd = fs.openSync(entry.log, "r");
      try {
        fs.readSync(fd, bytes, 0, length, cursor);
      } finally {
        fs.closeSync(fd);
      }
    }
    const more = size - cursor > length;
    const decoded = decodeUtf8Prefix(bytes, status === "exited" && !more);
    return {
      processId: entry.process.processId,
      chunk: decoded.text,
      cursor,
      nextCursor: cursor + decoded.bytes,
      more,
      outputBytes: size,
      status,
      exitCode: status === "exited" ? entry.process.exitCode : null,
      signal: entry.process.signal,
    };
  }

  private async signalProcess(
    args: SignalProcessArgs,
  ): Promise<SandboxProcess> {
    if (!PROCESS_SIGNALS.includes(args.signal))
      throw new Error(`Unsupported signal '${args.signal}'`);
    const entry = this.backgroundProcess(args);
    if (entry.process.status === "running" && entry.child.pid) {
      entry.process.signal = args.signal;
      try {
        if (process.platform === "win32") entry.child.kill(args.signal);
        else process.kill(-entry.child.pid, args.signal);
      } catch (error) {
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "ESRCH" || error.code === "EPERM")
          )
        )
          throw error;
      }
    }
    return this.snapshot(entry);
  }

  private async writeProcessInput(args: WriteProcessInputArgs): Promise<void> {
    assertWriteSize(args.data);
    const entry = this.backgroundProcess(args);
    const input = entry.child.stdin;
    if (!input) throw new Error("The process was started without input");
    if (input.writableEnded) throw new Error("The process input is closed");
    // A process that already exited drops what it was sent, like a pipe.
    if (entry.process.status === "exited") return;
    await new Promise<void>((resolve) => {
      const done = () => resolve();
      input.once("error", done);
      if (args.end) input.end(args.data, done);
      else if (input.write(args.data)) done();
      else input.once("drain", done);
    });
  }

  private backgroundProcess(args: { sandboxId: string; processId: string }) {
    assertProcessId(args.processId);
    const entry = this.background.get(args.sandboxId)?.get(args.processId);
    if (!entry) throw new Error(`Unknown process '${args.processId}'`);
    return entry;
  }

  private snapshot(entry: {
    process: SandboxProcess;
    log: string;
  }): SandboxProcess {
    return { ...entry.process, outputBytes: logSize(entry.log) };
  }

  /**
   * Map a virtual `/workspace/...` path onto this sandbox's directory. Paths
   * outside the virtual root (after normalization, e.g. the runtime dir
   * `<workspace>/../runtime`) live as siblings inside the sandbox dir.
   */
  private resolvePath(sandboxId: string, virtualPath: string): string {
    const sandboxDir = path.join(this.root, sandboxId);
    const normalized = path.posix.normalize(virtualPath);
    if (!normalized.startsWith("/")) {
      throw new Error(
        `Sandbox paths must be absolute (virtual ${this.workspaceRoot}/...), got '${virtualPath}'`,
      );
    }
    const relative = path.posix.relative(this.workspaceRoot, normalized);
    const mapped = path.join(sandboxDir, "workspace", relative);
    const resolved = path.resolve(mapped);
    if (
      resolved !== sandboxDir &&
      !resolved.startsWith(sandboxDir + path.sep)
    ) {
      throw new Error(`Path '${virtualPath}' escapes sandbox '${sandboxId}'`);
    }
    return resolved;
  }

  private envFor(
    sandboxId: string,
    callEnv?: Record<string, string>,
  ): Record<string, string> {
    const sandboxDir = path.join(this.root, sandboxId);
    // Explicit env only (ADR 0047): base exec plumbing + sandbox-scoped
    // dirs + what the caller passes. Never process.env.
    return {
      ...this.baseEnv,
      HOME: path.join(sandboxDir, "home"),
      TMPDIR: path.join(sandboxDir, "tmp"),
      ...(this.sandboxes.get(sandboxId)?.envVars ?? {}),
      ...(callEnv ?? {}),
    };
  }

  private requireRunning(sandboxId: string): void {
    this.requireSandboxDir(sandboxId);
    if (this.stopped.has(sandboxId))
      throw new Error(`Sandbox '${sandboxId}' is stopped`);
  }

  private track(sandboxId: string, child: ChildProcess): void {
    const children = this.children.get(sandboxId) ?? new Set<ChildProcess>();
    this.children.set(sandboxId, children);
    children.add(child);
    // Commands own their process group. Detached grandchildren must not outlive
    // completion and consume untracked resources in this trusted backend.
    child.once("exit", () => this.killProcessTree(child));
    child.once("close", () => {
      children.delete(child);
      if (children.size === 0) this.children.delete(sandboxId);
    });
  }

  private killProcessTree(child: ChildProcess): void {
    if (child.pid && process.platform !== "win32") {
      try {
        process.kill(-child.pid, "SIGKILL");
      } catch (error) {
        // ESRCH: the group is gone. EPERM: macOS answers so for a group
        // whose members are all exited, waiting to be reaped.
        if (
          !(
            error instanceof Error &&
            "code" in error &&
            (error.code === "ESRCH" || error.code === "EPERM")
          )
        )
          throw error;
      }
    } else child.kill("SIGKILL");
  }

  private requireSandboxDir(sandboxId: string): void {
    if (!fs.existsSync(path.join(this.root, sandboxId))) {
      throw new Error(`Sandbox '${sandboxId}' not found under ${this.root}`);
    }
  }

  private git(
    sandboxId: string,
    args: string[],
    timeoutMs: number,
  ): Promise<ExecResult> {
    this.requireRunning(sandboxId);
    const child = spawn("git", args, {
      detached: process.platform !== "win32",
      cwd: path.join(this.root, sandboxId),
      env: this.envFor(sandboxId),
    });
    this.track(sandboxId, child);
    return this.collect(child, timeoutMs);
  }

  private collect(child: ChildProcess, timeoutMs: number): Promise<ExecResult> {
    return new Promise((resolve, reject) => {
      let stdout = "";
      let stderr = "";
      let bytes = 0;
      let timedOut = false;
      const timer = setTimeout(() => {
        timedOut = true;
        this.killProcessTree(child);
      }, timeoutMs);
      const append = (target: "out" | "err", chunk: Buffer) => {
        bytes += chunk.length;
        if (bytes > MAX_OUTPUT_BYTES) return;
        if (target === "out") stdout += chunk.toString();
        else stderr += chunk.toString();
      };
      child.stdout?.on("data", (chunk: Buffer) => append("out", chunk));
      child.stderr?.on("data", (chunk: Buffer) => append("err", chunk));
      child.on("error", (error) => {
        clearTimeout(timer);
        reject(error);
      });
      child.on("close", (code) => {
        clearTimeout(timer);
        const result =
          stderr.length > 0
            ? `${stdout}${stdout ? "\n" : ""}${stderr}`
            : stdout;
        if (timedOut) {
          resolve({
            exitCode: 124,
            result: `${result}\n[local-process] command timed out after ${timeoutMs}ms`,
          });
          return;
        }
        resolve({ exitCode: code ?? 1, result });
      });
    });
  }

  private spawnSupervisor(
    sandboxId: string,
    runtimeDirectory: string,
    env: Record<string, string>,
  ): SupervisorProcessHandle {
    this.requireRunning(sandboxId);
    const cwd = this.resolvePath(sandboxId, runtimeDirectory);
    // The supervisor env crosses resolvePath too: its CATAMORPHIC_RUNTIME_*
    // roots are virtual /workspace paths that must land on real dirs.
    const mappedEnv = Object.fromEntries(
      Object.entries(env).map(([name, value]) => [
        name,
        name === "CATAMORPHIC_RUNTIME_ARTIFACT_ROOT" ||
        name === "CATAMORPHIC_RUNTIME_WRITABLE_ROOT"
          ? this.resolvePath(sandboxId, value)
          : value,
      ]),
    );
    const child = spawn("bun", ["run", "entry.mjs"], {
      detached: process.platform !== "win32",
      cwd,
      env: this.envFor(sandboxId, mappedEnv),
      stdio: ["pipe", "pipe", "inherit"],
    });
    this.track(sandboxId, child);
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      kill: async () => {
        this.killProcessTree(child);
      },
      stdout: child.stdout,
    };
  }
}

function logSize(file: string): number {
  return fs.statSync(file, { throwIfNoEntry: false })?.size ?? 0;
}

function withCredentials(url: string, opts?: GitCloneOpts): string {
  if (!opts?.username && !opts?.password) return url;
  const parsed = new URL(url);
  if (opts.username) parsed.username = opts.username;
  if (opts.password) parsed.password = opts.password;
  return parsed.toString();
}

function restoreOwnerWrite(directory: string): void {
  const stat = fs.lstatSync(directory, { throwIfNoEntry: false });
  if (!stat?.isDirectory()) return;
  if (!(stat.mode & 0o200)) fs.chmodSync(directory, stat.mode | 0o700);
  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (entry.isDirectory())
      restoreOwnerWrite(path.join(directory, entry.name));
  }
}
