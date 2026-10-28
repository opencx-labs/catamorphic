import { createHash, randomBytes, randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import type { AgentTurnUsage, Item, Turn } from "@catamorphic/agent-protocol";
import {
  type AgentSessionsService,
  type Identity,
  parseRegistryCatalog,
} from "@catamorphic/core";
import pg from "pg";
import { workServerConfigFromEnv } from "./config.js";
import {
  executionSettingsFromEnv,
  type WorkExecutionSettings,
} from "./execution-config.js";
import {
  type DirectoryAccountStatus,
  type DirectoryProvider,
  DirectoryUnavailableError,
} from "./identity/directory.js";
import type { WorkServerOptions } from "./server.js";

/**
 * A directory (ADR 0161) governing Better Auth's local "credential"
 * accounts, whose account id is the user id, so every lifecycle path runs
 * through the real OAuth server and token gate. Accounts it does not know
 * are active in no group; it answers only about the groups it is asked.
 */
export class FakeDirectory implements DirectoryProvider {
  readonly providerId = "credential";
  readonly requiredGroups: string[] = [];
  /** Replica memory (single process): a test's directory, never a host's. */
  readonly accounts = new Map<string, DirectoryAccountStatus>();
  unavailable = false;
  calls = 0;

  async check(args: {
    accountId: string;
    groups: readonly string[];
  }): Promise<DirectoryAccountStatus> {
    this.calls += 1;
    if (this.unavailable) throw new DirectoryUnavailableError("offline");
    const status = this.accounts.get(args.accountId) ?? {
      active: true,
      groups: [],
    };
    return status.active
      ? {
          active: true,
          groups: status.groups.filter((group) => args.groups.includes(group)),
        }
      : status;
  }
}

/** Test servers boot from the same env parser as the image. */
export function testServerOptions(args: {
  dataDir: string;
  publicBases?: string[];
  env: Record<string, string | undefined>;
}): WorkServerOptions {
  return {
    config: {
      ...workServerConfigFromEnv({
        WORK_DATA_DIR: args.dataDir,
        // Tests run trusted subprocesses unless they choose a backend.
        WORK_SANDBOX: "local-process",
        ...args.env,
      }),
      dataDir: args.dataDir,
      ...(args.publicBases ? { publicBases: args.publicBases } : {}),
    },
  };
}

/**
 * A test worker's execution settings, from the same parser as the image.
 * Like {@link testServerOptions}, trusted subprocesses unless the test
 * chooses a backend: `auto` would pick containers on a runner with Docker.
 */
export function testExecutionSettings(
  env: Record<string, string | undefined>,
): WorkExecutionSettings {
  return executionSettingsFromEnv({ WORK_SANDBOX: "local-process", ...env });
}

/**
 * A database of its own on the server at `DATABASE_URL`: a deployment's
 * replicas share one origin and secrets, which other suites do not.
 */
export async function createTestDatabase(prefix: string): Promise<{
  url: string;
  drop(): Promise<void>;
}> {
  const admin = new pg.Client({ connectionString: process.env.DATABASE_URL });
  const database = `${prefix}_${randomBytes(4).toString("hex")}`;
  await admin.connect();
  await admin.query(`CREATE DATABASE ${database}`);
  const url = new URL(process.env.DATABASE_URL ?? "");
  url.pathname = `/${database}`;
  return {
    url: url.toString(),
    drop: async () => {
      try {
        await admin.query(`DROP DATABASE ${database} WITH (FORCE)`);
      } finally {
        await admin.end();
      }
    },
  };
}

interface InjectableApp {
  inject(options: {
    method: "GET" | "POST";
    url: string;
    headers?: Record<string, string>;
    payload?: unknown;
  }): Promise<{
    statusCode: number;
    headers: Record<string, string | string[] | number | undefined>;
    json(): Record<string, unknown>;
  }>;
}

/** Accept the signed authorization prompt before exchanging the code. */
export async function acceptOAuthConsent(args: {
  app: InjectableApp;
  location: string;
  cookie: string;
}): Promise<string> {
  const consent = new URL(args.location);
  if (consent.pathname !== "/oauth/consent") return args.location;
  const page = await args.app.inject({
    method: "GET",
    url: `${consent.pathname}${consent.search}`,
    headers: { cookie: args.cookie },
  });
  if (page.statusCode !== 200) {
    throw new Error(`consent page answered ${page.statusCode}, expected 200`);
  }
  const accepted = await args.app.inject({
    method: "POST",
    url: "/oauth/consent",
    headers: {
      cookie: args.cookie,
      "content-type": "application/x-www-form-urlencoded",
    },
    payload: new URLSearchParams({
      accept: "true",
      oauth_query: consent.search.slice(1),
    }).toString(),
  });
  if (accepted.statusCode !== 302) {
    throw new Error(`consent answered ${accepted.statusCode}, expected 302`);
  }
  return String(accepted.headers.location ?? "");
}

/**
 * The OAuth flow an MCP client runs, in process: local sign-in, dynamic
 * client registration, PKCE authorization, and the code exchange.
 */
export async function oauthAccessToken(args: {
  app: InjectableApp;
  username: string;
  password: string;
}): Promise<string> {
  const { app } = args;
  const resourceMetadata = await app.inject({
    method: "GET",
    url: "/.well-known/oauth-protected-resource",
  });
  const resource = resourceMetadata.json().resource;
  if (typeof resource !== "string")
    throw new Error("Missing Work resource metadata");
  const expectStatus = (step: string, actual: number, expected: number) => {
    if (actual !== expected)
      throw new Error(`${step} answered ${actual}, expected ${expected}`);
  };
  const login = await app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: { username: args.username, password: args.password },
  });
  expectStatus("sign-in", login.statusCode, 200);
  const setCookie = login.headers["set-cookie"];
  const cookie = String(Array.isArray(setCookie) ? setCookie[0] : setCookie);

  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await app.inject({
    method: "POST",
    url: "/api/auth/oauth2/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Work server test",
    },
  });
  expectStatus("registration", registered.statusCode, 201);
  const clientId = String(registered.json().client_id);
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    resource,
    scope: "openid profile email offline_access",
    state: "work-server-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorized = await app.inject({
    method: "GET",
    url: `/api/auth/oauth2/authorize?${authorize}`,
    headers: { cookie },
  });
  expectStatus("authorization", authorized.statusCode, 302);
  const callback = await acceptOAuthConsent({
    app,
    location: String(authorized.headers.location ?? ""),
    cookie,
  });
  const code = new URL(callback).searchParams.get("code") ?? "";

  const token = await app.inject({
    method: "POST",
    url: "/api/auth/oauth2/token",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    payload: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }).toString(),
  });
  expectStatus("token", token.statusCode, 200);
  return String(token.json().access_token);
}

