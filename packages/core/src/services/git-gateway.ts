import { createGunzip } from "node:zlib";
import type { DB, Json } from "@catamorphic/db";
import { getTracer, withSpan } from "@catamorphic/otel";
import type { Kysely } from "kysely";
import type { Identity } from "../identity.js";
import {
  ConnectionActionDeniedError,
  ConnectionActionRefusedError,
  type ConnectionBroker,
} from "./connection-broker.js";
import type { ConnectionCapabilityGrantsService } from "./connection-capability-grants.js";
import type { ConnectionProviderRegistry } from "./connection-providers.js";
import type {
  ConnectionGitPolicy,
  ResolvedConnectionBinding,
} from "./connection-types.js";
import type { ConnectionsService } from "./connections-service.js";
import { ConnectionUnavailableError } from "./connections-service.js";
import type { ExecutionAllocationsService } from "./execution-allocations-service.js";
import {
  bindingRepositories,
  repositoryBelow,
  repositoryPath,
} from "./git-repositories.js";

const tracer = getTracer("@catamorphic/core");

/** Branches a push may update when a binding names no rules (ADR 0175). */
export const DEFAULT_PUSH_PATTERNS: readonly string[] = ["work/*"];

const ZERO = /^0+$/;
const MAX_COMMAND_BYTES = 1024 * 1024;
const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** One ref update a `git push` asks for. */
export interface RefUpdate {
  oldId: string;
  newId: string;
  ref: string;
}

/** What the Git client asked the gateway to do. */
export type GitGatewayOperation =
  | { kind: "advertise"; service: "git-upload-pack" | "git-receive-pack" }
  | { kind: "upload-pack" }
  | { kind: "receive-pack" };

export interface GitGatewayRequest {
  alias: string;
  /** Remote path below the provider's base URL, e.g. `org/repo.git`. */
  repositoryPath: string;
  operation: GitGatewayOperation;
  /** The `Authorization` header as sent. */
  authorization: string | undefined;
  headers: Readonly<Record<string, string | undefined>>;
  body?: AsyncIterable<Uint8Array>;
}

export interface GitGatewayResponse {
  status: number;
  headers: Record<string, string>;
  body: AsyncIterable<Uint8Array> | Uint8Array;
}

// --- pkt-line ---

export function pktLine(data: string | Uint8Array): Uint8Array {
  const payload = typeof data === "string" ? encoder.encode(data) : data;
  const length = (payload.length + 4).toString(16).padStart(4, "0");
  const line = new Uint8Array(payload.length + 4);
  line.set(encoder.encode(length), 0);
  line.set(payload, 4);
  return line;
}

export const FLUSH_PKT = encoder.encode("0000");

