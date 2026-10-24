import { describe, expect, it } from "vitest";
import {
  DEFAULT_TRUSTED_HOSTS,
  hostTrusted,
  trustedHostEntry,
  webLinkHost,
} from "./trusted-hosts.js";

describe("trusted hosts (ADR 0277)", () => {
  it("trusts GitHub's own hosts by default, never the pages anyone hosts there", () => {
    const trusted = (url: string) =>
      hostTrusted(DEFAULT_TRUSTED_HOSTS, webLinkHost(url) ?? "");
    expect(trusted("https://github.com/acme/web/pull/4")).toBe(true);
    expect(trusted("https://docs.github.com/en")).toBe(true);
    expect(
      trusted("https://private-user-images.githubusercontent.com/1/a.png"),
    ).toBe(true);
    expect(trusted("https://en.wikipedia.org/wiki/Prompt_injection")).toBe(
      true,
    );
    expect(trusted("http://localhost:5173/")).toBe(true);
    expect(trusted("https://attacker.github.io/c.png?d=secret")).toBe(false);
    expect(trusted("https://github.com.attacker.example/")).toBe(false);
    expect(trusted("https://attacker.example/c.png?d=secret")).toBe(false);
  });

  it("matches a name exactly, and *.name only below it", () => {
    expect(hostTrusted(["docs.acme.com"], "docs.acme.com")).toBe(true);
    expect(hostTrusted(["docs.acme.com"], "evil.docs.acme.com")).toBe(false);
    expect(hostTrusted(["*.acme.dev"], "cdn.acme.dev")).toBe(true);
    expect(hostTrusted(["*.acme.dev"], "acme.dev")).toBe(false);
    expect(hostTrusted(["*.acme.dev"], "notacme.dev")).toBe(false);
  });

  it("keeps entries as hosts, without schemes or ports", () => {
    expect(trustedHostEntry(" Docs.Acme.com ")).toBe("docs.acme.com");
    expect(trustedHostEntry("*.acme.dev")).toBe("*.acme.dev");
    expect(trustedHostEntry("localhost:3000")).toBe("localhost");
    expect(trustedHostEntry("https://acme.com")).toBeNull();
    expect(trustedHostEntry("*")).toBeNull();
  });

  it("reads only web addresses as links to a host", () => {
    expect(webLinkHost("https://Acme.com/x")).toBe("acme.com");
    expect(webLinkHost("file:notes.md")).toBeNull();
    expect(webLinkHost("workflow:deploy")).toBeNull();
    expect(webLinkHost("not a url")).toBeNull();
  });
});
