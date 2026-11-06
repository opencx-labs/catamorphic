import { describe, expect, it } from "vitest";
import {
  clientAddress,
  isPrivateAddress,
  trustedProxies,
} from "./client-address.js";

describe("clientAddress", () => {
  const behindBalancer = trustedProxies(["10.0.0.0/8", "fd00::/8"]);

  it("is the connection's peer when no proxy is trusted", () => {
    const none = trustedProxies([]);
    expect(
      clientAddress({
        peer: "203.0.113.7",
        forwardedFor: undefined,
        trusted: none,
      }),
    ).toBe("203.0.113.7");
    // A client's own header never changes whose limits it spends.
    expect(
      clientAddress({
        peer: "203.0.113.7",
        forwardedFor: "198.51.100.1",
        trusted: none,
      }),
    ).toBe("203.0.113.7");
  });

  it("walks x-forwarded-for from the nearest hop to the first untrusted one", () => {
    // The client sent its own entry; the balancer appended the real one.
    expect(
      clientAddress({
        peer: "10.0.0.5",
        forwardedFor: "198.51.100.1, 203.0.113.7",
        trusted: behindBalancer,
      }),
    ).toBe("203.0.113.7");
    // A CDN in front of the ingress: two trusted hops, then the client.
    expect(
      clientAddress({
        peer: "::ffff:10.0.0.5",
        forwardedFor: ["198.51.100.1, 203.0.113.7", "10.2.3.4"],
        trusted: behindBalancer,
      }),
    ).toBe("203.0.113.7");
    expect(
      clientAddress({
        peer: "fd12::1",
        forwardedFor: "[2001:db8::7]:4431",
        trusted: behindBalancer,
      }),
    ).toBe("2001:db8::7");
  });

  it("believes forwarded entries only from trusted peers", () => {
    expect(
      clientAddress({
        peer: "203.0.113.9",
        forwardedFor: "198.51.100.1, 10.0.0.5",
        trusted: behindBalancer,
      }),
    ).toBe("203.0.113.9");
  });

  it("stops at the last vouched-for hop when a proxy wrote garbage", () => {
    expect(
      clientAddress({
        peer: "10.0.0.5",
        forwardedFor: "unknown",
        trusted: behindBalancer,
      }),
    ).toBe("10.0.0.5");
    expect(
      clientAddress({
        peer: undefined,
        forwardedFor: "203.0.113.7",
        trusted: behindBalancer,
      }),
    ).toBeUndefined();
  });
});

describe("isPrivateAddress", () => {
  it("recognizes where a proxy in front of the server connects from", () => {
    for (const address of [
      "10.1.2.3",
      "172.20.0.4",
      "192.168.1.1",
      "127.0.0.1",
      "::1",
      "::ffff:10.0.0.5",
      "fd12::1",
    ]) {
      expect(isPrivateAddress(address)).toBe(true);
    }
    for (const address of [
      "203.0.113.7",
      "2001:db8::7",
      "unknown",
      undefined,
    ]) {
      expect(isPrivateAddress(address)).toBe(false);
    }
  });
});

describe("trustedProxies", () => {
  it("accepts addresses and CIDR ranges and rejects anything else", () => {
    expect(() =>
      trustedProxies(["10.0.0.0/8", "192.168.1.10", "fd00::/8", "::1"]),
    ).not.toThrow();
    for (const entry of [
      "10.0.0.0/33",
      "10.0.0.0/x",
      "proxy.internal",
      "10.0.0.0/8/1",
      "",
    ]) {
      expect(() => trustedProxies([entry])).toThrow("CIDR");
    }
  });
});