function concat(parts: readonly Uint8Array[]): Uint8Array {
  const total = parts.reduce((sum, part) => sum + part.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

/**
 * Read pkt-lines from the front of `buffer` until a flush-pkt. Returns the
 * payloads and the offset just past the flush, or null when the buffer does
 * not yet hold a flush.
 */
export function readPktSection(
  buffer: Uint8Array,
): { lines: Uint8Array[]; end: number } | null {
  const lines: Uint8Array[] = [];
  let offset = 0;
  while (offset + 4 <= buffer.length) {
    const size = Number.parseInt(
      decoder.decode(buffer.subarray(offset, offset + 4)),
      16,
    );
    if (Number.isNaN(size)) throw new Error("Malformed pkt-line");
    if (size === 0) return { lines, end: offset + 4 };
    if (size < 4) throw new Error("Unexpected pkt-line");
    if (offset + size > buffer.length) return null;
    lines.push(buffer.subarray(offset + 4, offset + size));
    offset += size;
  }
  return null;
}

/**
 * Whether `ref` is a full ref name Git itself would accept
 * (`git check-ref-format`): below `refs/`, no empty, dot-led or `.lock`
 * component, no `..`, `@{`, control characters, spaces or any of
 * `~^:?*[\`. The gateway matches push rules against this exact string, so
 * anything Git could read differently is refused rather than interpreted.
 */
export function isValidRefName(ref: string): boolean {
  if (!ref.startsWith("refs/") || ref.length > 1024) return false;
  if (ref.endsWith("/") || ref.endsWith(".")) return false;
  if (ref.includes("..") || ref.includes("@{") || ref.includes("//"))
    return false;
  for (const char of ref) {
    const code = char.charCodeAt(0);
    if (code <= 0x20 || code === 0x7f || "~^:?*[\\".includes(char))
      return false;
  }
  return ref
    .split("/")
    .every(
      (component) =>
        component.length > 0 &&
        !component.startsWith(".") &&
        !component.endsWith(".lock"),
    );
}

/**
 * Parse receive-pack's update commands (`<old> <new> <ref>`, the first one
 * carrying capabilities after a NUL). A shallow client first names its
 * shallow commits (`shallow <id>`); those pass through. Push certificates
 * and anything else are refused: the gateway only forwards what it can read.
 * Git ends a command's ref at its first NUL, so a NUL after the first
 * command, or any ref Git would not accept as written, is refused: the ref
 * the gateway reviews must be the ref the remote updates.
 */
export function parseReceivePackCommands(lines: readonly Uint8Array[]): {
  commands: RefUpdate[];
  capabilities: string[];
} {
  const texts = lines.map((raw) => decoder.decode(raw).replace(/\n$/, ""));
  const updates = texts.filter(
    (text) => !/^shallow ([0-9a-f]{40}|[0-9a-f]{64})$/.test(text),
  );
  const [firstCommand, caps] = (updates[0] ?? "").split("\0", 2);
  const commands = updates.map((text, index) => {
    const command = index === 0 ? firstCommand : text;
    const match =
      /^([0-9a-f]{40}|[0-9a-f]{64}) ([0-9a-f]{40}|[0-9a-f]{64}) (refs\/\S+)$/.exec(
        command ?? "",
      );
    if (!match?.[1] || !match[2] || !match[3] || !isValidRefName(match[3]))
      throw new GitGatewayError(400, "The gateway cannot read this push");
    return { oldId: match[1], newId: match[2], ref: match[3] };
  });
  return {
    commands,
    capabilities: caps?.split(" ").filter(Boolean) ?? [],
  };
}

/** The branch HEAD names in an upload-pack v0 advertisement, if any. */
export function advertisedDefaultBranch(body: Uint8Array): string | null {
  // "# service=..." section, then the ref section whose first line carries
  // capabilities, including `symref=HEAD:refs/heads/<branch>`.
  const first = readPktSection(body);
  const refs = first ? readPktSection(body.subarray(first.end)) : null;
  const line = refs?.lines[0] ?? first?.lines[0];
  if (!line) return null;
  const caps = decoder.decode(line).split("\0")[1] ?? "";
  const symref = /(?:^| )symref=HEAD:(\S+)/.exec(caps)?.[1];
  return symref && isValidRefName(symref) ? symref : null;
}

// --- policy ---

/** `org/repo.git/` → `org/repo`; refuses traversal and empty paths. */
export function normalizeRepositoryPath(value: string): string {
  const path = repositoryPath(value);
  if (!path) throw new GitGatewayError(404, "No such repository");
  return path;
}

export { repositoryBelow };

/** Whether `ref` matches a push rule: `work/*` or a full `refs/...` pattern. */
export function refMatches(ref: string, pattern: string): boolean {
  const full = pattern.startsWith("refs/") ? pattern : `refs/heads/${pattern}`;
  const expression = new RegExp(
    `^${full
      .split("*")
      .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
      .join(".*")}$`,
  );
  return expression.test(ref);
}

/**
 * Decide a push (ADR 0175): every update must match the binding's push
 * rules, none may touch the remote's default branch, and nothing is
 * deleted. A remote that names no default branch (no `symref=HEAD`, or an
 * unborn HEAD) is refused outright: the gateway cannot show the push spares
 * it. Returns the refusal reason for each ref, or null to allow.
 */
export function reviewPush(input: {
  commands: readonly RefUpdate[];
  patterns: readonly string[];
  defaultBranch: string | null;
}): Map<string, string> | null {
  const refusals = new Map<string, string>();
  for (const command of input.commands) {
    if (!input.defaultBranch) {
      refusals.set(
        command.ref,
        "the remote names no default branch, so the gateway cannot check this push",
      );
    } else if (ZERO.test(command.newId)) {
      refusals.set(
        command.ref,
        "Work does not delete refs through the gateway",
      );
    } else if (command.ref === input.defaultBranch) {
      refusals.set(
        command.ref,
        "the default branch is never pushed through the gateway; push a work/ branch and open a pull request",
      );
    } else if (
      !input.patterns.some((pattern) => refMatches(command.ref, pattern))
    ) {
      refusals.set(
        command.ref,
        `this session may push only ${input.patterns.join(", ")}`,
      );
    }
  }
  return refusals.size > 0 ? refusals : null;
}

/**
 * A receive-pack answer refusing every update, in the shape the client
 * asked for (report-status, over side-band when negotiated), so `git push`
 * prints `! [remote rejected] <ref> (<reason>)`.
 */
export function receivePackRefusal(input: {
  commands: readonly RefUpdate[];
  capabilities: readonly string[];
  reasons: ReadonlyMap<string, string>;
}): Uint8Array {
  const status = concat([
    pktLine("unpack ok\n"),
    ...input.commands.map((command) =>
      pktLine(
        `ng ${command.ref} ${
          input.reasons.get(command.ref) ?? "refused with the rest of this push"
        }\n`,
      ),
    ),
    FLUSH_PKT,
  ]);
  const sideBand =
    input.capabilities.includes("side-band-64k") ||
    input.capabilities.includes("side-band");
  if (!sideBand) return status;
  const chunk = input.capabilities.includes("side-band-64k") ? 65515 : 995;
  const parts: Uint8Array[] = [];
  const firstReason = [...input.reasons.values()][0];
  if (firstReason)
    parts.push(
      pktLine(concat([Uint8Array.of(2), encoder.encode(`${firstReason}\n`)])),
    );
  for (let offset = 0; offset < status.length; offset += chunk) {
    parts.push(
      pktLine(
        concat([Uint8Array.of(1), status.subarray(offset, offset + chunk)]),
      ),
    );
  }
  parts.push(FLUSH_PKT);
  return concat(parts);
}

// --- the gateway ---

/** A refusal the Git client shows as `remote: <message>`. */
export class GitGatewayError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
    this.name = "GitGatewayError";
  }
}

