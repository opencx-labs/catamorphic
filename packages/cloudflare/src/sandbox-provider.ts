import {
  CommandDeploymentRuntimeProvider,
  type CreateSandboxOpts,
  type DeploymentRuntimeProvider,
  type ExecOpts,
  type ExecResult,
  type GitCloneOpts,
  type SandboxHandle,
  type SandboxProvider,
  type SandboxStatus,
} from "@catamorphic/sandbox";

export interface CloudflareSandboxProviderOpts {
  /**
   * Base URL of the deployed Bridge Worker (e.g. `https://catamorphic-sandbox-bridge.<sub>.workers.dev`
   * or `http://localhost:8787` during local dev).
   */
  apiUrl: string;
  /**
   * Shared bearer key — must equal the Bridge Worker's `SANDBOX_API_KEY`
   * secret. Optional (and elided from the Authorization header when unset) so
   * local dev against a bridge without the secret Just Works.
   */
  apiKey?: string;
  /**
   * Override the global fetch implementation. Primarily a testing hook.
   */
  fetch?: typeof fetch;
}

interface BridgeErrorBody {
  error?: string;
  code?: string;
}

export class CloudflareSandboxError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(opts: {
    message: string;
    status: number;
    code?: string;
  }) {
    super(opts.message);
    this.name = "CloudflareSandboxError";
    this.status = opts.status;
    this.code = opts.code;
  }
}

export class CloudflareSandboxProvider implements SandboxProvider {
  readonly workspaceRoot = "/workspace";
  readonly deploymentRuntime: DeploymentRuntimeProvider;

