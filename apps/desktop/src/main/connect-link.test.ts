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
    expect(parseConnectLink("not a url")).toBeNull();
  });
});
