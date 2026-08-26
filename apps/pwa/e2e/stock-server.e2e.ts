import { createHash, randomBytes } from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, it } from "vitest";
import { chromeBinary, launchPwa, type PwaHandle } from "./harness.js";

/**
 * The whole product loop against the REAL stock server (apps/server):
 * a setup agent bootstraps an ordinary manager, that manager creates a
 * credential-free invitation, the phone signs in and redeems it, and a
 * scoped member chats with the fake assistant, including the
 * project-agent addressing a scoped identity requires.
 */

const SERVER_DIR = path.resolve(import.meta.dirname, "../../server");

const TYPE = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;
const TYPE_INPUT = (selector: string, value: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, ${JSON.stringify(value)});
    el.dispatchEvent(new Event("input", { bubbles: true }));
    return true;
  })()
`;
const CLICK = (selector: string) => `
  (() => {
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return false;
    el.click();
    return true;
  })()
`;

describe.skipIf(!chromeBinary())("pwa against the stock server", () => {
  let app: PwaHandle;
  let dataDir: string;

  beforeAll(async () => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "pwa-stock-"));
    app = await launchPwa({
      backend: (apiPort) => ({
        command: "bun",
        args: ["src/index.ts"],
        cwd: SERVER_DIR,
        env: {
          PORT: String(apiPort),
          CATAMORPHIC_DATA_DIR: dataDir,
          CATAMORPHIC_FAKE_AGENT: "1",
          CATAMORPHIC_MDNS: "off",
        },
      }),
      mintLink: async (apiBase) => {
        const origin = apiBase.replace(/\/api$/, "");
        const operatorSecret = fs
          .readFileSync(path.join(dataDir, "operator-secret"), "utf8")
          .trim();
        const operatorHeaders = {
          authorization: `Bearer ${operatorSecret}`,
          "content-type": "application/json",
        };
        const projectResponse = await fetch(
          `${origin}/_catamorphic/operator/projects`,
          {
            method: "POST",
            headers: operatorHeaders,
            body: JSON.stringify({
              name: "brain",
              roles: [
                {
                  slug: "member",
                  definition: {
                    version: 1,
                    name: "Member",
                    agents: ["assistant"],
                    environments: ["local"],
                    documents: [
                      { path: "store/users/{user}/**", access: "write" },
                    ],
                  },
                },
                {
                  slug: "manager",
                  definition: {
                    version: 1,
                    name: "Manager",
                    permissions: ["memberships:manage", "roles:manage"],
                  },
                },
              ],
              admission: {
                mode: "invitation_only",
                defaultRole: "member",
                approvedDomains: [],
              },
            }),
          },
        );
        if (!projectResponse.ok) {
          throw new Error(`Project setup failed (${projectResponse.status})`);
        }
        const project = (await projectResponse.json()) as {
          project: { id: string };
        };
        for (const user of [
          {
            username: "manager",
            name: "Project Manager",
            password: "manager password for browser test",
            memberships: [
              { projectId: project.project.id, roles: ["manager"] },
            ],
          },
          {
            username: "sam",
            name: "Sam Member",
            password: "member password for browser test",
          },
        ]) {
          const response = await fetch(
            `${origin}/_catamorphic/operator/users`,
            {
              method: "POST",
              headers: operatorHeaders,
              body: JSON.stringify(user),
            },
          );
          if (!response.ok) {
            throw new Error(`User setup failed (${response.status})`);
          }
        }
        const managerToken = await oauthAccessToken({
          origin,
          username: "manager",
          password: "manager password for browser test",
        });
        const invitationResponse = await fetch(
          `${apiBase}/projects/${project.project.id}/admission/invitations`,
          {
            method: "POST",
            headers: {
              authorization: `Bearer ${managerToken}`,
              "content-type": "application/json",
            },
            body: JSON.stringify({ roles: ["member"] }),
          },
        );
        if (!invitationResponse.ok) {
          throw new Error(
            `Invitation creation failed (${invitationResponse.status})`,
          );
        }
        const invitation = (await invitationResponse.json()) as { id: string };
        return `catamorphic://connect?server=${encodeURIComponent(apiBase)}&project=${project.project.id}&name=brain&invitation=${invitation.id}`;
      },
      backendTimeoutMs: 120_000,
    });
  }, 180_000);

  afterAll(async () => {
    await app?.stop();
    if (dataDir) fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it("redeems a real invite and chats as a scoped member", async () => {
    await app.waitFor(
      "!!document.querySelector('[data-testid=connect-input]')",
    );
    await app.eval(TYPE("[data-testid=connect-input]", app.connectLink));
    await app.waitFor(
      "!document.querySelector('[data-testid=connect-submit]').disabled",
    );
    await app.eval(CLICK("[data-testid=connect-submit]"));
    await app.waitFor("!!document.querySelector('input[name=username]')", {
      timeoutMs: 30_000,
      label: "stock server login page",
    });
    await app.eval(TYPE_INPUT("input[name=username]", "sam"));
    await app.eval(
      TYPE_INPUT("input[name=password]", "member password for browser test"),
    );
    await app.eval(CLICK("form#local button"));
    try {
      await app.waitFor("!!document.querySelector('[data-testid=new-chat]')", {
        timeoutMs: 30_000,
        label: "sessions screen",
      });
    } catch (error) {
      const diagnostic = await app.eval<{ url: string; text: string }>(
        "({ url: location.href, text: document.body.innerText })",
      );
      throw new Error(
        `${String(error)}\n--- url ---\n${diagnostic.url}\n--- page text ---\n${diagnostic.text}`,
      );
    }
    await app.eval(CLICK("[data-testid=new-chat]"));
    await app.waitFor("!!document.querySelector('[data-testid=chat-input]')");
    // The send button unlocks once /me resolved the project agent.
    await app.eval(TYPE("[data-testid=chat-input]", "hello real server"));
    await app.waitFor(
      "!document.querySelector('[data-testid=chat-send]').disabled",
      { label: "send ready (me resolved)" },
    );
    await app.eval(CLICK("[data-testid=chat-send]"));
    try {
      await app.waitFor(
        "document.body.innerText.includes('Echo: hello real server')",
        {
          timeoutMs: 60_000,
          label: "assistant reply through the stock server",
        },
      );
    } catch (error) {
      const text = await app.eval<string>("document.body.innerText");
      throw new Error(`${String(error)}\n--- page text ---\n${text}`);
    }
  }, 120_000);
});