  private readonly apiUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CloudflareSandboxProviderOpts) {
    this.apiUrl = opts.apiUrl.replace(/\/+$/, "");
    this.apiKey = opts.apiKey;
    this.fetchImpl = opts.fetch ?? globalThis.fetch.bind(globalThis);
    this.deploymentRuntime = new CommandDeploymentRuntimeProvider({
      provider: this,
    });
  }

  async createSandbox(_opts: CreateSandboxOpts): Promise<SandboxHandle> {
    const response = await this.request("POST", "/v1/sandbox");
    const body = (await response.json()) as { id: string };
    return {
      id: body.id,
      providerId: body.id,
      sandboxType: "execution",
      status: "started",
    };
  }

  async startSandbox(_sandboxId: string): Promise<void> {
    // Cloudflare sandbox containers start lazily on first operation and
    // auto-wake from sleep; nothing to do here.
  }

  async stopSandbox(_sandboxId: string): Promise<void> {
    // No explicit stop — containers sleep automatically after `sleepAfter`
    // (default 10m). Callers that need to reclaim resources immediately
    // should use `destroySandbox` instead.
  }

  async destroySandbox(sandboxId: string): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/v1/sandbox/${encodeURIComponent(sandboxId)}`,
      { allowStatus: [204, 404] },
    );
    // Drain the body so the connection can be reused.
    await response.arrayBuffer();
  }

  async getSandboxStatus(sandboxId: string): Promise<SandboxStatus> {
    const response = await this.request(
      "GET",
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/running`,
    );
    const body = (await response.json()) as { running: boolean };
    return body.running ? "started" : "stopped";
  }

  async executeCommand(
    sandboxId: string,
    command: string,
    opts?: ExecOpts,
  ): Promise<ExecResult> {
    const sessionId =
      opts?.env && Object.keys(opts.env).length > 0
        ? await this.createSession(sandboxId, opts)
        : undefined;
    const payload: Record<string, unknown> = {
      argv: ["sh", "-lc", command],
    };
    if (typeof opts?.timeout === "number") {
      payload.timeout_ms = opts.timeout * 1000;
    }
    if (!sessionId && typeof opts?.cwd === "string") {
      payload.cwd = opts.cwd;
    }

    try {
      const response = await this.request(
        "POST",
        `/v1/sandbox/${encodeURIComponent(sandboxId)}/exec`,
        {
          body: JSON.stringify(payload),
          headers: {
            "Content-Type": "application/json",
            ...(sessionId ? { "Session-Id": sessionId } : {}),
          },
        },
      );
      return await consumeExecSse(response);
    } finally {
      if (sessionId) {
        await this.deleteSession(sandboxId, sessionId).catch(() => {});
      }
    }
  }

  async uploadFiles(
    sandboxId: string,
    files: Record<string, string>,
    basePath: string,
  ): Promise<void> {
    const root = basePath.replace(/\/+$/, "");
    // Serialize on purpose: concurrent PUTs against sibling paths in the
    // same sandbox occasionally drop files silently (observed in local
    // `wrangler dev`). For bulk uploads use `hydrateWorkspace` with a tar.
    for (const [relative, content] of Object.entries(files)) {
      const absolute = root ? `${root}/${relative}` : `/${relative}`;
      await this.writeFile(sandboxId, absolute, content);
    }
  }

  async downloadFile(sandboxId: string, filePath: string): Promise<string> {
    const route = buildFileRoute(sandboxId, filePath);
    const response = await this.request("GET", route);
    const buffer = await response.arrayBuffer();
    return new TextDecoder("utf-8").decode(new Uint8Array(buffer));
  }

  async gitClone(
    sandboxId: string,
    url: string,
    targetPath: string,
    opts?: GitCloneOpts,
  ): Promise<void> {
    const args: string[] = ["git", "clone"];
    if (opts?.branch) {
      args.push("--branch", opts.branch);
    }

    const authedUrl =
      opts?.username || opts?.password
        ? injectBasicAuth(url, opts.username, opts.password)
        : url;

    args.push(authedUrl, targetPath);

    const clone = await this.executeCommand(sandboxId, shellJoin(args));
    if (clone.exitCode !== 0) {
      throw new CloudflareSandboxError({
        message: `git clone failed: ${clone.result}`,
        status: 500,
        code: "git_clone_failed",
      });
    }

    if (opts?.commitId) {
      await this.gitCheckout(sandboxId, targetPath, opts.commitId);
    }
  }

  async gitCheckout(
    sandboxId: string,
    path: string,
    ref: string,
  ): Promise<void> {
    const result = await this.executeCommand(
      sandboxId,
      `git checkout ${shellQuote(ref)}`,
      { cwd: path },
    );
    if (result.exitCode !== 0) {
      throw new CloudflareSandboxError({
        message: `git checkout failed: ${result.result}`,
        status: 500,
        code: "git_checkout_failed",
      });
    }
  }

  /**
   * Bulk-populate the sandbox's `/workspace` directory from a tar archive.
   * Preferred for large file-tree uploads (single request instead of one
   * per file). The destination is always `/workspace` — extract under a
   * subdirectory by tarring with that prefix.
   */
  async hydrateWorkspace(sandboxId: string, tar: Uint8Array): Promise<void> {
    await this.request(
      "POST",
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/hydrate`,
      {
        body: tar,
        headers: { "Content-Type": "application/octet-stream" },
      },
    );
  }

  private async writeFile(
    sandboxId: string,
    absolutePath: string,
    content: string,
  ): Promise<void> {
    const route = buildFileRoute(sandboxId, absolutePath);
    await this.request("PUT", route, {
      body: content,
      headers: { "Content-Type": "application/octet-stream" },
    });
  }

  private async createSession(
    sandboxId: string,
    opts: ExecOpts,
  ): Promise<string> {
    const response = await this.request(
      "POST",
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/session`,
      {
        body: JSON.stringify({ cwd: opts.cwd, env: opts.env }),
        headers: { "Content-Type": "application/json" },
      },
    );
    const body = (await response.json()) as { id: string };
    return body.id;
  }

  private async deleteSession(
    sandboxId: string,
    sessionId: string,
  ): Promise<void> {
    const response = await this.request(
      "DELETE",
      `/v1/sandbox/${encodeURIComponent(sandboxId)}/session/${encodeURIComponent(sessionId)}`,
      { allowStatus: [204, 404] },
    );
    await response.arrayBuffer();
  }

  private async request(
    method: string,
    path: string,
    init: {
      body?: string | Uint8Array;
      headers?: Record<string, string>;
      allowStatus?: number[];
    } = {},
  ): Promise<Response> {
    const headers: Record<string, string> = { ...(init.headers ?? {}) };
    if (this.apiKey) {
      headers.Authorization = `Bearer ${this.apiKey}`;
    }

    const response = await this.fetchImpl(`${this.apiUrl}${path}`, {
      method,
      headers,
      body: init.body,
    });

    const allow = init.allowStatus ?? [];
    if (!response.ok && !allow.includes(response.status)) {
      const errorBody = await safeJson<BridgeErrorBody>(response);
      throw new CloudflareSandboxError({
        message:
          errorBody?.error ??
          `Cloudflare sandbox bridge request failed: ${method} ${path} → ${response.status}`,
        status: response.status,
        code: errorBody?.code,
      });
    }

    return response;
  }
}

