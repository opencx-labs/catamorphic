import { generateKeyPairSync, verify } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  createGithubAppJwt,
  GithubAppAuth,
  parseGithubAppPrivateKey,
} from "../app-auth.js";
import { GithubApiError, GithubAuthError } from "../types.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", {
  modulusLength: 2048,
  privateKeyEncoding: { type: "pkcs1", format: "pem" },
  publicKeyEncoding: { type: "spki", format: "pem" },
});
const APP = { appId: "12345", privateKey };
const NOW = 1_750_000_000_000;

function decodeSegment(segment: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(segment ?? "", "base64url").toString());
}

interface Call {
  method: string;
  path: string;
  authorization: string | null;
  body: unknown;
}

/** A fake GitHub API that mints numbered tokens and records every call. */
function fakeGithub(args: {
  now: () => number;
  installations?: Record<string, unknown>;
}) {
  const calls: Call[] = [];
  let minted = 0;
  const fetchImpl = (async (url: unknown, init?: RequestInit) => {
    const parsed = new URL(String(url));
    const headers = new Headers(init?.headers);
    calls.push({
      method: init?.method ?? "GET",
      path: parsed.pathname + parsed.search,
      authorization: headers.get("authorization"),
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
    });
    const tokenMatch = /^\/app\/installations\/(\d+)\/access_tokens$/.exec(
      parsed.pathname,
    );
    if (tokenMatch && init?.method === "POST") {
      minted += 1;
      const body = init.body ? JSON.parse(String(init.body)) : {};
      return Response.json(
        {
          token: `ghs_${minted}`,
          expires_at: new Date(args.now() + 60 * 60_000).toISOString(),
          permissions: body.permissions ?? { contents: "write" },
          repository_selection: body.repositories ? "selected" : "all",
          ...(body.repositories
            ? {
                repositories: body.repositories.map((name: string) => ({
                  full_name: `octo/${name}`,
                })),
              }
            : {}),
        },
        { status: 201 },
      );
    }
    const installation = args.installations?.[parsed.pathname];
    if (installation) return Response.json(installation);
    if (parsed.pathname === "/installation/token") {
      return new Response(null, { status: 204 });
    }
    return Response.json({ message: "Not Found" }, { status: 404 });
  }) as typeof fetch;
  return { calls, fetch: fetchImpl };
}

const INSTALLATION = {
  id: 77,
  account: { login: "octo", id: 1, type: "Organization" },
  repository_selection: "selected",
  permissions: { contents: "write", pull_requests: "write" },
  events: ["push"],
  app_slug: "work-octo",
  suspended_at: null,
};

describe("createGithubAppJwt", () => {
  it("signs an RS256 JWT GitHub accepts: backdated, short-lived, app issuer", () => {
    const jwt = createGithubAppJwt({ ...APP, now: NOW });
    const [header, payload, signature] = jwt.split(".");
    expect(decodeSegment(header)).toEqual({ alg: "RS256", typ: "JWT" });
    const claims = decodeSegment(payload);
    const seconds = Math.floor(NOW / 1000);
    expect(claims).toEqual({
      iat: seconds - 60,
      exp: seconds + 540,
      iss: 12345,
    });
    expect(Number(claims.exp) - Number(claims.iat)).toBeLessThanOrEqual(600);
    expect(
      verify(
        "sha256",
        Buffer.from(`${header}.${payload}`),
        publicKey,
        Buffer.from(signature ?? "", "base64url"),
      ),
    ).toBe(true);
  });

  it("keeps a client ID issuer as a string", () => {
    const jwt = createGithubAppJwt({ ...APP, appId: "Iv23abc", now: NOW });
    expect(decodeSegment(jwt.split(".")[1]).iss).toBe("Iv23abc");
  });

  it("refuses keys that are not RSA PEM keys", () => {
    expect(() => parseGithubAppPrivateKey("not a key")).toThrow(
      GithubAuthError,
    );
    const { privateKey: ec } = generateKeyPairSync("ec", {
      namedCurve: "P-256",
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    });
    expect(() => parseGithubAppPrivateKey(ec)).toThrow(/RSA/);
  });
});

