import { execFile, spawn } from "node:child_process";
import { createHash } from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { PersonalHarness } from "../shared/personal-environment.js";

const execFileAsync = promisify(execFile);

/**
 * The member's own Claude Code and Codex sign-ins on this computer, as a
 * remote copy may carry them (ADR 0184). Refresh tokens never leave: only
 * the local CLI refreshes, so a remote copy can never rotate the local
 * login. Nothing here logs or returns a secret for display.
 */
export interface LocalLogin {
  harness: PersonalHarness;
  /** Credential JSON text with every refresh token removed. */
  payload: string;
  /** When the access token expires, when known. */
  expiresAt: string | null;
  /** Hash of the stripped payload: changes when the login changes. */
  fingerprint: string;
}

const CLAUDE_KEYCHAIN_SERVICE = "Claude Code-credentials";

// Focus, wake and sync probes cluster, and a login watcher must still see
// fresh credentials within a beat, so the Keychain answer lives 3 seconds.
let keychainCache: { at: number; value: string | null } | null = null;

/** Claude Code's default login on macOS lives in the Keychain. */
export async function readClaudeKeychain(): Promise<string | null> {
  if (process.platform !== "darwin") return null;
  if (keychainCache && Date.now() - keychainCache.at < 3000)
    return keychainCache.value;
  let value: string | null;
  try {
    const { stdout } = await execFileAsync("security", [
      "find-generic-password",
      "-s",
      CLAUDE_KEYCHAIN_SERVICE,
      "-w",
    ]);
    value = stdout;
  } catch {
    value = null;
  }
  keychainCache = { at: Date.now(), value };
  return value;
}

/**
 * Only Claude Code's own OAuth entry, without its refresh token. Other
 * Keychain entries (MCP server sign-ins) are not part of the login.
 */
export function stripClaudeCredentials(
  raw: string,
): { payload: string; expiresAt: string | null } | null {
  const parsed = parseObject(raw);
  const oauth = parsed ? record(parsed.claudeAiOauth) : null;
  if (!oauth || typeof oauth.accessToken !== "string" || !oauth.accessToken)
    return null;
  const {
    refreshToken: _refreshToken,
    refreshTokenExpiresAt: _refreshTokenExpiresAt,
    ...kept
  } = oauth;
  const expiresMs = Number(oauth.expiresAt);
  return {
    payload: JSON.stringify({ claudeAiOauth: kept }),
    expiresAt:
      Number.isFinite(expiresMs) && expiresMs > 0
        ? new Date(expiresMs).toISOString()
        : null,
  };
}

/** Codex's auth.json without `tokens.refresh_token`. */
export function stripCodexAuth(
  raw: string,
): { payload: string; expiresAt: string | null } | null {
  const parsed = parseObject(raw);
  if (!parsed) return null;
  const tokens = record(parsed.tokens);
  const apiKey =
    typeof parsed.OPENAI_API_KEY === "string" && parsed.OPENAI_API_KEY;
  const accessToken =
    tokens && typeof tokens.access_token === "string" && tokens.access_token
      ? tokens.access_token
      : null;
  if (!accessToken && !apiKey) return null;
  const next: Record<string, unknown> = { ...parsed };
  if (tokens) {
    const { refresh_token: _refreshToken, ...kept } = tokens;
    next.tokens = kept;
  }
  return {
    payload: JSON.stringify(next),
    expiresAt: accessToken ? jwtExpiry(accessToken) : null,
  };
}

/** A JWT's `exp` claim as an ISO time, or null for anything else. */
export function jwtExpiry(token: string): string | null {
  const segment = token.split(".")[1];
  if (!segment) return null;
  try {
    const claims = parseObject(
      Buffer.from(segment, "base64url").toString("utf8"),
    );
    const exp = claims ? Number(claims.exp) : Number.NaN;
    return Number.isFinite(exp) && exp > 0
      ? new Date(exp * 1000).toISOString()
      : null;
  } catch {
    return null;
  }
}

/** Defence in depth: a refresh token anywhere in the JSON. */
export function containsRefreshToken(value: unknown): boolean {
  if (typeof value === "string") {
    const parsed = parseObject(value);
    return parsed ? containsRefreshToken(parsed) : false;
  }
  if (Array.isArray(value)) return value.some(containsRefreshToken);
  if (typeof value !== "object" || value === null) return false;
  return Object.entries(value).some(
    ([key, item]) =>
      /^refresh_?token$/i.test(key) || containsRefreshToken(item),
  );
}

export function loginFingerprint(payload: string): string {
  return createHash("sha256").update(payload).digest("hex");
}

/**
 * The machine's own login for a harness: Claude Code from the Keychain on
 * macOS (else `~/.claude/.credentials.json`), Codex from `~/.codex/auth.json`.
 */
