import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { AgentTurnUsage, Item, Turn } from "@catamorphic/agent-protocol";
import type { AgentSessionsService, Identity } from "@catamorphic/core";
import pg from "pg";
import { workServerConfigFromEnv } from "./config.js";
import type { WorkServerOptions } from "./server.js";

/** Test servers boot from the same env parser as the image. */
export function testServerOptions(args: {
  dataDir: string;
  publicBases?: string[];
  env: Record<string, string | undefined>;
}): WorkServerOptions {
  return {
    config: {
      ...workServerConfigFromEnv({ WORK_DATA_DIR: args.dataDir, ...args.env }),
      dataDir: args.dataDir,
      ...(args.publicBases ? { publicBases: args.publicBases } : {}),
    },
  };
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
    url: "/api/auth/mcp/register",
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
    scope: "openid profile email offline_access",
    state: "work-server-state",
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const authorized = await app.inject({
    method: "GET",
    url: `/api/auth/mcp/authorize?${authorize}`,
    headers: { cookie },
  });
  expectStatus("authorization", authorized.statusCode, 302);
  const code =
    new URL(String(authorized.headers.location ?? "")).searchParams.get(
      "code",
    ) ?? "";

  const token = await app.inject({
    method: "POST",
    url: "/api/auth/mcp/token",
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
