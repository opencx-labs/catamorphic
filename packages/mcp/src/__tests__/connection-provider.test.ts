import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { defineMcpConnectionProvider } from "../connection-provider.js";
import {
  FAKE_ACCESS_TOKEN,
  FAKE_REFRESHED_TOKEN,
  type FakeOAuthMcp,
  startFakeOAuthMcp,
} from "./fake-oauth-server.js";

let fake: FakeOAuthMcp;

beforeAll(async () => {
  fake = await startFakeOAuthMcp();
});

afterAll(() => fake.close());

describe("MCP connection provider", () => {
  it("keeps OAuth state in vault material and exposes only tool metadata", async () => {
    const provider = defineMcpConnectionProvider({
      kind: "fake-mcp",
      displayName: "Fake MCP",
      server: { transport: "http", url: `${fake.base}/mcp` },
    });
    if (
      !provider.beginAuthorization ||
      !provider.completeAuthorization ||
      !provider.refresh
    ) {
      throw new Error(
        "HTTP MCP providers must support OAuth lifecycle methods",
      );
    }
    const begun = await provider.beginAuthorization({
      redirectUri: "https://app.test/api/connection-authorizations/callback",
      state: "opaque-state",
    });
    expect(begun.challenge.kind).toBe("url");
    expect(begun.privateState).toBeInstanceOf(Uint8Array);
    const consent = await fetch(begun.challenge.url, { redirect: "manual" });
    const callbackUrl = new URL(consent.headers.get("location")!);
    const callback = Object.fromEntries(callbackUrl.searchParams.entries());

    const authorized = await provider.completeAuthorization({
      callback,
      privateState: begun.privateState,
    });
    const credential = JSON.parse(
      new TextDecoder().decode(authorized.material),
    );
    expect(credential.oauth.tokens.access_token).toBe(FAKE_ACCESS_TOKEN);
    expect(authorized.capabilities).toEqual(["hello"]);
    expect(JSON.stringify(authorized.account)).not.toContain(FAKE_ACCESS_TOKEN);

    const actions = await provider.listActions({
      material: authorized.material,
      capabilities: ["hello"],
    });
    expect(actions).toEqual([
      expect.objectContaining({
        name: "hello",
        description: "Say hi",
        inputSchema: expect.objectContaining({ type: "object" }),
      }),
    ]);
    await expect(
      provider.invoke({
        material: authorized.material,
        capabilities: ["hello"],
        action: "hello",
        input: { name: "Ada" },
      }),
    ).resolves.toMatchObject({
      content: [{ type: "text", text: "hi Ada" }],
    });
    await expect(
      provider.invoke({
        material: authorized.material,
        capabilities: ["hello"],
        action: "admin",
        input: {},
      }),
    ).rejects.toThrow("outside the connection grant");

    const refreshed = await provider.refresh({ material: authorized.material });
    const refreshedCredential = JSON.parse(
      new TextDecoder().decode(refreshed.material),
    );
    expect(refreshedCredential.oauth.tokens.access_token).toBe(
      FAKE_REFRESHED_TOKEN,
    );
  });

  it("authorizes through a pre-registered confidential client without registration", async () => {
    const provider = defineMcpConnectionProvider({
      kind: "slack",
      displayName: "Slack",
      server: { transport: "http", url: `${fake.base}/mcp` },
      oauth: {
        client: { clientId: "work-slack-app", clientSecret: "client-secret" },
      },
    });
    if (!provider.beginAuthorization || !provider.completeAuthorization) {
      throw new Error("HTTP MCP providers must support OAuth");
    }
    const registrationsBefore = fake.registrations.length;
    const redirectUri =
      "https://work.example.test/api/connection-authorizations/callback";
    const begun = await provider.beginAuthorization({
      redirectUri,
      state: "service-state",
    });
    if (begun.challenge.kind !== "url") throw new Error("expected a URL");
    const authorizeUrl = new URL(begun.challenge.url);
    expect(authorizeUrl.searchParams.get("client_id")).toBe("work-slack-app");
    expect(authorizeUrl.searchParams.get("redirect_uri")).toBe(redirectUri);
    expect(authorizeUrl.searchParams.get("state")).toBe("service-state");
    const consent = await fetch(begun.challenge.url, { redirect: "manual" });
    const callback = Object.fromEntries(
      new URL(consent.headers.get("location")!).searchParams.entries(),
    );
    const authorized = await provider.completeAuthorization({
      callback,
      privateState: begun.privateState,
    });
    expect(authorized.capabilities).toEqual(["hello"]);
    expect(fake.registrations).toHaveLength(registrationsBefore);
    const exchange = fake.tokenRequests.at(-1);
    expect(exchange?.get("client_id")).toBe("work-slack-app");
    expect(exchange?.get("client_secret")).toBe("client-secret");
    expect(exchange?.get("redirect_uri")).toBe(redirectUri);
  });
});