export async function readLocalLogin(args: {
  harness: PersonalHarness;
  homeDir?: string;
  readKeychain?: () => Promise<string | null>;
}): Promise<LocalLogin | null> {
  const home = args.homeDir ?? os.homedir();
  const readFile = (file: string) =>
    fs.readFile(file, "utf8").catch(() => null);
  let stripped: { payload: string; expiresAt: string | null } | null = null;
  if (args.harness === "claude-code") {
    const keychain = await (args.readKeychain ?? readClaudeKeychain)();
    stripped = keychain ? stripClaudeCredentials(keychain) : null;
    if (!stripped) {
      const file = await readFile(
        path.join(home, ".claude", ".credentials.json"),
      );
      stripped = file ? stripClaudeCredentials(file) : null;
    }
  } else {
    const file = await readFile(path.join(home, ".codex", "auth.json"));
    stripped = file ? stripCodexAuth(file) : null;
  }
  if (!stripped || containsRefreshToken(stripped.payload)) return null;
  return {
    harness: args.harness,
    payload: stripped.payload,
    expiresAt: stripped.expiresAt,
    fingerprint: loginFingerprint(stripped.payload),
  };
}

/**
 * Claude Code refreshes its access token only when it is used within five
 * minutes of expiry (CLI 2.1: `checkAndRefreshOAuthTokenIfNeeded`). Earlier
 * than that no local command refreshes it, so the desktop waits.
 */
export const CLAUDE_REFRESH_WINDOW_MS = 5 * 60_000;

/**
 * Codex: the app-server's `account/read` with `refreshToken: true` refreshes
 * the ChatGPT login without a model request. The token rotation is the
 * CLI's own, written to `~/.codex/auth.json` as any Codex use would.
 */
export async function refreshCodexLogin(args: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  const child = spawn(args.executablePath, ["app-server"], {
    env: args.env,
    cwd: os.tmpdir(),
    stdio: ["pipe", "pipe", "ignore"],
  });
  const pending = new Map<number, (message: Record<string, unknown>) => void>();
  let buffer = "";
  child.stdout.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => {
    buffer += chunk;
    for (
      let index = buffer.indexOf("\n");
      index >= 0;
      index = buffer.indexOf("\n")
    ) {
      const message = parseObject(buffer.slice(0, index));
      buffer = buffer.slice(index + 1);
      const id = message ? Number(message.id) : Number.NaN;
      if (message && pending.has(id)) {
        pending.get(id)?.(message);
        pending.delete(id);
      }
    }
  });
  let sequence = 0;
  const request = (method: string, params: unknown) =>
    new Promise<Record<string, unknown>>((resolve) => {
      const id = ++sequence;
      pending.set(id, resolve);
      child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
    });
  const exited = new Promise<never>((_, reject) => {
    child.once("error", reject);
    child.once("exit", (code) =>
      reject(new Error(`Codex stopped before refreshing (exit ${code})`)),
    );
  });
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error("Codex did not refresh its sign-in in time")),
      args.timeoutMs ?? 60_000,
    );
  });
  try {
    await Promise.race([
      (async () => {
        const initialized = await request("initialize", {
          clientInfo: { name: "work-desktop", version: "1" },
          capabilities: { experimentalApi: true },
        });
        if (initialized.error) throw new Error("Codex could not start");
        child.stdin.write(`${JSON.stringify({ method: "initialized" })}\n`);
        const account = await request("account/read", { refreshToken: true });
        if (account.error)
          throw new Error("Codex could not refresh its sign-in");
      })(),
      exited,
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
    child.removeAllListeners("exit");
    child.kill();
  }
}

/**
 * Claude Code has no refresh command: `claude auth status` reads cached
 * account data only. Inside the refresh window, the smallest local request
 * (one Haiku reply, no tools, no hooks, no MCP servers, not saved) makes the
 * CLI refresh and store the login itself.
 */
export function claudeRefreshArgs(): string[] {
  return [
    "-p",
    "Reply with OK.",
    "--model",
    "haiku",
    "--tools",
    "",
    "--strict-mcp-config",
    "--disable-slash-commands",
    "--no-session-persistence",
    "--settings",
    JSON.stringify({ disableAllHooks: true }),
  ];
}

export async function refreshClaudeLogin(args: {
  executablePath: string;
  env: NodeJS.ProcessEnv;
  timeoutMs?: number;
}): Promise<void> {
  // The machine login must answer, not a key or token from the environment.
  const env = { ...args.env };
  for (const key of [
    "ANTHROPIC_API_KEY",
    "ANTHROPIC_AUTH_TOKEN",
    "ANTHROPIC_BASE_URL",
    "CLAUDE_CODE_OAUTH_TOKEN",
    "CLAUDE_CONFIG_DIR",
  ])
    delete env[key];
  await execFileAsync(args.executablePath, claudeRefreshArgs(), {
    env,
    cwd: os.tmpdir(),
    timeout: args.timeoutMs ?? 90_000,
    maxBuffer: 1024 * 1024,
  });
}

function parseObject(text: string): Record<string, unknown> | null {
  try {
    return record(JSON.parse(text));
  } catch {
    return null;
  }
}

function record(value: unknown): Record<string, unknown> | null {
  if (typeof value !== "object" || value === null || Array.isArray(value))
    return null;
  return Object.fromEntries(Object.entries(value));
}
