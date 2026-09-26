import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  createWorkServer,
  SERVER_TENANT_ID,
  type WorkServer,
} from "../server.js";
import { testServerOptions } from "../test-support.js";

/**
 * Shares end to end (ADR 0165): a customer's identity provider (a fake OIDC
 * server on loopback) signs guests in; they see exactly what was shared with
 * them and can never hold an API token.
 */
const PASSWORD = "correct horse battery staple";
let root: string;
let server: WorkServer;
let idp: http.Server;
let idpBase: string;
let operatorSecret: string;
let projectId: string;
let managerToken: string;
let guest = { sub: "guest-ada", email: "ada@acme.test", name: "Ada" };

function jwtPart(value: object): string {
  return Buffer.from(JSON.stringify(value)).toString("base64url");
}

function startIdp(): Promise<void> {
  idp = http.createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/.well-known/openid-configuration") {
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          issuer: idpBase,
          authorization_endpoint: `${idpBase}/authorize`,
          token_endpoint: `${idpBase}/token`,
          userinfo_endpoint: `${idpBase}/userinfo`,
          jwks_uri: `${idpBase}/jwks`,
          response_types_supported: ["code"],
          subject_types_supported: ["public"],
          id_token_signing_alg_values_supported: ["RS256"],
        }),
      );
      return;
    }
    if (url.pathname === "/authorize") {
      const redirect = new URL(url.searchParams.get("redirect_uri") ?? "");
      redirect.searchParams.set("code", "fake-code");
      redirect.searchParams.set("state", url.searchParams.get("state") ?? "");
      response.statusCode = 302;
      response.setHeader("location", redirect.toString());
      response.end();
      return;
    }
    if (url.pathname === "/token") {
      const now = Math.floor(Date.now() / 1000);
      response.setHeader("content-type", "application/json");
      response.end(
        JSON.stringify({
          access_token: "idp-access",
          token_type: "Bearer",
          expires_in: 3600,
          id_token: `${jwtPart({ alg: "RS256", typ: "JWT" })}.${jwtPart({
            iss: idpBase,
            aud: "customers-client",
            sub: guest.sub,
            email: guest.email,
            email_verified: true,
            name: guest.name,
            iat: now,
            exp: now + 3600,
          })}.signature`,
        }),
      );
      return;
    }
    response.statusCode = 404;
    response.end();
  });
  return new Promise((resolve) =>
    idp.listen(0, "127.0.0.1", () => {
      const address = idp.address();
      if (address && typeof address !== "string") {
        idpBase = `http://127.0.0.1:${address.port}`;
      }
      resolve();
    }),
  );
}

function cookieHeader(setCookie: string | string[] | undefined): string {
  return (Array.isArray(setCookie) ? setCookie : setCookie ? [setCookie] : [])
    .map((cookie) => cookie.split(";")[0])
    .join("; ");
}

/** A guest signs in through the customer IdP from a share link. */
async function guestSession(shareId: string): Promise<string> {
  const next = encodeURIComponent(`/s/${shareId}`);
  const started = await server.app.inject({
    method: "POST",
    url: `/login/provider/customers?next=${next}`,
  });
  expect(started.statusCode).toBe(302);
  const stateCookies = cookieHeader(started.headers["set-cookie"]);
  const authorized = await fetch(started.headers.location ?? "", {
    redirect: "manual",
  });
  const callback = new URL(authorized.headers.get("location") ?? "");
  const finished = await server.app.inject({
    method: "GET",
    url: `${callback.pathname}${callback.search}`,
    headers: { cookie: stateCookies },
  });
  expect(finished.statusCode).toBe(302);
  expect(finished.headers.location).toContain(`/s/${shareId}`);
  return cookieHeader(finished.headers["set-cookie"]);
}

async function memberToken(username: string) {
  const login = await server.app.inject({
    method: "POST",
    url: "/api/auth/sign-in/username",
    payload: { username, password: PASSWORD },
  });
  return tokenFor(cookieHeader(login.headers["set-cookie"]));
}