interface AuthorizedGitRequest {
  identity: Identity;
  projectId: string;
  sessionId: string | null;
  allocationId: string;
  binding: ResolvedConnectionBinding;
  repository: string;
  remoteUrl: string;
  upstreamBase: string;
}

/**
 * Git smart HTTP through the gateway (ADR 0175). A sandbox's `git` talks to
 * `/gateway/git/<alias>/<repository>` with its session grant as the
 * password; the gateway checks the grant, the binding's repositories and
 * push rules, and the guards, then forwards the request upstream with the
 * connection's own credential, streaming both ways.
 */
export class GitGatewayService {
  private readonly fetch: typeof fetch;

  constructor(
    private readonly deps: {
      db: Kysely<DB>;
      grants: ConnectionCapabilityGrantsService;
      allocations: ExecutionAllocationsService;
      broker: ConnectionBroker;
      providers: ConnectionProviderRegistry;
      connections: ConnectionsService;
      fetch?: typeof fetch;
    },
  ) {
    this.fetch = deps.fetch ?? ((input, init) => fetch(input, init));
  }

  async handle(request: GitGatewayRequest): Promise<GitGatewayResponse> {
    try {
      return await withSpan(
        {
          tracer,
          name: "gateway.git",
          attributes: {
            "catamorphic.connection.alias": request.alias,
            "catamorphic.git.operation": request.operation.kind,
          },
        },
        () => this.handleUninstrumented(request),
      );
    } catch (error) {
      return refusalResponse(error);
    }
  }

