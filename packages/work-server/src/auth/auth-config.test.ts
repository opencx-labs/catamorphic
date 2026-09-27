import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseWorkAuthConfig, workAuthConfigFromFile } from "./auth-config.js";

const dirs: string[] = [];

afterEach(() => {
  for (const dir of dirs.splice(0)) fs.rmSync(dir, { recursive: true });
});

describe("Work server auth configuration", () => {
  it("defaults an unconfigured Work server to local credentials", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cata-auth-config-"));
    dirs.push(dataDir);
    const config = parseWorkAuthConfig(
      workAuthConfigFromFile(path.join(dataDir, "auth-config.json")),
    );
    expect(config.local).toEqual({ enabled: true });
    expect(config.providers).toEqual([]);
    expect(config.publicMethods()).toEqual({ local: true, providers: [] });
  });

  it("loads generic OIDC discovery without exposing secrets in its summary", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cata-auth-config-"));
    dirs.push(dataDir);
    const file = path.join(dataDir, "configured.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        local: { enabled: false },
        providers: [
          {
            id: "workspace",
            label: "Company Google Workspace",
            discoveryUrl:
              "https://accounts.google.com/.well-known/openid-configuration",
            clientId: "client-id",
            clientSecret: "do-not-render",
            scopes: ["openid", "email", "profile"],
            allowedDomains: ["example.com"],
          },
        ],
      }),
      { mode: 0o600 },
    );
    const config = parseWorkAuthConfig(workAuthConfigFromFile(file));
    expect(config.providers[0]?.clientSecret).toBe("do-not-render");
    expect(config.publicMethods()).toEqual({
      local: false,
      providers: [{ id: "workspace", label: "Company Google Workspace" }],
    });
  });

  it("rejects duplicate provider ids and insecure remote discovery", () => {
    const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "cata-auth-config-"));
    dirs.push(dataDir);
    const file = path.join(dataDir, "bad.json");
    fs.writeFileSync(
      file,
      JSON.stringify({
        providers: [
          {
            id: "oidc",
            label: "One",
            discoveryUrl:
              "http://identity.example.com/.well-known/openid-configuration",
            clientId: "one",
            clientSecret: "secret",
          },
          {
            id: "oidc",
            label: "Two",
            discoveryUrl:
              "https://identity.example.com/.well-known/openid-configuration",
            clientId: "two",
            clientSecret: "secret",
          },
        ],
      }),
    );
    expect(() => workAuthConfigFromFile(file)).toThrow(/provider|discovery/i);
  });

  it("validates code-built config with the file's rules (ADR 0183)", () => {
    const config = parseWorkAuthConfig({
      providers: [
        {
          kind: "google-workspace",
          clientId: "client",
          clientSecret: "secret",
          domains: ["example.com"],
          directory: {
            credentials: {
              key: { client_email: "d@example.com", private_key: "pem" },
            },
          },
        },
      ],
    });
    expect(config.providers[0]?.directory?.credentials).toEqual({
      key: { client_email: "d@example.com", private_key: "pem" },
    });
    expect(() =>
      parseWorkAuthConfig({ sessions: { idleDays: 14, maxDays: 7 } }),
    ).toThrow("config.auth");
  });
});
