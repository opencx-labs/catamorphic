import { describe, expect, it } from "vitest";
import { connectLinkFromParams, parseConnectLink } from "./connect-link.js";

const BASE =
  "server=https%3A%2F%2Fbrain.acme.dev%2Fapi&project=p-1&name=Acme%20Brain";

describe("parseConnectLink", () => {
  it("parses the catamorphic:// scheme", () => {
    const link = parseConnectLink(`catamorphic://connect?${BASE}`);
    expect(link).toEqual({
      serverUrl: "https://brain.acme.dev/api",
      remoteProjectId: "p-1",
      remoteProjectName: "Acme Brain",
    });
  });

  it("parses an https invite URL carrying the same params", () => {
    const link = parseConnectLink(`https://pwa.acme.dev/?${BASE}`);
    expect(link?.serverUrl).toBe("https://brain.acme.dev/api");
    expect(link?.remoteProjectId).toBe("p-1");
  });

  it("carries an invitation identifier without treating it as a credential", () => {
    const link = parseConnectLink(
      `catamorphic://connect?${BASE}&invitation=invite-123`,
    );
    expect(link?.invitationId).toBe("invite-123");
  });

  it("rejects credential-bearing links, missing fields, bad server schemes, and garbage", () => {
    expect(parseConnectLink("catamorphic://connect?server=x")).toBeNull();
    expect(
      parseConnectLink(`catamorphic://connect?${BASE}&token=secret`),
    ).toBeNull();
    expect(
      parseConnectLink("catamorphic://connect?server=ftp%3A%2F%2Fx&project=p"),
    ).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=http%3A%2F%2Fbrain.acme.dev%2Fapi&project=p",
      ),
    ).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=http%3A%2F%2Flocalhost%3A4700%2Fapi&project=p",
      ),
    ).toMatchObject({ serverUrl: "http://localhost:4700/api" });
    expect(parseConnectLink("not a link")).toBeNull();
  });

  it("carries a session deep-link when present", () => {
    const link = parseConnectLink(
      `catamorphic://connect?${BASE}&session=abc-123`,
    );
    expect(link?.sessionId).toBe("abc-123");
    expect(
      parseConnectLink(`catamorphic://connect?${BASE}`)?.sessionId,
    ).toBeUndefined();
  });

  it("strips trailing slashes from the server URL", () => {
    const link = connectLinkFromParams(
      new URLSearchParams({
        server: "https://brain.acme.dev/api///",
        project: "p",
      }),
    );
    expect(link?.serverUrl).toBe("https://brain.acme.dev/api");
  });
});
