import { describe, expect, it } from "vitest";
import { parseConnectLink } from "./connect-link.js";

describe("connect links (ADR 0055)", () => {
  it("parses catamorphic://connect with server, token, project, optional name", () => {
    expect(
      parseConnectLink(
        "catamorphic://connect?server=https%3A%2F%2Fbrain.acme.com%2Fapi%2F&token=t0k&project=p-1&name=Acme%20brain",
      ),
    ).toEqual({
      serverUrl: "https://brain.acme.com/api",
      token: "t0k",
      remoteProjectId: "p-1",
      remoteProjectName: "Acme brain",
    });
  });

  it("rejects anything else", () => {
    expect(
      parseConnectLink(
        "https://example.com/connect?server=x&token=y&project=z",
      ),
    ).toBeNull();
    expect(
      parseConnectLink("catamorphic://open?server=x&token=y&project=z"),
    ).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=ftp://x&token=y&project=z",
      ),
    ).toBeNull();
    expect(
      parseConnectLink("catamorphic://connect?server=https://x&project=z"),
    ).toBeNull();
    expect(parseConnectLink("not a url")).toBeNull();
  });
});
