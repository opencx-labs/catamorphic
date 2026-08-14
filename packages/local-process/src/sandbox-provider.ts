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
  SandboxHandle,
  SandboxProvider,
  SandboxStatus,
  SupervisorProcessHandle,
} from "@catamorphic/sandbox";
import { StdioDeploymentRuntimeProvider } from "@catamorphic/sandbox";

const MAX_OUTPUT_BYTES = 16 * 1024 * 1024;

export interface LocalProcessProviderConfig {
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
}

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
  readonly workspaceRoot = "/workspace";
  readonly deploymentRuntime: DeploymentRuntimeProvider;
  private readonly root: string;
  private readonly baseEnv: Record<string, string>;
  private readonly sandboxes = new Map<
    string,
    { envVars: Record<string, string>; destroyed: boolean }
  >();

  constructor(config?: LocalProcessProviderConfig) {
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
    const id = `local-${crypto.randomUUID().slice(0, 12)}`;
    for (const dir of ["workspace", "home", "tmp"]) {
      fs.mkdirSync(path.join(this.root, id, dir), { recursive: true });
    }
    this.sandboxes.set(id, { envVars: opts.envVars ?? {}, destroyed: false });
    return { id, providerId: id, sandboxType: "execution", status: "started" };
  }

  async startSandbox(sandboxId: string): Promise<void> {
    this.requireSandboxDir(sandboxId);
  }

  async stopSandbox(_sandboxId: string): Promise<void> {}

  async destroySandbox(sandboxId: string): Promise<void> {
    const state = this.sandboxes.get(sandboxId);
    if (state) state.destroyed = true;
    fs.rmSync(path.join(this.root, sandboxId), {
      recursive: true,
      force: true,
    });
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    return fs.existsSync(path.join(this.root, sandboxId))
      ? "started"
      : "stopped";
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const cwd = this.resolvePath(sandboxId, opts?.cwd ?? this.workspaceRoot);
    fs.mkdirSync(cwd, { recursive: true });
    const child = spawn("/bin/bash", ["-c", command], {
      cwd,
      env: this.envFor(sandboxId, opts?.env),
    });
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
    const child = spawn("git", args, {
      cwd: path.join(this.root, sandboxId),
      env: this.envFor(sandboxId),
    });
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
        child.kill("SIGKILL");
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
      cwd,
      env: this.envFor(sandboxId, mappedEnv),
      stdio: ["pipe", "pipe", "inherit"],
    });
    return {
      write: (data) =>
        new Promise<void>((resolve, reject) => {
          child.stdin.write(data, (error) =>
            error ? reject(error) : resolve(),
          );
        }),
      kill: async () => {
        child.kill("SIGKILL");
      },
      stdout: child.stdout,
    };
  }
}

function withCredentials(url: string, opts?: GitCloneOpts): string {
  if (!opts?.username && !opts?.password) return url;
  const parsed = new URL(url);
  if (opts.username) parsed.username = opts.username;
  if (opts.password) parsed.password = opts.password;
  return parsed.toString();
}
