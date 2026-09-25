import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openWorkAuthDatabase } from "./auth-database.js";
import {
  assertOidcProfileAllowed,
  createWorkAuth,
  loadWorkAuthSecret,
} from "./work-auth.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDataDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "work-server-auth-host-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("Work server Better Auth host", () => {
  it("enforces configured OIDC domains using a verified email", () => {
    expect(() =>
      assertOidcProfileAllowed(
        { email: "member@example.com", email_verified: true },
        ["example.com"],
      ),
    ).not.toThrow();
    expect(() =>
      assertOidcProfileAllowed(
        { email: "member@outside.test", email_verified: true },
        ["example.com"],
      ),
    ).toThrow("not allowed");
    expect(() =>
      assertOidcProfileAllowed(
        { email: "member@example.com", email_verified: false },
        ["example.com"],
      ),
    ).toThrow("verified email");
  });

  it("blocks public signup but provisions, signs in, and resolves one user", async () => {
    const dataDir = createDataDirectory();
    const database = await openWorkAuthDatabase({ dataDir });
    const workAuth = createWorkAuth({
      database,
      baseURL: "http://127.0.0.1:4700",
      secret: "work-auth-host-test-secret-at-least-32-characters",
    });
    await workAuth.migrate();

    const publicSignup = await workAuth.handler(
      new Request("http://127.0.0.1:4700/api/auth/sign-up/email", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          email: "intruder@example.com",
          name: "Intruder",
          password: "correct horse battery staple",
          username: "intruder",
        }),
      }),
    );
    expect(publicSignup.status).toBe(404);

    const created = await workAuth.createLocalUser({
      username: "ada",
      name: "Ada Lovelace",
      password: "correct horse battery staple",
    });
    expect(created.email).toBe("ada@local.invalid");

    const session = await workAuth.signInUsername({
      username: "ada",
      password: "correct horse battery staple",
    });
    const resolved = await workAuth.resolveSession({ token: session.token });

    expect(resolved?.id).toBe(created.id);
    expect(resolved?.username).toBe("ada");
    await workAuth.close();
  });

  it("persists one owner-only signing secret unless one is injected", () => {
    const dataDir = createDataDirectory();
    const generated = loadWorkAuthSecret({ dataDir });
    const reused = loadWorkAuthSecret({ dataDir });
    const file = path.join(dataDir, "auth-secret");

    expect(reused).toBe(generated);
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      loadWorkAuthSecret({
        dataDir,
        configuredSecret: "injected-secret-with-at-least-32-characters",
      }),
    ).toBe("injected-secret-with-at-least-32-characters");
    expect(fs.readFileSync(file, "utf8").trim()).toBe(generated);
  });

  it("publishes OAuth discovery and rejects unknown access tokens", async () => {
    const dataDir = createDataDirectory();
    const database = await openWorkAuthDatabase({ dataDir });
    const workAuth = createWorkAuth({
      database,
      baseURL: "http://127.0.0.1:4700",
      secret: "work-auth-host-test-secret-at-least-32-characters",
    });
    await workAuth.migrate();
    const discovery = await workAuth.handler(
      new Request(
        "http://127.0.0.1:4700/api/auth/.well-known/oauth-authorization-server",
      ),
    );
    expect(discovery.status).toBe(200);
    expect(await discovery.json()).toMatchObject({
      authorization_endpoint: expect.stringContaining("/mcp/authorize"),
      token_endpoint: expect.stringContaining("/mcp/token"),
      code_challenge_methods_supported: ["S256"],
    });
    expect(
      await workAuth.resolveAccessToken({
        authorization: "Bearer not-a-token",
      }),
    ).toBeNull();
    await workAuth.close();
  });
});
