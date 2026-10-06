import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  gatewayConfigFromFile,
  gatewayProviders,
  parseGatewayConfig,
} from "./gateway-config.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-gateway-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

describe("gateway configuration", () => {
  function write(value: unknown): string {
    const file = path.join(dir, `gateway-${Math.random()}.json`);
    fs.writeFileSync(file, JSON.stringify(value));
    return file;
  }

  it("builds connections from the file and declares no guards (ADR 0183)", () => {
    const config = gatewayConfigFromFile({
      path: write({
        connections: [
          {
            type: "postgres",
            kind: "prod-db",
            displayName: "Production",
            maxRows: 200,
          },
          {
            type: "http",
            kind: "billing",
            displayName: "Billing",
            baseUrl: "https://api.billing.test/v1",
          },
          {
            kind: "company",
            displayName: "Company tools",
            url: "https://tools.example.test/mcp",
          },
        ],
      }),
      env: {},
    });
    expect(gatewayProviders(config).map((provider) => provider.kind)).toEqual([
      "prod-db",
      "billing",
      "company",
    ]);
    // Guards are host code passed as hooks, never entries in the file.
    expect(() =>
      gatewayConfigFromFile({
        path: write({
          guards: [{ type: "approval", name: "billing-writes" }],
        }),
        env: {},
      }),
    ).toThrow("guards");
  });

  it("takes typed config with resolved secrets and validates it like the file", () => {
    const config = parseGatewayConfig({
      connections: [
        {
          kind: "slack",
          displayName: "Slack",
          url: "https://mcp.slack.test/mcp",
          oauth: { client: { id: "1234.5678", secret: "from-a-vault" } },
        },
      ],
    });
    expect(config.connections[0]).toMatchObject({
      type: "mcp",
      transport: "http",
      oauth: { client: { id: "1234.5678", secret: "from-a-vault" } },
    });
    expect(() =>
      parseGatewayConfig({
        connections: [
          {
            type: "http",
            kind: "github",
            displayName: "GitHub",
            baseUrl: "https://api.github.com",
            maxResponseBytes: 64 * 1024 * 1024,
          },
        ],
      }),
    ).toThrow("config.gateway");
    // The image's file names secrets by variable, never inline.
    expect(() =>
      gatewayConfigFromFile({
        path: write({
          connections: [
            {
              kind: "slack",
              displayName: "Slack",
              url: "https://mcp.slack.test/mcp",
              oauth: { client: { id: "x", secret: "inline" } },
            },
          ],
        }),
        env: {},
      }),
    ).toThrow("connections.0");
  });

  it("takes HTTP limits within the host ceiling and MCP OAuth clients (ADR 0172)", () => {
    const config = gatewayConfigFromFile({
      path: write({
        connections: [
          {
            type: "http",
            kind: "github",
            displayName: "GitHub",
            baseUrl: "https://api.github.com",
            maxResponseBytes: 4 * 1024 * 1024,
            timeoutMs: 60_000,
          },
          {
            type: "postgres",
            kind: "prod-replica",
            displayName: "Production replica",
            poolSize: 3,
          },
          {
            kind: "slack",
            displayName: "Slack",
            url: "https://mcp.slack.test/mcp",
            oauth: {
              client: {
                id: "1234.5678",
                secretEnv: "SLACK_CLIENT_SECRET",
                scopes: ["search:read"],
              },
            },
          },
        ],
      }),
      env: { SLACK_CLIENT_SECRET: "slack-secret" },
    });
    expect(config.connections[0]).toMatchObject({
      maxResponseBytes: 4 * 1024 * 1024,
      timeoutMs: 60_000,
    });
    expect(config.connections[2]).toMatchObject({
      oauth: {
        client: {
          id: "1234.5678",
          secret: "slack-secret",
          scopes: ["search:read"],
        },
      },
    });
    const providers = gatewayProviders(config);
    expect(providers.map((provider) => provider.kind)).toEqual([
      "github",
      "prod-replica",
      "slack",
    ]);
    expect(typeof providers[1]?.close).toBe("function");
    expect(() =>
      gatewayConfigFromFile({
        path: write({
          connections: [
            {
              type: "http",
              kind: "github",
              displayName: "GitHub",
              baseUrl: "https://api.github.com",
              maxResponseBytes: 64 * 1024 * 1024,
            },
          ],
        }),
        env: {},
      }),
    ).toThrow("maxResponseBytes");
    expect(() =>
      gatewayConfigFromFile({
        path: write({
          connections: [
            {
              kind: "slack",
              displayName: "Slack",
              url: "https://mcp.slack.test/mcp",
              oauth: { client: { id: "x", secretEnv: "MISSING_SECRET" } },
            },
          ],
        }),
        env: {},
      }),
    ).toThrow("MISSING_SECRET");
  });

  it("offers an HTTP API's named operations as its actions (ADR 0179)", async () => {
    const config = gatewayConfigFromFile({
      path: write({
        connections: [
          {
            type: "http",
            kind: "slack",
            displayName: "Slack",
            baseUrl: "https://slack.com/api",
            actions: [
              {
                name: "conversations.replies",
                method: "get",
                path: "/conversations.replies",
                description: "Read a thread",
              },
              {
                name: "chat.postMessage",
                method: "post",
                path: "/chat.postMessage",
              },
            ],
          },
        ],
      }),
      env: {},
    });
    const [slack] = gatewayProviders(config);
    const authorized = await slack?.completeAuthorization?.({
      tenantId: "t",
      externalUserId: "admin",
      principal: "service",
      callback: { apiKey: "xoxb-test" },
    });
    expect(authorized?.capabilities).toEqual([
      "conversations.replies",
      "chat.postMessage",
    ]);
    const invalid =
      (actions: unknown, extra: object = {}) =>
      () =>
        gatewayConfigFromFile({
          path: write({
            connections: [
              {
                type: "http",
                kind: "slack",
                displayName: "Slack",
                baseUrl: "https://slack.com/api",
                actions,
                ...extra,
              },
            ],
          }),
          env: {},
        });
    const post = { name: "chat.postMessage", method: "post" };
    expect(
      invalid([{ ...post, path: "/chat.postMessage" }], { paths: ["/chat"] }),
    ).toThrow("either actions or paths");
    expect(
      invalid([
        { ...post, path: "/chat.postMessage" },
        { ...post, path: "/chat.update" },
      ]),
    ).toThrow("Duplicate action");
    expect(invalid([{ ...post, path: "/chat.postMessage?as_user=1" }])).toThrow(
      "plain path",
    );
  });

  it("serves an HTTP API without named operations to code in sandboxes, with Basic auth (ADR 0212)", () => {
    const config = gatewayConfigFromFile({
      path: write({
        connections: [
          {
            type: "http",
            kind: "logs",
            displayName: "Logs",
            baseUrl: "https://logs.example.test:8443",
            auth: { basic: true },
            paths: ["/"],
          },
        ],
      }),
      env: {},
    });
    const [logs] = gatewayProviders(config);
    expect(logs?.http?.baseUrl).toBe("https://logs.example.test:8443");
    expect(
      logs?.http?.headers({
        material: new TextEncoder().encode("reader:secret"),
      }),
    ).toEqual({
      authorization: `Basic ${Buffer.from("reader:secret").toString("base64")}`,
    });
    expect(() =>
      gatewayConfigFromFile({
        path: write({
          connections: [
            {
              type: "http",
              kind: "logs",
              displayName: "Logs",
              baseUrl: "https://logs.example.test",
              auth: { basic: false },
            },
          ],
        }),
        env: {},
      }),
    ).toThrow("Invalid gateway configuration");
  });
});
