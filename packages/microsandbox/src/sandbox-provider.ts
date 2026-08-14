import type {
  CreateSandboxOpts,
  DeploymentRuntimeProvider,
  ExecOpts,
  ExecResult,
  GitCloneOpts,
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
} from "@catamorphic/sandbox";
import { Sandbox } from "microsandbox";
import { msbStdioRuntimeProvider } from "./stdio-runtime-provider.js";

const DEFAULT_IMAGE = "oven/bun";
const DEFAULT_MEMORY_MIB = 1024;
const DEFAULT_CPUS = 1;

function mapMsbStatus(
  status: "running" | "stopped" | "crashed" | "draining",
): SandboxStatus {
  switch (status) {
    case "running":
    case "draining":
      return "started";
    case "stopped":
      return "stopped";
    case "crashed":
      return "error";
  }
}

export interface MicrosandboxProviderConfig {
  image?: string;
  memoryMib?: number;
  cpus?: number;
  /** Seconds of inactivity before the sandbox auto-stops. */
  idleTimeoutSeconds?: number;
  namePrefix?: string;
  /**
   * Shell command run once inside every new sandbox before it is handed to
   * the caller. Defaults to installing git when the image lacks it — core's
   * agent sessions require git for change detection, and common runtime
   * images (oven/bun) don't ship it. Pass an empty string to disable.
   */
  setupCommand?: string;
}

/** Runs once per new sandbox; ~20s on first use, no-op when git exists. */
const DEFAULT_SETUP_COMMAND =
  "command -v git >/dev/null 2>&1 || " +
  "(apt-get update -qq && apt-get install -y -qq git)";

export class MicrosandboxSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly deploymentRuntime: DeploymentRuntimeProvider;
  private readonly config: Required<MicrosandboxProviderConfig>;
  private readonly connections = new Map<string, Sandbox>();

  constructor(config?: MicrosandboxProviderConfig) {
    this.config = {
      image: config?.image ?? DEFAULT_IMAGE,
      memoryMib: config?.memoryMib ?? DEFAULT_MEMORY_MIB,
      cpus: config?.cpus ?? DEFAULT_CPUS,
      idleTimeoutSeconds: config?.idleTimeoutSeconds ?? 15 * 60,
      namePrefix: config?.namePrefix ?? "cata",
      setupCommand: config?.setupCommand ?? DEFAULT_SETUP_COMMAND,
    };
    this.deploymentRuntime = msbStdioRuntimeProvider({
      connect: (sandboxId) => this.connect(sandboxId),
      uploadFiles: (sandboxId, files, basePath) =>
        this.uploadFiles(sandboxId, files, basePath),
    });
  }

  async createSandbox(opts: CreateSandboxOpts): Promise<SandboxHandle> {
    const name = `${this.config.namePrefix}-${crypto.randomUUID().slice(0, 12)}`;
    let builder = Sandbox.builder(name)
      .image(opts.snapshotName ?? this.config.image)
      .memory(this.config.memoryMib)
      .cpus(this.config.cpus)
      .idleTimeout(opts.autoStopInterval ?? this.config.idleTimeoutSeconds)
      // The workdir must exist before boot; images like oven/bun don't ship it.
      .patch((patch) => patch.mkdir(this.workspaceRoot, { mode: 0o755 }))
      .workdir(this.workspaceRoot)
      .detached(true);
    if (opts.envVars) builder = builder.envs(opts.envVars);
    if (opts.labels) builder = builder.labels(opts.labels);
    const sandbox = await builder.create();
    this.connections.set(name, sandbox);
    if (this.config.setupCommand) {
      const setup = await this.executeCommand(name, this.config.setupCommand, {
        timeout: 300,
      });
      if (setup.exitCode !== 0) {
        await this.destroySandbox(name).catch(() => {});
        throw new Error(`Sandbox setup command failed: ${setup.result}`);
      }
    }
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
    const sandbox = await handle.startDetached();
    this.connections.set(sandboxId, sandbox);
  }

  async stopSandbox(sandboxId: string): Promise<void> {
    this.connections.delete(sandboxId);
    const handle = await Sandbox.get(sandboxId);
    await handle.stop();
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    this.connections.delete(sandboxId);
    const handle = await Sandbox.get(sandboxId);
    if (handle.status === "running") await handle.killWithTimeout(0);
    await handle.remove();
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
    const cloneUrl = withCredentials(url, opts);
    const branchArg = opts?.branch
      ? ` --branch ${shellQuote(opts.branch)}`
      : "";
    const clone = await this.executeCommand(
      sandboxId,
      `git clone${branchArg} ${shellQuote(cloneUrl)} ${shellQuote(path)}`,
      { timeout: 120 },
    );
    if (clone.exitCode !== 0) {
      throw new Error(`git clone failed: ${clone.result}`);
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
        : await handle.startDetached();
    this.connections.set(sandboxId, sandbox);
    return sandbox;
  }
}

function withCredentials(url: string, opts?: GitCloneOpts): string {
  if (!opts?.username && !opts?.password) return url;
  const parsed = new URL(url);
  if (opts.username) parsed.username = opts.username;
  if (opts.password) parsed.password = opts.password;
  return parsed.toString();
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}
