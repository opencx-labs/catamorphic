import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type CredentialMaterial,
  type CredentialRef,
  type CredentialVault,
  MemoryCredentialVault,
} from "@catamorphic/core";
import { defineMcpConnectionProvider } from "@catamorphic/mcp";
import { defineHttpApiConnectionProvider } from "@catamorphic/server-sdk";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { createWorkServer, type WorkServer } from "./server.js";
import {
  filesUnder,
  oauthAccessToken,
  testServerOptions,
} from "./test-support.js";

/**
 * A host's own vault (ADR 0315): a company secret manager stands in for
 * Work's encrypted vault, holds every stored credential, and Work keeps no
 * key or credential of its own on disk.
 */

const API_KEY = "sk-host-vault-test-key";

/** The host's secret manager, here memory that records what it holds. */
class HostVault implements CredentialVault {
  private readonly inner = new MemoryCredentialVault();
  readonly stored: string[] = [];

  async put(args: {
    tenantId: string;
    material: CredentialMaterial;
  }): Promise<CredentialRef> {
    this.stored.push(new TextDecoder().decode(args.material));
    return this.inner.put(args);
  }

  async withMaterial<T>(args: {
    tenantId: string;
    ref: CredentialRef;
    use: (material: CredentialMaterial) => Promise<T> | T;
  }): Promise<T> {
    return this.inner.withMaterial(args);
  }

  delete(args: { tenantId: string; ref: CredentialRef }): Promise<void> {
    return this.inner.delete(args);
  }
}

let root: string;
let dataDir: string;
let server: WorkServer;
const vault = new HostVault();

beforeAll(async () => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-host-vault-"));
  dataDir = path.join(root, "server");
  server = await createWorkServer(
    testServerOptions({
      dataDir,
      env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
      hooks: {
        credentialVault: vault,
        // Connections are host code; an MCP endpoint passes as it is.
        connectionProviders: [
          defineHttpApiConnectionProvider({
            kind: "billing",
            displayName: "Billing",
            baseUrl: "https://api.billing.test/v1",
          }),
          defineMcpConnectionProvider({
            kind: "company-tools",
            displayName: "Company tools",
            server: {
              transport: "http",
              url: "https://tools.example.test/mcp",
            },
          }),
        ],
      },
    }),
  );
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  fs.rmSync(root, { recursive: true, force: true });
});

describe("a host-supplied credential vault (ADR 0315)", () => {
  it("holds a stored credential, and Work keeps no vault of its own", async () => {
    const operatorSecret = fs
      .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
      .trim();
    const created = await server.operatorApp.inject({
      method: "POST",
      url: "/_work/operator/users",
      headers: {
        authorization: `Bearer ${operatorSecret}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify({
        username: "admin",
        name: "Admin",
        password: "admin-test-password",
        administrator: true,
      }),
    });
    expect(created.statusCode).toBe(201);
    const token = await oauthAccessToken({
      app: server.app,
      username: "admin",
      password: "admin-test-password",
    });
    const api = (url: string, body?: unknown) =>
      server.app.inject({
        method: "POST",
        url,
        headers: {
          authorization: `Bearer ${token}`,
          ...(body ? { "content-type": "application/json" } : {}),
        },
        ...(body ? { payload: JSON.stringify(body) } : {}),
      });

    const connection = await api("/api/service-connections", {
      name: "billing",
      providerKind: "billing",
      principalKind: "tenant_service",
    });
    expect(connection.statusCode).toBe(201);
    const started = await api(
      `/api/service-connections/${connection.json().id}/authorize`,
    );
    expect(started.json().challenge).toMatchObject({ kind: "form" });
    const completed = await api("/api/connection-authorizations/complete", {
      state: started.json().authorizationId,
      callback: { apiKey: API_KEY },
    });
    expect(completed.statusCode).toBe(200);

    expect(vault.stored.some((material) => material.includes(API_KEY))).toBe(
      true,
    );
    expect(fs.existsSync(path.join(dataDir, "credentials"))).toBe(false);
    expect(
      filesUnder(dataDir).filter((file) => path.basename(file) === "vault.key"),
    ).toEqual([]);
    expect(
      filesUnder(dataDir).filter((file) =>
        fs.readFileSync(file).includes(API_KEY),
      ),
    ).toEqual([]);
  });

  it("refuses vault keys beside a supplied vault", async () => {
    const elsewhere = path.join(root, "with-keys");
    await expect(
      createWorkServer(
        testServerOptions({
          dataDir: elsewhere,
          env: {
            WORK_FAKE_AGENT: "1",
            WORK_VAULT_KEY: Buffer.alloc(32, 3).toString("base64"),
            PATH: process.env.PATH,
          },
          hooks: { credentialVault: new HostVault() },
        }),
      ),
    ).rejects.toThrow("keeps its own keys");
    await expect(
      createWorkServer(
        testServerOptions({
          dataDir: elsewhere,
          env: { WORK_FAKE_AGENT: "1", PATH: process.env.PATH },
          hooks: {
            credentialVault: new HostVault(),
            vaultKeys: async () => [new Uint8Array(32)],
          },
        }),
      ),
    ).rejects.toThrow("keeps its own keys");
  });
});
