import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { openStockAuthDatabase } from "./auth-database.js";
import {
  assertOidcProfileAllowed,
  createStockAuth,
  loadStockAuthSecret,
} from "./stock-auth.js";

const temporaryDirectories: string[] = [];

afterEach(() => {
  for (const directory of temporaryDirectories.splice(0)) {
    fs.rmSync(directory, { recursive: true, force: true });
  }
});

function createDataDirectory(): string {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), "catamorphic-stock-auth-host-"),
  );
  temporaryDirectories.push(directory);
  return directory;
}

describe("stock Better Auth host", () => {
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
    const database = await openStockAuthDatabase({ dataDir });
    const stockAuth = createStockAuth({
      database,
      baseURL: "http://127.0.0.1:4700",
      secret: "stock-auth-host-test-secret-at-least-32-characters",
    });
    await stockAuth.migrate();

    const publicSignup = await stockAuth.handler(
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

    const created = await stockAuth.createLocalUser({
      username: "ada",
      name: "Ada Lovelace",
      password: "correct horse battery staple",
    });
    expect(created.email).toBe("ada@local.invalid");

    const session = await stockAuth.signInUsername({
      username: "ada",
      password: "correct horse battery staple",
    });
    const resolved = await stockAuth.resolveSession({ token: session.token });

    expect(resolved?.id).toBe(created.id);
    expect(resolved?.username).toBe("ada");
    await stockAuth.close();
  });

  it("persists one owner-only signing secret unless one is injected", () => {
    const dataDir = createDataDirectory();
    const generated = loadStockAuthSecret({ dataDir });
    const reused = loadStockAuthSecret({ dataDir });
    const file = path.join(dataDir, "auth-secret");

    expect(reused).toBe(generated);
    expect(generated.length).toBeGreaterThanOrEqual(32);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    expect(
      loadStockAuthSecret({
        dataDir,
        configuredSecret: "injected-secret-with-at-least-32-characters",
      }),
    ).toBe("injected-secret-with-at-least-32-characters");
    expect(fs.readFileSync(file, "utf8").trim()).toBe(generated);
  });

  it("publishes OAuth discovery and rejects unknown access tokens", async () => {
    const dataDir = createDataDirectory();
    const database = await openStockAuthDatabase({ dataDir });
    const stockAuth = createStockAuth({
      database,
      baseURL: "http://127.0.0.1:4700",
      secret: "stock-auth-host-test-secret-at-least-32-characters",
    });
    await stockAuth.migrate();
    const discovery = await stockAuth.handler(
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
      await stockAuth.resolveAccessToken({
        authorization: "Bearer not-a-token",
      }),
    ).toBeNull();
    await stockAuth.close();
  });
});