describe("GithubAppAuth installation tokens", () => {
  it("mints with the app JWT, narrowed to repositories and permissions", async () => {
    const clock = NOW;
    const github = fakeGithub({ now: () => clock });
    const auth = new GithubAppAuth({ fetch: github.fetch, now: () => clock });
    const token = await auth.installationToken({
      app: APP,
      installationId: 77,
      repositories: ["octo/hello", "hello"],
      permissions: { contents: "read" },
    });
    expect(token).toEqual({
      token: "ghs_1",
      expiresAt: clock + 60 * 60_000,
      permissions: { contents: "read" },
      repositorySelection: "selected",
      repositories: ["octo/hello"],
    });
    const call = github.calls[0];
    expect(call?.path).toBe("/app/installations/77/access_tokens");
    expect(call?.body).toEqual({
      repositories: ["hello"],
      permissions: { contents: "read" },
    });
    const jwt = call?.authorization?.replace(/^Bearer /, "") ?? "";
    expect(decodeSegment(jwt.split(".")[1]).iss).toBe(12345);
  });

  it("caches per installation, repositories, and permissions and refreshes before expiry", async () => {
    let clock = NOW;
    const github = fakeGithub({ now: () => clock });
    const auth = new GithubAppAuth({ fetch: github.fetch, now: () => clock });
    const mint = (
      repositories?: string[],
      permissions?: { contents: "read" },
    ) =>
      auth.installationToken({
        app: APP,
        installationId: 77,
        ...(repositories ? { repositories } : {}),
        ...(permissions ? { permissions } : {}),
      });
    const [first, concurrent] = await Promise.all([mint(), mint()]);
    expect(first.token).toBe("ghs_1");
    expect(concurrent.token).toBe("ghs_1");
    expect((await mint(["hello"])).token).toBe("ghs_2");
    expect((await mint(["hello"])).token).toBe("ghs_2");
    expect((await mint(["hello"], { contents: "read" })).token).toBe("ghs_3");
    clock += 54 * 60_000;
    expect((await mint()).token).toBe("ghs_1");
    clock += 2 * 60_000; // Inside the five-minute refresh window.
    expect((await mint()).token).toBe("ghs_4");
    expect(github.calls).toHaveLength(4);
  });

  it("never shares tokens between different keys for the same app ID", async () => {
    const github = fakeGithub({ now: () => NOW });
    const auth = new GithubAppAuth({ fetch: github.fetch, now: () => NOW });
    const other = generateKeyPairSync("rsa", {
      modulusLength: 2048,
      privateKeyEncoding: { type: "pkcs1", format: "pem" },
      publicKeyEncoding: { type: "spki", format: "pem" },
    }).privateKey;
    const a = await auth.installationToken({ app: APP, installationId: 77 });
    const b = await auth.installationToken({
      app: { appId: APP.appId, privateKey: other },
      installationId: 77,
    });
    expect(a.token).not.toBe(b.token);
  });

  it("does not cache failures", async () => {
    let fail = true;
    const auth = new GithubAppAuth({
      now: () => NOW,
      fetch: (async () =>
        fail
          ? Response.json({ message: "Bad credentials" }, { status: 401 })
          : Response.json({
              token: "ghs_ok",
              expires_at: new Date(NOW + 3_600_000).toISOString(),
            })) as typeof fetch,
    });
    await expect(
      auth.installationToken({ app: APP, installationId: 77 }),
    ).rejects.toThrow(GithubApiError);
    fail = false;
    expect(
      (await auth.installationToken({ app: APP, installationId: 77 })).token,
    ).toBe("ghs_ok");
  });

  it("revokes and forgets cached tokens", async () => {
    const github = fakeGithub({ now: () => NOW });
    const auth = new GithubAppAuth({ fetch: github.fetch, now: () => NOW });
    await auth.installationToken({ app: APP, installationId: 77 });
    await auth.revokeCachedTokens({ app: APP });
    const revoke = github.calls.find((call) => call.method === "DELETE");
    expect(revoke).toMatchObject({
      path: "/installation/token",
      authorization: "Bearer ghs_1",
    });
    expect(
      (await auth.installationToken({ app: APP, installationId: 77 })).token,
    ).toBe("ghs_2");
  });
});

describe("GithubAppAuth installation discovery", () => {
  it("finds an organization's, a user's, or a repository's installation", async () => {
    const github = fakeGithub({
      now: () => NOW,
      installations: {
        "/orgs/octo/installation": INSTALLATION,
        "/users/mona/installation": { ...INSTALLATION, id: 78 },
        "/repos/octo/hello/installation": INSTALLATION,
        "/app/installations/77": INSTALLATION,
      },
    });
    const auth = new GithubAppAuth({ fetch: github.fetch, now: () => NOW });
    expect(await auth.findInstallation({ app: APP, owner: "octo" })).toEqual({
      id: 77,
      account: { login: "octo", id: 1, type: "Organization" },
      repositorySelection: "selected",
      permissions: { contents: "write", pull_requests: "write" },
      events: ["push"],
      appSlug: "work-octo",
      suspendedAt: null,
    });
    expect((await auth.findInstallation({ app: APP, owner: "mona" }))?.id).toBe(
      78,
    );
    expect(
      (
        await auth.findInstallation({
          app: APP,
          owner: "octo",
          repository: "hello",
        })
      )?.id,
    ).toBe(77);
    expect(await auth.findInstallation({ app: APP, owner: "nobody" })).toBe(
      null,
    );
    expect(
      (await auth.installation({ app: APP, installationId: 77 })).appSlug,
    ).toBe("work-octo");
    await expect(
      auth.findInstallation({ app: APP, owner: "../etc" }),
    ).rejects.toThrow(/Invalid owner/);
  });

  it("pages through every installation", async () => {
    const pages = [
      Array.from({ length: 100 }, (_, index) => ({
        ...INSTALLATION,
        id: index + 1,
      })),
      [{ ...INSTALLATION, id: 101 }],
    ];
    const auth = new GithubAppAuth({
      now: () => NOW,
      fetch: (async (url: unknown) => {
        const page = Number(new URL(String(url)).searchParams.get("page"));
        return Response.json(pages[page - 1] ?? []);
      }) as typeof fetch,
    });
    const all = await auth.listInstallations({ app: APP });
    expect(all).toHaveLength(101);
    expect(all.at(-1)?.id).toBe(101);
  });
});