async function oauthAccessToken(options: {
  origin: string;
  username: string;
  password: string;
}): Promise<string> {
  const login = await fetch(`${options.origin}/api/auth/sign-in/username`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      username: options.username,
      password: options.password,
    }),
  });
  if (!login.ok) throw new Error(`Manager sign-in failed (${login.status})`);
  const cookie = login.headers
    .getSetCookie()
    .map((value) => value.split(";", 1)[0])
    .join("; ");
  const redirectUri = "http://127.0.0.1:49152/callback";
  const registration = await fetch(`${options.origin}/api/auth/mcp/register`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      redirect_uris: [redirectUri],
      token_endpoint_auth_method: "none",
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      client_name: "Stock PWA test setup",
    }),
  });
  const clientId = ((await registration.json()) as { client_id: string })
    .client_id;
  const verifier = randomBytes(32).toString("base64url");
  const challenge = createHash("sha256").update(verifier).digest("base64url");
  const authorize = new URL(`${options.origin}/api/auth/mcp/authorize`);
  authorize.searchParams.set("client_id", clientId);
  authorize.searchParams.set("redirect_uri", redirectUri);
  authorize.searchParams.set("response_type", "code");
  authorize.searchParams.set("scope", "openid profile email offline_access");
  authorize.searchParams.set("state", "setup-state");
  authorize.searchParams.set("code_challenge", challenge);
  authorize.searchParams.set("code_challenge_method", "S256");
  const authorized = await fetch(authorize, {
    headers: { cookie },
    redirect: "manual",
  });
  const code = new URL(
    authorized.headers.get("location") ?? "",
  ).searchParams.get("code");
  if (!code) throw new Error("Manager authorization returned no code");
  const token = await fetch(`${options.origin}/api/auth/mcp/token`, {
    method: "POST",
    headers: { "content-type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({
      grant_type: "authorization_code",
      client_id: clientId,
      redirect_uri: redirectUri,
      code,
      code_verifier: verifier,
    }),
  });
  if (!token.ok) throw new Error(`Manager token failed (${token.status})`);
  return ((await token.json()) as { access_token: string }).access_token;
}