  private async handleUninstrumented(
    request: GitGatewayRequest,
  ): Promise<GitGatewayResponse> {
    const authorized = await this.authorize(request);
    const operation = request.operation;
    if (operation.kind === "advertise") {
      const access =
        operation.service === "git-receive-pack" ? "write" : "read";
      const { credentials } = await this.deps.broker.gitAccess({
        identity: authorized.identity,
        allocationId: authorized.allocationId,
        alias: request.alias,
        access,
        remoteUrl: authorized.remoteUrl,
        ...(authorized.sessionId
          ? { agentSessionId: authorized.sessionId }
          : {}),
      });
      return this.forward({
        method: "GET",
        url: `${this.upstreamRepository(authorized, request)}/info/refs?service=${operation.service}`,
        credentials,
        headers: request.headers,
      });
    }
    if (!request.body)
      throw new GitGatewayError(400, "A request body is required");
    if (operation.kind === "upload-pack") {
      const body = peekable(request.body);
      const first = await body.peek(4096);
      const listing = /^[0-9a-f]{4}command=ls-refs/.test(
        decoder.decode(first.subarray(0, 64)),
      );
      const access = await this.deps.broker.gitAccess({
        identity: authorized.identity,
        allocationId: authorized.allocationId,
        alias: request.alias,
        access: "read",
        remoteUrl: authorized.remoteUrl,
        ...(listing
          ? {}
          : {
              review: {
                action: "fetch" as const,
                input: { repository: authorized.repository },
                ...(authorized.sessionId
                  ? { agentSessionId: authorized.sessionId }
                  : {}),
              },
            }),
      });
      return this.forward({
        method: "POST",
        url: `${this.upstreamRepository(authorized, request)}/git-upload-pack`,
        credentials: access.credentials,
        headers: request.headers,
        body: body.stream(),
        audit: listing ? undefined : access.audit,
      });
    }
    return this.receivePack(authorized, request, request.body);
  }

  private async receivePack(
    authorized: AuthorizedGitRequest,
    request: GitGatewayRequest,
    raw: AsyncIterable<Uint8Array>,
  ): Promise<GitGatewayResponse> {
    const gzip = /gzip/i.test(request.headers["content-encoding"] ?? "");
    const body = peekable(gzip ? gunzip(raw) : raw);
    const section = await body.readUntil(
      (buffer) => readPktSection(buffer) !== null,
      MAX_COMMAND_BYTES,
    );
    const parsedSection = readPktSection(section);
    if (!parsedSection)
      throw new GitGatewayError(400, "The gateway cannot read this push");
    const { commands, capabilities } = parseReceivePackCommands(
      parsedSection.lines,
    );
    const refs = commands.map((command) => ({
      ref: command.ref,
      old: command.oldId,
      new: command.newId,
    }));
    const input: Json = { repository: authorized.repository, refs };
    const refuse = async (reasons: ReadonlyMap<string, string>) => {
      await body.drain();
      await this.deps.connections.audit({
        identity: authorized.identity,
        projectId: authorized.projectId,
        connectionId: authorized.binding.connectionId,
        allocationId: authorized.allocationId,
        eventType: "connection.git",
        outcome: "denied",
        action: "push",
        metadata: {
          actor: authorized.identity.externalUserId,
          ...(authorized.sessionId ? { sessionId: authorized.sessionId } : {}),
          input,
          reasons: Object.fromEntries(reasons),
        },
      });
      return {
        status: 200,
        headers: {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
        },
        body: receivePackRefusal({ commands, capabilities, reasons }),
      } satisfies GitGatewayResponse;
    };
    if (!authorized.binding.capabilities.includes("git:write")) {
      return refuse(
        new Map(
          commands.map((command) => [
            command.ref,
            `this session may not push through '${request.alias}' (it lacks git:write)`,
          ]),
        ),
      );
    }
    const defaultBranch = await this.defaultBranch(authorized, request);
    const refusals = reviewPush({
      commands,
      patterns: authorized.binding.git?.push ?? DEFAULT_PUSH_PATTERNS,
      defaultBranch,
    });
    if (refusals) return refuse(refusals);
    const access = await this.deps.broker
      .gitAccess({
        identity: authorized.identity,
        allocationId: authorized.allocationId,
        alias: request.alias,
        access: "write",
        remoteUrl: authorized.remoteUrl,
        review: {
          action: "push",
          input,
          ...(authorized.sessionId
            ? { agentSessionId: authorized.sessionId }
            : {}),
        },
      })
      .catch((error: unknown) => {
        if (error instanceof ConnectionActionDeniedError) return error;
        throw error;
      });
    if (access instanceof ConnectionActionDeniedError) {
      // The broker already audited the guards' refusal.
      await body.drain();
      return {
        status: 200,
        headers: {
          "content-type": "application/x-git-receive-pack-result",
          "cache-control": "no-cache",
        },
        body: receivePackRefusal({
          commands,
          capabilities,
          reasons: new Map(
            commands.map((command) => [command.ref, access.reason]),
          ),
        }),
      };
    }
    const headers = { ...request.headers };
    delete headers["content-encoding"];
    return this.forward({
      method: "POST",
      url: `${this.upstreamRepository(authorized, request)}/git-receive-pack`,
      credentials: access.credentials,
      headers,
      body: body.stream(),
      audit: access.audit,
    });
  }

