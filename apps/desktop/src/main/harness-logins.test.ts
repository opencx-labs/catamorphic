import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  claudeRefreshArgs,
  containsRefreshToken,
  jwtExpiry,
  readLocalLogin,
  refreshClaudeLogin,
  refreshCodexLogin,
  stripClaudeCredentials,
  stripCodexAuth,
} from "./harness-logins.js";

const dirs: string[] = [];
const tempDir = () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "harness-logins-"));
  dirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of dirs.splice(0))
    fs.rmSync(dir, { recursive: true, force: true });
});

const jwt = (claims: Record<string, unknown>) =>
  [
    Buffer.from('{"alg":"none"}').toString("base64url"),
    Buffer.from(JSON.stringify(claims)).toString("base64url"),
    "sig",
  ].join(".");

// Shapes as stored by Claude Code 2.1 and Codex 0.15x; values are fakes.
const claudeKeychain = {
  mcpOAuth: {
    "plugin:linear:linear|1": {
      accessToken: "mcp-access",
      refreshToken: "mcp-refresh",
      expiresAt: 1,
    },
  },
  claudeAiOauth: {
    accessToken: "sk-ant-oat-access",
    refreshToken: "sk-ant-ort-refresh",
    expiresAt: 1_790_580_322_478,
    refreshTokenExpiresAt: 1_792_280_647_478,
    scopes: ["user:inference", "user:sessions:claude_code"],
    subscriptionType: "max",
  },
};
const codexAuth = {
  auth_mode: "chatgpt",
  OPENAI_API_KEY: null,
  tokens: {
    id_token: "id",
    access_token: jwt({ exp: 1_790_000_000 }),
    refresh_token: "rt_refresh",
    account_id: "acct",
  },
  last_refresh: "2026-09-17T21:42:45.497066Z",
};

describe("stripping refresh tokens", () => {
  it("keeps only Claude Code's OAuth entry, without refresh fields", () => {
    const stripped = stripClaudeCredentials(JSON.stringify(claudeKeychain));
    expect(stripped).not.toBeNull();
    const payload = JSON.parse(stripped?.payload ?? "{}");
    expect(payload).toEqual({
      claudeAiOauth: {
        accessToken: "sk-ant-oat-access",
        expiresAt: 1_790_580_322_478,
        scopes: ["user:inference", "user:sessions:claude_code"],
        subscriptionType: "max",
      },
    });
    expect(stripped?.payload).not.toContain("refresh");
    expect(stripped?.payload).not.toContain("mcp");
    expect(stripped?.expiresAt).toBe(new Date(1_790_580_322_478).toISOString());
  });

  it("drops Codex's tokens.refresh_token and reads expiry from the JWT", () => {
    const stripped = stripCodexAuth(JSON.stringify(codexAuth));
    const payload = JSON.parse(stripped?.payload ?? "{}");
    expect(payload.tokens).toEqual({
      id_token: "id",
      access_token: codexAuth.tokens.access_token,
      account_id: "acct",
    });
    expect(payload.auth_mode).toBe("chatgpt");
    expect(containsRefreshToken(stripped?.payload)).toBe(false);
    expect(stripped?.expiresAt).toBe(new Date(1_790_000_000_000).toISOString());
  });

  it("accepts a Codex API key login and refuses empty logins", () => {
    expect(
      stripCodexAuth(JSON.stringify({ OPENAI_API_KEY: "sk-test" }))?.expiresAt,
    ).toBeNull();
    expect(stripCodexAuth(JSON.stringify({ tokens: {} }))).toBeNull();
    expect(stripCodexAuth("not json")).toBeNull();
    expect(stripClaudeCredentials(JSON.stringify({ mcpOAuth: {} }))).toBeNull();
    expect(
      stripClaudeCredentials(
        JSON.stringify({ claudeAiOauth: { accessToken: "" } }),
      ),
    ).toBeNull();
  });

  it("finds refresh tokens anywhere, in both spellings", () => {
    expect(containsRefreshToken(JSON.stringify(claudeKeychain))).toBe(true);
    expect(containsRefreshToken(codexAuth)).toBe(true);
    expect(containsRefreshToken({ a: [{ refreshToken: "x" }] })).toBe(true);
    expect(containsRefreshToken({ refreshTokenExpiresAt: 1 })).toBe(false);
    expect(containsRefreshToken("plain text")).toBe(false);
  });

  it("reads JWT expiry defensively", () => {
    expect(jwtExpiry(jwt({ exp: 10 }))).toBe(new Date(10_000).toISOString());
    expect(jwtExpiry(jwt({}))).toBeNull();
    expect(jwtExpiry("opaque")).toBeNull();
    expect(jwtExpiry("a.!!!.c")).toBeNull();
  });
});

