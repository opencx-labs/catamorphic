import { describe, expect, it } from "vitest";
import { parseConnectLink } from "./connect-link.js";

describe("remote project locator links", () => {
  it("parses a credential-free server and project locator", () => {
    expect(
      parseConnectLink(
        "catamorphic://connect?server=https%3A%2F%2Fbrain.acme.com%2Fapi%2F&project=p-1&name=Acme%20brain",
      ),
    ).toEqual({
      serverUrl: "https://brain.acme.com/api",
      remoteProjectId: "p-1",
      remoteProjectName: "Acme brain",
    });
  });

  it("carries an invitation identifier without treating it as a credential", () => {
    expect(
      parseConnectLink(
        "catamorphic://connect?server=https%3A%2F%2Fbrain.acme.com%2Fapi&project=p-1&invitation=invite-123",
      ),
    ).toMatchObject({ invitationId: "invite-123" });
  });

  it("rejects legacy credential-bearing and unsafe links", () => {
    expect(
      parseConnectLink(
        "catamorphic://connect?server=https://x/api&project=p&token=legacy",
      ),
    ).toBeNull();
    expect(
      parseConnectLink("https://example.com/connect?server=x&project=z"),
    ).toBeNull();
    expect(
      parseConnectLink("catamorphic://open?server=https://x&project=z"),
    ).toBeNull();
    expect(
      parseConnectLink("catamorphic://connect?server=ftp://x&project=z"),
    ).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=http://brain.acme.com/api&project=z",
      ),
    ).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=http://127.0.0.1:4700/api&project=z",
      ),
    ).toMatchObject({ serverUrl: "http://127.0.0.1:4700/api" });
    expect(parseConnectLink("not a url")).toBeNull();
  });
});
