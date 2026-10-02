import { describe, expect, it } from "vitest";
import {
  machineSignInHome,
  parseSandboxPaths,
  parseSignInCapability,
  refuseSignIns,
  remapPaths,
  signInMemberOf,
} from "../sign-ins.js";
import { signInCapability } from "../types.js";

describe("sign-ins stay on the machine (ADR 0199)", () => {
  it("keeps one home per harness and member, any id one path segment", () => {
    expect(
      machineSignInHome({
        root: "/data/sign-ins",
        harness: "codex",
        member: "a/b",
      }),
    ).toBe("/data/sign-ins/codex/a%2Fb");
    expect(signInMemberOf("a%2Fb")).toBe("a/b");
    expect(signInMemberOf("not%2")).toBeUndefined();
    expect(() =>
      machineSignInHome({ root: "/data", harness: "codex", member: ".." }),
    ).toThrow("is not a member id");
  });

  it("reads back the capability a machine reports", () => {
    const capability = signInCapability({
      harness: "claude-code",
      member: "user:1",
    });
    expect(parseSignInCapability(capability)).toEqual({
      harness: "claude-code",
      member: "user:1",
    });
    expect(parseSignInCapability("sign-in:emacs:me")).toBeUndefined();
  });

  it("cloud sandboxes refuse to be handed one", () => {
    expect(() =>
      refuseSignIns({
        signIns: [{ harness: "codex", member: "me" }],
        provider: "Cloudflare",
      }),
    ).toThrow("Cloudflare sandboxes cannot run on a member's own sign-in");
    expect(() => refuseSignIns({ provider: "Cloudflare" })).not.toThrow();
  });

  it("maps a process sandbox's virtual paths both ways, and only paths", () => {
    const paths = parseSandboxPaths(
      JSON.stringify({ virtual: "/workspace", real: "/data/sb/1/workspace" }),
    );
    expect(paths).toEqual({
      virtual: "/workspace",
      real: "/data/sb/1/workspace",
    });
    expect(parseSandboxPaths("{}")).toBeUndefined();
    const start = {
      workingDirectory: "/workspace/project",
      modelAccess: { kind: "sign_in", home: "/workspace/.work-sign-in/codex" },
      systemPrompt: "Edit files in /workspace/project",
      other: "/workspaces",
      list: ["/workspace"],
    };
    const real = remapPaths(start, "/workspace", "/data/sb/1/workspace");
    expect(real).toEqual({
      workingDirectory: "/data/sb/1/workspace/project",
      modelAccess: {
        kind: "sign_in",
        home: "/data/sb/1/workspace/.work-sign-in/codex",
      },
      systemPrompt: "Edit files in /workspace/project",
      other: "/workspaces",
      list: ["/data/sb/1/workspace"],
    });
    expect(remapPaths(real, "/data/sb/1/workspace", "/workspace")).toEqual(
      start,
    );
  });
});