async function tokenFor(cookie: string) {
  const redirectUri = "http://127.0.0.1:49152/callback";
  const registered = await server.app.inject({
    method: "POST",
    url: "/api/auth/mcp/register",
    payload: {
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Share test",
    },
  });
  const clientId: string = registered.json().client_id;
  const verifier = randomBytes(32).toString("base64url");
  const authorize = new URLSearchParams({
    client_id: clientId,
    redirect_uri: redirectUri,
    response_type: "code",
    scope: "openid profile email offline_access",
    state: "share",
    code_challenge: createHash("sha256").update(verifier).digest("base64url"),
    code_challenge_method: "S256",
  });
  const authorized = await server.app.inject({
    method: "GET",
    url: `/api/auth/mcp/authorize?${authorize}`,
    headers: { cookie },
  });
  const code =
    new URL(authorized.headers.location ?? "").searchParams.get("code") ?? "";
  const token = await server.app.inject({
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
  return token;
}

function createShare(body: Record<string, unknown>) {
  return server.app.inject({
    method: "POST",
    url: `/api/projects/${projectId}/shares`,
    headers: { authorization: `Bearer ${managerToken}` },
    payload: body,
  });
}

beforeAll(async () => {
  await startIdp();
  root = fs.mkdtempSync(path.join(os.tmpdir(), "work-shares-"));
  const authConfig = path.join(root, "auth-config.json");
  fs.writeFileSync(
    authConfig,
    JSON.stringify({
      providers: [
        {
          id: "customers",
          label: "Customer account",
          discoveryUrl: `${idpBase}/.well-known/openid-configuration`,
          clientId: "customers-client",
          clientSecret: "customers-secret",
          audience: "guests",
        },
      ],
    }),
  );
  server = await createWorkServer(
    testServerOptions({
      dataDir: path.join(root, "data"),
      env: {
        WORK_FAKE_AGENT: "1",
        WORK_AUTH_CONFIG: authConfig,
        PATH: process.env.PATH,
      },
    }),
  );
  operatorSecret = fs
    .readFileSync(path.join(root, "data", "operator-secret"), "utf8")
    .trim();
  const operator = (url: string, body: unknown) =>
    server.operatorApp.inject({
      method: "POST",
      url,
      headers: {
        authorization: `Bearer ${operatorSecret}`,
        "content-type": "application/json",
      },
      payload: JSON.stringify(body),
    });
  const project = await operator("/_work/operator/projects", {
    name: "Customers",
    roles: [
      {
        slug: "manager",
        definition: {
          version: 1,
          name: "Manager",
          permissions: ["program:read", "publications:write"],
          agents: ["*"],
          environments: ["default"],
        },
      },
    ],
    admission: { mode: "invitation_only", defaultRole: "manager" },
  });
  projectId = project.json().project.id;
  await operator("/_work/operator/users", {
    username: "manager",
    name: "Manager",
    password: PASSWORD,
    memberships: [{ projectId, roles: ["manager"] }],
  });
  await server.catamorphic.core.deployment.deploy(
    SERVER_TENANT_ID,
    projectId,
    "share-test",
    {
      message: "Customer material",
      files: {
        "docs/pilot.md":
          "# Pilot plan\n\nWeek one.\n\n<script>alert(1)</script>\n\n[bad](javascript:alert(1))\n",
        "customers/acme/status.md": "# Acme status\n",
        "customers/globex/status.md": "# Globex status\n",
      },
    },
  );
  managerToken = (await memberToken("manager")).json().access_token;
}, 120_000);

afterAll(async () => {
  await server?.shutdown();
  await new Promise((resolve) => idp?.close(resolve));
  fs.rmSync(root, { recursive: true, force: true });
});

describe("shares (ADR 0165)", () => {
  it("shows a guest exactly the shared document after signing in", async () => {
    const created = await createShare({
      kind: "document",
      target: "docs/pilot.md",
      title: "Pilot plan",
      audience: { emails: ["ada@acme.test"] },
    });
    expect(created.statusCode).toBe(201);
    const share = created.json();
    expect(share.url).toMatch(/\/s\/[A-Za-z0-9_-]+$/);

    const anonymous = await server.app.inject(`/s/${share.id}`);
    expect(anonymous.statusCode).toBe(302);
    expect(anonymous.headers.location).toBe(
      `/login?next=${encodeURIComponent(`/s/${share.id}`)}`,
    );
    const login = await server.app.inject(anonymous.headers.location ?? "");
    expect(login.body).toContain("Continue with Customer account");
    // The ordinary client sign-in never offers guest providers.
    expect((await server.app.inject("/login")).body).not.toContain(
      "Customer account",
    );

    const cookie = await guestSession(share.id);
    const page = await server.app.inject({
      url: `/s/${share.id}`,
      headers: { cookie },
    });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain("<h1>Pilot plan</h1>");
    expect(page.body).not.toContain("<script>alert(1)</script>");
    expect(page.body).not.toContain('href="javascript:');

    const raw = await server.app.inject({
      url: `/s/${share.id}/raw`,
      headers: { cookie },
    });
    expect(raw.headers["content-security-policy"]).toBe("sandbox");
    expect(raw.body).toContain("# Pilot plan");
  });

  it("never gives a guest an API token", async () => {
    guest = { sub: "guest-ada", email: "ada@acme.test", name: "Ada" };
    const share = (
      await createShare({
        kind: "document",
        target: "docs/pilot.md",
        audience: { emails: ["ada@acme.test"] },
      })
    ).json();
    const cookie = await guestSession(share.id);
    const token = await tokenFor(cookie);
    expect(token.statusCode).toBe(400);
    expect(token.json().error_description).toMatch(/guest/);
  });

  it("shares a folder with a domain and nothing beside it", async () => {
    guest = { sub: "guest-wile", email: "wile@acme.test", name: "Wile" };
    const share = (
      await createShare({
        kind: "folder",
        target: "customers/acme",
        title: "Acme",
        audience: { domains: ["acme.test"] },
      })
    ).json();
    const cookie = await guestSession(share.id);
    const listing = await server.app.inject({
      url: `/s/${share.id}`,
      headers: { cookie },
    });
    expect(listing.body).toContain("status.md");
    const file = await server.app.inject({
      url: `/s/${share.id}/f/status.md`,
      headers: { cookie },
    });
    expect(file.body).toContain("<h1>Acme status</h1>");
    const traversal = await server.app.inject({
      url: `/s/${share.id}/f/..%2Fglobex%2Fstatus.md`,
      headers: { cookie },
    });
    expect(traversal.body).not.toContain("Globex");
  });

  it("refuses people it was not shared with, and everyone once revoked", async () => {
    guest = { sub: "guest-ada", email: "ada@acme.test", name: "Ada" };
    const share = (
      await createShare({
        kind: "document",
        target: "docs/pilot.md",
        audience: { emails: ["ada@acme.test"] },
      })
    ).json();
    const adaCookie = await guestSession(share.id);

    guest = { sub: "guest-bob", email: "bob@other.test", name: "Bob" };
    const bobCookie = await guestSession(share.id);
    const bob = await server.app.inject({
      url: `/s/${share.id}`,
      headers: { cookie: bobCookie },
    });
    expect(bob.statusCode).toBe(404);
    expect(bob.body).not.toContain("Pilot plan</h1>");

    const revoked = await server.app.inject({
      method: "DELETE",
      url: `/api/projects/${projectId}/shares/${share.id}`,
      headers: { authorization: `Bearer ${managerToken}` },
    });
    expect(revoked.statusCode).toBe(204);
    const ada = await server.app.inject({
      url: `/s/${share.id}`,
      headers: { cookie: adaCookie },
    });
    expect(ada.statusCode).toBe(404);
  });

  it("requires a manager's permission to share and refuses unreadable targets", async () => {
    const missing = await createShare({
      kind: "document",
      target: "docs/nowhere.md",
      audience: { emails: ["ada@acme.test"] },
    });
    expect(missing.statusCode).toBeGreaterThanOrEqual(400);
    const anonymous = await server.app.inject({
      method: "POST",
      url: `/api/projects/${projectId}/shares`,
      payload: {
        kind: "document",
        target: "docs/pilot.md",
        audience: { emails: ["x@y.test"] },
      },
    });
    expect(anonymous.statusCode).toBe(401);
  });
});