/**
 * Drop a test's own database once the servers that used it have closed
 * their connections. Forcing it while a pool is still closing a client
 * terminates that client, which surfaces as an uncaught error; a
 * connection still open after 10 seconds is a leak, so the test fails.
 */
export async function dropTestDatabase(args: {
  admin: {
    query(
      text: string,
      values?: unknown[],
    ): Promise<{ rows: Array<{ connections?: number }> }>;
  };
  database: string;
}): Promise<void> {
  const deadline = Date.now() + 10_000;
  let open = 0;
  do {
    const { rows } = await args.admin.query(
      "SELECT count(*)::int AS connections FROM pg_stat_activity WHERE datname = $1",
      [args.database],
    );
    open = rows[0]?.connections ?? 0;
    if (open > 0) await new Promise((resolve) => setTimeout(resolve, 100));
  } while (open > 0 && Date.now() < deadline);
  await args.admin.query(`DROP DATABASE ${args.database} WITH (FORCE)`);
  if (open > 0) {
    throw new Error(
      `${open} connection(s) to ${args.database} were still open 10 seconds after the servers shut down`,
    );
  }
}

/**
 * A settled turn as tests read it: the agent's final reply (or the turn's
 * error, for one that failed), its usage, and the turn.
 */
export function replyOf(result: { reply: Item | null; turn: Turn }): {
  content: string;
  usage: AgentTurnUsage | undefined;
  turn: Turn;
} {
  const { reply, turn } = result;
  return {
    content:
      reply?.kind === "assistant_message"
        ? reply.text
        : (turn.error?.message ?? ""),
    usage: turn.outcome?.usage,
    turn,
  };
}

/** Send a message and wait for its turn: {@link replyOf} that turn. */
export async function say(input: {
  sessions: AgentSessionsService;
  identity: Identity;
  projectId: string;
  sessionId: string;
  text: string;
}): Promise<ReturnType<typeof replyOf>> {
  return replyOf(
    await input.sessions.sendMessage(
      input.identity,
      input.projectId,
      input.sessionId,
      input.text,
    ),
  );
}

/** Queue a message without waiting for it; resolves its turn's id. */
export async function enqueue(input: {
  sessions: AgentSessionsService;
  identity: Identity;
  projectId: string;
  sessionId: string;
  text: string;
}): Promise<string> {
  const receipt = await input.sessions.command(
    input.identity,
    input.projectId,
    input.sessionId,
    {
      type: "send",
      commandId: randomUUID(),
      text: input.text,
      dispatch: "queue",
    },
  );
  const turnId = receipt.result?.turnId;
  if (receipt.status !== "accepted" || typeof turnId !== "string")
    throw new Error(receipt.error?.message ?? "The message started no turn");
  return turnId;
}

/**
 * Every regular file under a directory, links not followed. A sandbox's
 * transient files (a lock, an index being rewritten) may go while it is
 * walked: what is gone by then is not listed. The directory itself must be
 * there, so a scan of it never passes for want of files.
 */
export function filesUnder(directory: string): string[] {
  return walkFiles(directory, true);
}

function walkFiles(directory: string, root: boolean): string[] {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(directory, { withFileTypes: true });
  } catch (error) {
    if (!root && isMissing(error)) return [];
    throw error;
  }
  return entries.flatMap((entry) => {
    const full = path.join(directory, entry.name);
    if (entry.isDirectory()) return walkFiles(full, false);
    return entry.isFile() ? [full] : [];
  });
}

/**
 * Files under a directory whose bytes contain the text, as a leak check
 * reads them: a file gone before it is read holds nothing.
 */
export function filesHolding(directory: string, text: string): string[] {
  return filesUnder(directory).filter((file) => {
    try {
      return fs.readFileSync(file).includes(text);
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  });
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && "code" in error && error.code === "ENOENT";
}

/**
 * A registry pack's files by their project targets, from the built catalog
 * an agent's `registry.read` returns (ADR 0262).
 */
export function registryPack(name: string): Record<string, string> {
  const catalog = parseRegistryCatalog(
    fs.readFileSync(
      createRequire(import.meta.url).resolve(
        "@catamorphic/registry/catalog.json",
      ),
      "utf8",
    ),
  );
  const item = catalog.find((entry) => entry.name === name);
  if (!item) throw new Error(`No pack named ${name}`);
  return Object.fromEntries(
    item.files.map((file) => [file.target ?? file.path, file.content]),
  );
}
