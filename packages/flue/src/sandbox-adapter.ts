import type { SandboxProvider } from "@catamorphic/sandbox";
import type {
  FileStat,
  SandboxApi,
  SandboxFactory,
  SessionEnv,
} from "@flue/runtime";
import { createSandboxSessionEnv } from "@flue/runtime";

export interface CatamorphicSandboxOpts {
  provider: SandboxProvider;
  /** Provider-specific sandbox id (`SandboxHandle.providerId`). */
  sandboxId: string;
}

/**
 * Flue sandbox adapter over a catamorphic `SandboxProvider`. The Flue agent
 * runs **on the host server**; every shell command and file operation it
 * performs is forwarded to the remote dev sandbox (e.g. Cloudflare Sandbox
 * via the Bridge Worker).
 *
 * This is a shell-native adapter: the provider contract only exposes
 * exec/upload/download, so directory and stat operations go through standard
 * POSIX commands inside the sandbox.
 */
export function catamorphicSandbox(
  opts: CatamorphicSandboxOpts,
): SandboxFactory {
  return {
    async createSessionEnv(): Promise<SessionEnv> {
      const api = new ProviderSandboxApi(opts.provider, opts.sandboxId);
      return createSandboxSessionEnv(api, opts.provider.workspaceRoot);
    },
  };
}

class ProviderSandboxApi implements SandboxApi {
  constructor(
    private readonly provider: SandboxProvider,
    private readonly sandboxId: string,
  ) {}

  async readFile(path: string): Promise<string> {
    return this.provider.downloadFile(this.sandboxId, path);
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const result = await this.mustExec(`base64 < ${quote(path)}`);
    return new Uint8Array(Buffer.from(result.trim(), "base64"));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    if (typeof content === "string") {
      await this.provider.uploadFiles(
        this.sandboxId,
        { [stripLeadingSlash(path)]: content },
        "",
      );
      return;
    }
    const encoded = Buffer.from(content).toString("base64");
    await this.mustExec(
      `printf '%s' ${quote(encoded)} | base64 -d > ${quote(path)}`,
    );
  }

  async stat(path: string): Promise<FileStat> {
    const result = await this.exec(
      `stat -c '%F|%s|%Y' ${quote(path)} 2>/dev/null || stat -f '%HT|%z|%m' ${quote(path)}`,
    );
    if (result.exitCode !== 0) {
      throw new Error(`stat failed for ${path}: ${result.stdout}`);
    }
    const [kind = "", size = "", mtime = ""] = result.stdout.trim().split("|");
    const normalized = kind.toLowerCase();
    return {
      isFile: normalized.includes("file"),
      isDirectory: normalized.includes("directory"),
      isSymbolicLink: normalized.includes("link") || undefined,
      size: Number.isNaN(Number(size)) ? undefined : Number(size),
      mtime: Number.isNaN(Number(mtime))
        ? undefined
        : new Date(Number(mtime) * 1000),
    };
  }

  async readdir(path: string): Promise<string[]> {
    const result = await this.mustExec(`ls -1A ${quote(path)}`);
    return result
      .split("\n")
      .map((line) => line.trim())
      .filter((line) => line.length > 0);
  }

  async exists(path: string): Promise<boolean> {
    const result = await this.exec(`test -e ${quote(path)}`);
    return result.exitCode === 0;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    const flag = options?.recursive ? "-p " : "";
    await this.mustExec(`mkdir ${flag}${quote(path)}`);
  }

  async rm(
    path: string,
    options?: { recursive?: boolean; force?: boolean },
  ): Promise<void> {
    const flags = [
      options?.recursive ? "-r" : undefined,
      options?.force ? "-f" : undefined,
    ]
      .filter((f): f is string => f !== undefined)
      .join(" ");
    await this.mustExec(`rm ${flags ? `${flags} ` : ""}${quote(path)}`);
  }

  async exec(
    command: string,
    options?: {
      cwd?: string;
      env?: Record<string, string>;
      timeoutMs?: number;
      signal?: AbortSignal;
    },
  ): Promise<{ stdout: string; stderr: string; exitCode: number }> {
    // The provider contract doesn't forward env vars, so inline them as
    // shell assignments. Values are single-quoted; the command runs via
    // `sh -lc` inside the sandbox.
    const envPrefix = Object.entries(options?.env ?? {})
      .map(([key, value]) => `${key}=${quote(value)}`)
      .join(" ");
    const full = envPrefix ? `export ${envPrefix}; ${command}` : command;

    const result = await this.provider.executeCommand(this.sandboxId, full, {
      cwd: options?.cwd,
      timeout:
        options?.timeoutMs === undefined
          ? undefined
          : Math.ceil(options.timeoutMs / 1000),
    });

    // The bridge interleaves stdout + stderr into one stream.
    return { stdout: result.result, stderr: "", exitCode: result.exitCode };
  }

  private async mustExec(command: string): Promise<string> {
    const result = await this.exec(command);
    if (result.exitCode !== 0) {
      throw new Error(
        `Sandbox command failed (${result.exitCode}): ${command}\n${result.stdout}`,
      );
    }
    return result.stdout;
  }
}

function stripLeadingSlash(path: string): string {
  return path.replace(/^\/+/, "");
}

function quote(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./_-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}