async function safeJson<T>(response: Response): Promise<T | undefined> {
  try {
    return (await response.clone().json()) as T;
  } catch {
    return undefined;
  }
}

function buildFileRoute(sandboxId: string, absolutePath: string): string {
  if (!absolutePath.startsWith("/")) {
    throw new CloudflareSandboxError({
      message: `File path must be absolute (got ${absolutePath})`,
      status: 400,
      code: "invalid_path",
    });
  }
  const segments = absolutePath
    .split("/")
    .filter((segment) => segment.length > 0)
    .map(encodePathSegment);
  return `/v1/sandbox/${encodeURIComponent(sandboxId)}/file/${segments.join("/")}`;
}

// The bridge writes each decoded URL path segment to disk verbatim, so
// `encodeURIComponent("@acme")` ends up as a `%40acme` directory and
// breaks module resolution for scoped packages. `@` is a valid pchar per
// RFC 3986 and doesn't need escaping in paths — decode it back after encoding.
function encodePathSegment(segment: string): string {
  return encodeURIComponent(segment).replace(/%40/g, "@");
}

function injectBasicAuth(
  url: string,
  username?: string,
  password?: string,
): string {
  try {
    const parsed = new URL(url);
    if (username) parsed.username = username;
    if (password) parsed.password = password;
    return parsed.toString();
  } catch {
    return url;
  }
}

function shellQuote(value: string): string {
  if (/^[A-Za-z0-9@%+=:,./-]+$/.test(value)) return value;
  return `'${value.replace(/'/g, `'\\''`)}'`;
}

function shellJoin(args: string[]): string {
  return args.map(shellQuote).join(" ");
}

async function consumeExecSse(response: Response): Promise<ExecResult> {
  if (!response.body) {
    throw new CloudflareSandboxError({
      message: "Exec response had no body",
      status: response.status,
      code: "exec_no_body",
    });
  }

  const reader = response.body.getReader();
  const decoder = new TextDecoder("utf-8");
  const chunks: string[] = [];
  let pending = "";
  let exitCode: number | undefined;
  let errorMessage: string | undefined;

  const handleEvent = (event: string, dataLines: string[]) => {
    const data = dataLines.join("\n");
    if (event === "stdout" || event === "stderr") {
      const decoded = tryDecodeBase64(data);
      if (decoded !== undefined) chunks.push(decoded);
      return;
    }
    if (event === "exit") {
      try {
        const parsed = JSON.parse(data) as { exit_code?: number };
        if (typeof parsed.exit_code === "number") exitCode = parsed.exit_code;
      } catch {
        // ignore malformed
      }
      return;
    }
    if (event === "error") {
      try {
        const parsed = JSON.parse(data) as { error?: string };
        errorMessage = parsed.error ?? "Unknown exec error";
      } catch {
        errorMessage = data || "Unknown exec error";
      }
    }
  };

  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    pending += decoder.decode(value, { stream: true });

    const events = pending.split("\n\n");
    pending = events.pop() ?? "";

    for (const raw of events) {
      if (!raw.trim()) continue;
      const lines = raw.split("\n");
      const eventLine = lines.find((l) => l.startsWith("event:")) ?? "";
      const event = eventLine.slice("event:".length).trim();
      const dataLines = lines
        .filter((l) => l.startsWith("data:"))
        .map((l) => l.slice("data:".length).replace(/^ /, ""));
      handleEvent(event, dataLines);
    }
  }

  pending += decoder.decode();
  if (pending.trim()) {
    const lines = pending.split("\n");
    const eventLine = lines.find((l) => l.startsWith("event:")) ?? "";
    const event = eventLine.slice("event:".length).trim();
    const dataLines = lines
      .filter((l) => l.startsWith("data:"))
      .map((l) => l.slice("data:".length).replace(/^ /, ""));
    if (event) handleEvent(event, dataLines);
  }

  if (errorMessage !== undefined) {
    throw new CloudflareSandboxError({
      message: errorMessage,
      status: 502,
      code: "exec_error",
    });
  }

  return {
    exitCode: exitCode ?? 1,
    result: chunks.join(""),
  };
}

function tryDecodeBase64(value: string): string | undefined {
  try {
    if (typeof Buffer !== "undefined") {
      return Buffer.from(value, "base64").toString("utf-8");
    }
    const binary = atob(value);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
      bytes[i] = binary.charCodeAt(i);
    }
    return new TextDecoder("utf-8").decode(bytes);
  } catch {
    return undefined;
  }
}