  /** The grant, its session and binding, and the repository it may reach. */
  private async authorize(
    request: GitGatewayRequest,
  ): Promise<AuthorizedGitRequest> {
    const token = grantFromAuthorization(request.authorization);
    if (!token)
      throw new GitGatewayError(
        401,
        "Sign in with this session's grant (the sandbox's Git credential helper supplies it)",
      );
    const grant = await this.deps.grants.validate({ token });
    if (!grant || grant.alias !== request.alias)
      throw new GitGatewayError(
        401,
        "This session's grant has expired or was revoked",
      );
    const owner = grant.agentSessionId
      ? await this.deps.db
          .selectFrom("agent_sessions")
          .select(["external_user_id", "status"])
          .where("id", "=", grant.agentSessionId)
          .executeTakeFirst()
      : undefined;
    if (grant.agentSessionId && owner?.status !== "active")
      throw new GitGatewayError(401, "This session is closed");
    const identity: Identity = {
      tenantId: grant.tenantId,
      externalUserId:
        owner?.external_user_id ?? `connection-grant:${grant.allocationId}`,
    };
    const allocation = await this.deps.allocations.get({
      identity,
      allocationId: grant.allocationId,
    });
    const binding = allocation?.policy.connections?.find(
      (candidate) => candidate.alias === grant.alias,
    );
    if (allocation?.status !== "active" || !binding)
      throw new GitGatewayError(401, "This session's grant is no longer valid");
    const provider = this.deps.providers.get(binding.providerKind);
    const upstreamBase = provider?.git?.remoteBaseUrls[0];
    if (!provider?.git || !upstreamBase)
      throw new GitGatewayError(
        404,
        `Connection '${request.alias}' does not serve Git`,
      );
    const repository = normalizeRepositoryPath(request.repositoryPath);
    const allowed = await this.allowedRepositories({
      identity,
      projectId: allocation.projectId,
      policy: binding.git,
      bases: provider.git.remoteBaseUrls,
    });
    if (!allowed.includes(repository))
      throw new GitGatewayError(
        403,
        allowed.length > 0
          ? `'${request.alias}' reaches only ${allowed.join(", ")}`
          : `'${request.alias}' reaches no repository: the project's linked remote is not on ${upstreamBase}, and the binding names no repositories`,
      );
    const prefix = upstreamBase.endsWith("/")
      ? upstreamBase
      : `${upstreamBase}/`;
    return {
      identity,
      projectId: allocation.projectId,
      sessionId: grant.agentSessionId,
      allocationId: allocation.id,
      binding,
      repository,
      remoteUrl: `${prefix}${repository}`,
      upstreamBase: prefix,
    };
  }

