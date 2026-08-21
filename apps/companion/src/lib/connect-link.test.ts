import { describe, expect, it } from "vitest";
import { connectLinkFromParams, parseConnectLink } from "./connect-link.js";

const BASE =
  "server=https%3A%2F%2Fbrain.acme.dev%2Fapi&token=t0k&project=p-1&name=Acme%20Brain";

describe("parseConnectLink", () => {
  it("parses the catamorphic:// scheme", () => {
    const link = parseConnectLink(`catamorphic://connect?${BASE}`);
    expect(link).toEqual({
      serverUrl: "https://brain.acme.dev/api",
      token: "t0k",
      remoteProjectId: "p-1",
      remoteProjectName: "Acme Brain",
    });
  });

  it("parses an https invite URL carrying the same params", () => {
    const link = parseConnectLink(`https://companion.acme.dev/?${BASE}`);
    expect(link?.serverUrl).toBe("https://brain.acme.dev/api");
    expect(link?.token).toBe("t0k");
  });

  it("keeps only http(s) renew URLs", () => {
    const good = parseConnectLink(
      `catamorphic://connect?${BASE}&renew=https%3A%2F%2Facme.dev%2Frenew`,
    );
    expect(good?.renewUrl).toBe("https://acme.dev/renew");
    const bad = parseConnectLink(
      `catamorphic://connect?${BASE}&renew=javascript%3Aalert(1)`,
    );
    expect(bad?.renewUrl).toBeUndefined();
  });

  it("rejects missing fields, bad server schemes, and garbage", () => {
    expect(parseConnectLink("catamorphic://connect?server=x")).toBeNull();
    expect(
      parseConnectLink(
        "catamorphic://connect?server=ftp%3A%2F%2Fx&token=t&project=p",
      ),
    ).toBeNull();
    expect(parseConnectLink("not a link")).toBeNull();
  });

  it("strips trailing slashes from the server URL", () => {
    const link = connectLinkFromParams(
      new URLSearchParams({
        server: "https://brain.acme.dev/api///",
        token: "t",
        project: "p",
      }),
    );
    expect(link?.serverUrl).toBe("https://brain.acme.dev/api");
  });
});