describe("readLocalLogin", () => {
  it("prefers the Keychain for Claude Code and falls back to the file", async () => {
    const home = tempDir();
    const fromKeychain = await readLocalLogin({
      harness: "claude-code",
      homeDir: home,
      readKeychain: async () => JSON.stringify(claudeKeychain),
    });
    expect(fromKeychain?.expiresAt).toBe(
      new Date(1_790_580_322_478).toISOString(),
    );
    expect(fromKeychain?.fingerprint).toMatch(/^[0-9a-f]{64}$/);

    fs.mkdirSync(path.join(home, ".claude"));
    fs.writeFileSync(
      path.join(home, ".claude", ".credentials.json"),
      JSON.stringify({
        claudeAiOauth: { accessToken: "file-token", refreshToken: "r" },
      }),
    );
    const fromFile = await readLocalLogin({
      harness: "claude-code",
      homeDir: home,
      readKeychain: async () => null,
    });
    expect(JSON.parse(fromFile?.payload ?? "{}")).toEqual({
      claudeAiOauth: { accessToken: "file-token" },
    });
    expect(fromFile?.fingerprint).not.toBe(fromKeychain?.fingerprint);
  });

  it("reads ~/.codex/auth.json and reports a missing login as null", async () => {
    const home = tempDir();
    await expect(
      readLocalLogin({ harness: "codex", homeDir: home }),
    ).resolves.toBeNull();
    fs.mkdirSync(path.join(home, ".codex"));
    fs.writeFileSync(
      path.join(home, ".codex", "auth.json"),
      JSON.stringify(codexAuth),
    );
    const login = await readLocalLogin({ harness: "codex", homeDir: home });
    expect(login?.harness).toBe("codex");
    expect(login?.payload).not.toContain("rt_refresh");
  });
});

/** A stand-in executable that records how it was run. */
function fakeExecutable(dir: string, body: string): string {
  const file = path.join(dir, "fake-cli.mjs");
  fs.writeFileSync(file, `#!${process.execPath}\n${body}\n`);
  fs.chmodSync(file, 0o755);
  return file;
}

describe("local refresh commands", () => {
  it("asks the Codex app-server to read the account with a refresh", async () => {
    const dir = tempDir();
    const log = path.join(dir, "log.jsonl");
    const executable = fakeExecutable(
      dir,
      `import fs from "node:fs";
import readline from "node:readline";
fs.appendFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2) }) + "\\n");
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  fs.appendFileSync(${JSON.stringify(log)}, line + "\\n");
  if (message.id !== undefined)
    process.stdout.write(JSON.stringify({ id: message.id, result: { account: { type: "chatgpt" } } }) + "\\n");
});`,
    );
    await refreshCodexLogin({
      executablePath: executable,
      env: process.env,
      timeoutMs: 10_000,
    });
    const lines = fs
      .readFileSync(log, "utf8")
      .trim()
      .split("\n")
      .map((line) => JSON.parse(line));
    expect(lines[0]).toEqual({ argv: ["app-server"] });
    expect(lines.map((line) => line.method).filter(Boolean)).toEqual([
      "initialize",
      "initialized",
      "account/read",
    ]);
    expect(
      lines.find((line) => line.method === "account/read")?.params,
    ).toEqual({ refreshToken: true });
  });

  it("reports a Codex refresh failure", async () => {
    const dir = tempDir();
    const executable = fakeExecutable(
      dir,
      `import readline from "node:readline";
const rl = readline.createInterface({ input: process.stdin });
rl.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize")
    process.stdout.write(JSON.stringify({ id: message.id, result: {} }) + "\\n");
  else if (message.id !== undefined)
    process.stdout.write(JSON.stringify({ id: message.id, error: { message: "no" } }) + "\\n");
});`,
    );
    await expect(
      refreshCodexLogin({
        executablePath: executable,
        env: process.env,
        timeoutMs: 10_000,
      }),
    ).rejects.toThrow("Codex could not refresh its sign-in");
  });

  it("runs Claude Code with the machine login, no tools, hooks or MCP servers", async () => {
    const dir = tempDir();
    const log = path.join(dir, "claude.json");
    const executable = fakeExecutable(
      dir,
      `import fs from "node:fs";
fs.writeFileSync(${JSON.stringify(log)}, JSON.stringify({ argv: process.argv.slice(2), apiKey: process.env.ANTHROPIC_API_KEY ?? null, configDir: process.env.CLAUDE_CONFIG_DIR ?? null }));`,
    );
    await refreshClaudeLogin({
      executablePath: executable,
      env: {
        ...process.env,
        ANTHROPIC_API_KEY: "sk-should-not-pass",
        CLAUDE_CONFIG_DIR: "/tmp/agent-home",
      },
    });
    const recorded = JSON.parse(fs.readFileSync(log, "utf8"));
    expect(recorded).toEqual({
      argv: claudeRefreshArgs(),
      apiKey: null,
      configDir: null,
    });
    expect(recorded.argv).toContain("--strict-mcp-config");
    expect(recorded.argv).toContain("--no-session-persistence");
    expect(recorded.argv).not.toContain("--bare");
  });
});