  private async allowedRepositories(input: {
    identity: Identity;
    projectId: string;
    policy: ConnectionGitPolicy | undefined;
    bases: readonly string[];
  }): Promise<string[]> {
    const project = input.policy?.repositories
      ? undefined
      : await this.deps.db
          .selectFrom("projects")
          .select("remote_url")
          .where("id", "=", input.projectId)
          .where("tenant_id", "=", input.identity.tenantId)
          .executeTakeFirst();
    return bindingRepositories({
      policy: input.policy,
      bases: input.bases,
      projectRemote: project?.remote_url,
    });
  }

  private upstreamRepository(
    authorized: AuthorizedGitRequest,
    request: GitGatewayRequest,
  ): string {
    // Keep the client's spelling (`repo` or `repo.git`); some hosts care.
    const path = request.repositoryPath.replace(/^\/+|\/+$/g, "");
    return `${authorized.upstreamBase}${path}`;
  }

  /** The remote's default branch, from its upload-pack advertisement. */
  private async defaultBranch(
    authorized: AuthorizedGitRequest,
    request: GitGatewayRequest,
  ): Promise<string | null> {
    const { credentials } = await this.deps.broker.gitAccess({
      identity: authorized.identity,
      allocationId: authorized.allocationId,
      alias: request.alias,
      access: "read",
      remoteUrl: authorized.remoteUrl,
    });
    const response = await this.fetch(
      `${this.upstreamRepository(authorized, request)}/info/refs?service=git-upload-pack`,
      {
        headers: { authorization: basicAuthorization(credentials) },
        redirect: "manual",
      },
    );
    if (!response.ok)
      throw new GitGatewayError(
        502,
        `The remote refused to list its branches (${response.status})`,
      );
    return advertisedDefaultBranch(
      new Uint8Array(await response.arrayBuffer()),
    );
  }

  private async forward(input: {
    method: "GET" | "POST";
    url: string;
    credentials: { username: string; password: string };
    headers: Readonly<Record<string, string | undefined>>;
    body?: AsyncIterable<Uint8Array>;
    audit?: (outcome: "allowed" | "error", metadata?: Json) => Promise<void>;
  }): Promise<GitGatewayResponse> {
    const headers = new Headers();
    for (const name of [
      "content-type",
      "content-encoding",
      "accept",
      "git-protocol",
    ]) {
      const value = input.headers[name];
      if (value) headers.set(name, value);
    }
    headers.set("authorization", basicAuthorization(input.credentials));
    headers.set("user-agent", "git/work-gateway");
    const init: RequestInit & { duplex?: "half" } = {
      method: input.method,
      headers,
      redirect: "manual",
      ...(input.body
        ? { body: toReadableStream(input.body), duplex: "half" }
        : {}),
    };
    const response = await this.fetch(input.url, init).catch(
      async (error: unknown) => {
        await input.audit?.("error", { error: "upstream unreachable" });
        throw new GitGatewayError(
          502,
          `The remote could not be reached: ${error instanceof Error ? error.message : String(error)}`,
        );
      },
    );
    if (!response.ok || !response.body) {
      await input.audit?.("error", { status: response.status });
      await response.body?.cancel().catch(() => {});
      throw new GitGatewayError(
        502,
        response.status === 401 || response.status === 403
          ? `The remote refused the connection's credential (${response.status})`
          : `The remote answered ${response.status}`,
      );
    }
    await input.audit?.("allowed", { status: response.status });
    // fetch has already decoded any content-encoding; only the type travels.
    const out: Record<string, string> = { "cache-control": "no-cache" };
    const contentType = response.headers.get("content-type");
    if (contentType) out["content-type"] = contentType;
    return {
      status: response.status,
      headers: out,
      body: fromReadableStream(response.body),
    };
  }
}

