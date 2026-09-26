import { generateKeyPairSync } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { parseWorkAuthConfig } from "../auth/auth-config.js";
import { assertHostedDomainAllowed } from "../auth/work-auth.js";
import { DirectoryUnavailableError } from "./directory.js";
import { GoogleWorkspaceDirectory } from "./google-directory.js";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "work-google-directory-"));
afterAll(() => fs.rmSync(dir, { recursive: true, force: true }));

function keyFile(): string {
  const { privateKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
  const file = path.join(dir, `key-${Math.random()}.json`);
  fs.writeFileSync(
    file,
    JSON.stringify({
      client_email: "directory@project.iam.gserviceaccount.com",
      private_key: privateKey.export({ type: "pkcs8", format: "pem" }),
    }),
  );
  return file;
}

interface Recorded {
  url: string;
  authorization?: string;
}

function fakeGoogle(routes: Record<string, () => Response>) {
  const calls: Recorded[] = [];
  const fetch = async (url: string, init?: RequestInit) => {
    const headers = new Headers(init?.headers);
    calls.push({
      url,
      authorization: headers.get("authorization") ?? undefined,
    });
    if (url === "https://oauth2.googleapis.com/token") {
      const body = new URLSearchParams(String(init?.body));
      expect(body.get("grant_type")).toBe(
        "urn:ietf:params:oauth:grant-type:jwt-bearer",
      );
      expect(body.get("assertion")?.split(".")).toHaveLength(3);
      return Response.json({
        access_token: "directory-token",
        expires_in: 3600,
      });
    }
    const route = Object.entries(routes).find(([path]) => url.includes(path));
    return route ? route[1]() : new Response(null, { status: 404 });
  };
  return { fetch, calls };
}

describe("Google Workspace directory", () => {
  it("reports suspended, archived, and deleted accounts as inactive", async () => {
    const google = fakeGoogle({
      "/users/suspended": () => Response.json({ suspended: true }),
      "/users/archived": () => Response.json({ archived: true }),
    });
    const directory = new GoogleWorkspaceDirectory({
      providerId: "google",
      credentials: { keyFile: keyFile() },
      fetch: google.fetch,
    });
    const check = (accountId: string) =>
      directory.check({ accountId, email: "a@example.com", groups: [] });
    expect(await check("suspended")).toEqual({
      active: false,
      reason: "suspended",
    });
    expect(await check("archived")).toEqual({
      active: false,
      reason: "archived",
    });
    expect(await check("deleted")).toEqual({
      active: false,
      reason: "deleted",
    });
    // One token exchange serves every lookup until it nears expiry.
    expect(
      google.calls.filter((call) => call.url.endsWith("/token")),
    ).toHaveLength(1);
    expect(
      google.calls
        .filter((call) => call.url.includes("/users/"))
        .every((call) => call.authorization === "Bearer directory-token"),
    ).toBe(true);
  });

  it("answers group membership and enforces required groups", async () => {
    const google = fakeGoogle({
      "/users/ada": () => Response.json({ suspended: false, archived: false }),
      "/groups/brain%40example.com/hasMember/ada": () =>
        Response.json({ isMember: true }),
      "/groups/eng%40example.com/hasMember/ada": () =>
        Response.json({ isMember: false }),
      "/users/bob": () => Response.json({ suspended: false }),
      "/groups/brain%40example.com/hasMember/bob": () =>
        Response.json({ isMember: false }),
    });
    const directory = new GoogleWorkspaceDirectory({
      providerId: "google",
      credentials: { keyFile: keyFile() },
      requiredGroups: ["Brain@example.com"],
      fetch: google.fetch,
    });
    expect(
      await directory.check({
        accountId: "ada",
        email: "ada@example.com",
        groups: ["eng@example.com"],
      }),
    ).toEqual({ active: true, groups: ["brain@example.com"] });
    expect(
      await directory.check({
        accountId: "bob",
        email: "bob@example.com",
        groups: [],
      }),
    ).toEqual({ active: false, reason: "not_in_required_group" });
  });

  it("distinguishes an unreachable directory from an inactive account", async () => {
    const directory = new GoogleWorkspaceDirectory({
      providerId: "google",
      credentials: { keyFile: keyFile() },
      fetch: fakeGoogle({
        "/users/ada": () => new Response("denied", { status: 403 }),
      }).fetch,
    });
    await expect(
      directory.check({ accountId: "ada", email: "a@example.com", groups: [] }),
    ).rejects.toBeInstanceOf(DirectoryUnavailableError);

    const offline = new GoogleWorkspaceDirectory({
      providerId: "google",
      credentials: { keyFile: keyFile() },
      fetch: async () => {
        throw new TypeError("fetch failed");
      },
    });
    await expect(
      offline.check({ accountId: "ada", email: "a@example.com", groups: [] }),
    ).rejects.toBeInstanceOf(DirectoryUnavailableError);
  });

  it("uses the metadata server when running as the service account", async () => {
    const calls: string[] = [];
    const directory = new GoogleWorkspaceDirectory({
      providerId: "google",
      credentials: { metadataServer: true },
      fetch: async (url, init) => {
        calls.push(url);
        if (url.startsWith("http://metadata.google.internal/")) {
          expect(new Headers(init?.headers).get("metadata-flavor")).toBe(
            "Google",
          );
          return Response.json({ access_token: "meta", expires_in: 300 });
        }
        return Response.json({ suspended: false });
      },
    });
    expect(
      await directory.check({ accountId: "ada", email: "a@x.com", groups: [] }),
    ).toEqual({ active: true, groups: [] });
    expect(calls[0]).toContain("admin.directory.user.readonly");
  });
});

describe("Google Workspace sign-in", () => {
  it("requires the ID token hd claim, not just an email domain", () => {
    const allowed = ["example.com"];
    expect(() =>
      assertHostedDomainAllowed(
        { email: "ada@example.com", email_verified: true, hd: "example.com" },
        allowed,
      ),
    ).not.toThrow();
    // A consumer Google account using a company address has no hd.
    expect(() =>
      assertHostedDomainAllowed(
        { email: "ada@example.com", email_verified: true },
        allowed,
      ),
    ).toThrow(/Workspace/);
    expect(() =>
      assertHostedDomainAllowed(
        { email: "ada@other.com", email_verified: true, hd: "other.com" },
        allowed,
      ),
    ).toThrow(/Workspace/);
    expect(() =>
      assertHostedDomainAllowed(
        { email: "ada@example.com", email_verified: false, hd: "example.com" },
        allowed,
      ),
    ).toThrow(/verified/);
  });

  it("configures a Workspace provider with hosted-domain hints and defaults", () => {
    const config = parseWorkAuthConfig({
      local: { enabled: false },
      providers: [
        {
          kind: "google-workspace",
          clientId: "client",
          clientSecret: "secret",
          domains: ["Example.com"],
          directory: {
            credentials: { keyFile: "/run/secrets/directory.json" },
            requiredGroups: ["brain@example.com"],
          },
        },
      ],
    });
    expect(config.providers[0]).toMatchObject({
      kind: "google-workspace",
      id: "google",
      label: "Google",
      hostedDomains: ["example.com"],
      allowedDomains: [],
      authorizationParams: { hd: "example.com", prompt: "select_account" },
      directory: { requiredGroups: ["brain@example.com"] },
    });
    expect(config.sessions).toEqual({
      accessTokenSeconds: 900,
      idleSeconds: 14 * 86_400,
      maxAgeSeconds: 30 * 86_400,
    });
    expect(config.directory).toEqual({
      checkIntervalMs: 300_000,
      graceMs: 1_800_000,
    });
    expect(config.publicMethods()).toEqual({
      local: false,
      providers: [{ id: "google", label: "Google" }],
    });
  });

  it("rejects lifetimes that weaken the session policy", () => {
    expect(() =>
      parseWorkAuthConfig({ sessions: { accessTokenMinutes: 240 } }),
    ).toThrow(/accessTokenMinutes/);
    expect(() =>
      parseWorkAuthConfig({ sessions: { idleDays: 14, maxDays: 7 } }),
    ).toThrow(/idle/);
  });
});