function toReadableStream(
  source: AsyncIterable<Uint8Array>,
): ReadableStream<Uint8Array> {
  const iterator = source[Symbol.asyncIterator]();
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      const next = await iterator.next();
      if (next.done) controller.close();
      else controller.enqueue(next.value);
    },
    async cancel() {
      await iterator.return?.();
    },
  });
}

async function* fromReadableStream(
  stream: ReadableStream<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const reader = stream.getReader();
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) return;
      yield next.value;
    }
  } finally {
    reader.releaseLock();
  }
}

function grantFromAuthorization(header: string | undefined): string | null {
  if (!header) return null;
  const [scheme, value] = header.split(" ", 2);
  if (!value) return null;
  if (/^bearer$/i.test(scheme ?? "")) return value.trim() || null;
  if (!/^basic$/i.test(scheme ?? "")) return null;
  const decoded = Buffer.from(value, "base64").toString("utf8");
  const separator = decoded.indexOf(":");
  const password = separator >= 0 ? decoded.slice(separator + 1) : "";
  return password || null;
}

function basicAuthorization(credentials: {
  username: string;
  password: string;
}): string {
  return `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString("base64")}`;
}

function refusalResponse(error: unknown): GitGatewayResponse {
  const text = (status: number, message: string): GitGatewayResponse => ({
    status,
    headers: {
      "content-type": "text/plain; charset=utf-8",
      "cache-control": "no-cache",
      ...(status === 401
        ? { "www-authenticate": 'Basic realm="Work Git gateway"' }
        : {}),
    },
    body: encoder.encode(`${message}\n`),
  });
  if (error instanceof GitGatewayError)
    return text(error.status, error.message);
  if (error instanceof ConnectionActionDeniedError)
    return text(403, `Refused: ${error.reason}`);
  if (error instanceof ConnectionActionRefusedError)
    return text(403, error.message);
  if (error instanceof ConnectionUnavailableError)
    return text(
      503,
      `The connection behind this alias is unavailable: ${error.message}`,
    );
  console.warn("[catamorphic] Git gateway request failed", error);
  return text(502, "The Git gateway could not complete this request");
}

async function* gunzip(
  source: AsyncIterable<Uint8Array>,
): AsyncIterable<Uint8Array> {
  const inflate = createGunzip();
  const pump = (async () => {
    for await (const chunk of source) {
      if (!inflate.write(chunk))
        await new Promise((resolve) => inflate.once("drain", resolve));
    }
    inflate.end();
  })();
  pump.catch((error: unknown) =>
    inflate.destroy(error instanceof Error ? error : new Error(String(error))),
  );
  for await (const chunk of inflate) yield new Uint8Array(chunk);
  await pump;
}

/**
 * An async byte stream the gateway can look into before forwarding: read
 * a prefix, then hand on the prefix and the untouched rest as one stream.
 */
function peekable(source: AsyncIterable<Uint8Array>) {
  const iterator = source[Symbol.asyncIterator]();
  const buffered: Uint8Array[] = [];
  let size = 0;
  let done = false;
  const pull = async () => {
    const next = await iterator.next();
    if (next.done) {
      done = true;
      return;
    }
    buffered.push(next.value);
    size += next.value.length;
  };
  return {
    async peek(bytes: number): Promise<Uint8Array> {
      while (!done && size < bytes) await pull();
      return concat(buffered);
    },
    async readUntil(
      complete: (buffer: Uint8Array) => boolean,
      limit: number,
    ): Promise<Uint8Array> {
      for (;;) {
        const buffer = concat(buffered);
        if (complete(buffer)) return buffer;
        if (done || size > limit)
          throw new GitGatewayError(400, "The gateway cannot read this push");
        await pull();
      }
    },
    async drain(): Promise<void> {
      while (!done) {
        const next = await iterator.next();
        if (next.done) done = true;
      }
    },
    async *stream(): AsyncIterable<Uint8Array> {
      yield* buffered.splice(0);
      if (done) return;
      for (;;) {
        const next = await iterator.next();
        if (next.done) return;
        yield next.value;
      }
    },
  };
}
