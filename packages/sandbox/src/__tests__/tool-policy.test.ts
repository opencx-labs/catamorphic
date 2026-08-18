import { describe, expect, it } from "vitest";
import {
  type McpToolPolicyLayers,
  resolveToolPermission,
  resolveToolPermissionAcross,
  stricterPermission,
  ToolGate,
} from "../coding-agent/tool-policy.js";

describe("tool policy", () => {
  it("auto allows read-only tools and asks about the rest", () => {
    expect(
      resolveToolPermission(undefined, "search", { readOnlyHint: true }),
    ).toBe("allow");
    expect(
      resolveToolPermission(undefined, "post", { readOnlyHint: false }),
    ).toBe("ask");
    expect(resolveToolPermission(undefined, "unknown")).toBe("ask");
    expect(
      resolveToolPermission({ default: "auto" }, "search", {
        readOnlyHint: true,
      }),
    ).toBe("allow");
  });

  it("explicit rules beat the default; explicit defaults beat auto", () => {
    expect(
      resolveToolPermission(
        { default: "allow", tools: { post: "deny" } },
        "post",
      ),
    ).toBe("deny");
    expect(
      resolveToolPermission({ default: "allow" }, "post", {
        readOnlyHint: false,
      }),
    ).toBe("allow");
    expect(
      resolveToolPermission({ default: "deny" }, "search", {
        readOnlyHint: true,
      }),
    ).toBe("deny");
  });

  it("layers intersect: the stricter answer wins", () => {
    expect(stricterPermission("allow", "ask")).toBe("ask");
    expect(stricterPermission("deny", "allow")).toBe("deny");
    const connection = {
      default: "allow" as const,
      tools: { post: "ask" as const },
    };
    const agent = { tools: { post: "allow" as const, del: "deny" as const } };
    // The agent can't lift the connection's "ask" on post…
    expect(resolveToolPermissionAcross([connection, agent], "post")).toBe(
      "ask",
    );
    // …but can narrow: del is denied by the agent, allowed by the connection.
    expect(resolveToolPermissionAcross([connection, agent], "del")).toBe(
      "deny",
    );
    // A tool neither names: the connection's allow, the agent's auto → strictest is annotation-based.
    expect(
      resolveToolPermissionAcross([connection, agent], "search", {
        readOnlyHint: true,
      }),
    ).toBe("allow");
    expect(
      resolveToolPermissionAcross([connection, agent], "write", {
        readOnlyHint: false,
      }),
    ).toBe("ask");
    expect(resolveToolPermissionAcross([], "x")).toBe("ask");
  });
});

describe("ToolGate (the shared allow / ask / deny decision)", () => {
  const layers: McpToolPolicyLayers = [
    { default: "allow", tools: { off: "deny", check: "ask" } },
  ];

  it("lets unpoliced servers and allowed tools through, refuses deny", async () => {
    const gate = new ToolGate();
    expect(
      await gate.decide({
        server: "s",
        tool: "x",
        input: {},
        layers: undefined,
      }),
    ).toEqual({ allowed: true });
    expect(
      await gate.decide({
        server: "s",
        tool: "fine",
        input: {},
        layers: [...layers],
      }),
    ).toEqual({ allowed: true });
    const denied = await gate.decide({
      server: "s",
      tool: "off",
      input: {},
      layers: [...layers],
    });
    expect(denied.allowed).toBe(false);
    if (!denied.allowed) expect(denied.message).toContain("turned off");
  });

  it("fails closed on ask with nobody to ask; auto follows annotations", async () => {
    const gate = new ToolGate();
    const asked = await gate.decide({
      server: "s",
      tool: "check",
      input: {},
      layers: [...layers],
    });
    expect(asked.allowed).toBe(false);
    const auto: McpToolPolicyLayers = [{ default: "auto" }];
    expect(
      await gate.decide({
        server: "s",
        tool: "read",
        input: {},
        layers: auto,
        annotations: { readOnlyHint: true },
      }),
    ).toEqual({ allowed: true });
    const write = await gate.decide({
      server: "s",
      tool: "write",
      input: {},
      layers: auto,
    });
    expect(write.allowed).toBe(false);
  });

  it("asks once and remembers 'always' — but a live deny still wins", async () => {
    const calls: string[] = [];
    const gate = new ToolGate(async (request) => {
      calls.push(request.tool);
      return { decision: "allow", remember: "always" };
    });
    const call = {
      server: "s",
      tool: "check",
      input: { a: 1 },
      layers: [...layers],
    };
    expect(await gate.decide(call)).toEqual({ allowed: true });
    expect(await gate.decide(call)).toEqual({ allowed: true });
    expect(calls).toEqual(["check"]);
    const denied = await gate.decide({
      ...call,
      layers: [...layers, { default: "allow", tools: { check: "deny" } }],
    });
    expect(denied.allowed).toBe(false);
  });

  it("a declined ask and an interrupted turn both refuse with a reason", async () => {
    const declined = new ToolGate(async () => ({ decision: "deny" }));
    const no = await declined.decide({
      server: "s",
      tool: "check",
      input: {},
      layers: [...layers],
    });
    expect(no.allowed).toBe(false);
    if (!no.allowed) expect(no.message).toContain("declined");

    const parked = new ToolGate(() => new Promise(() => {}));
    const controller = new AbortController();
    const pending = parked.decide({
      server: "s",
      tool: "check",
      input: {},
      layers: [...layers],
      abortSignal: controller.signal,
    });
    controller.abort();
    const verdict = await pending;
    expect(verdict.allowed).toBe(false);
    if (!verdict.allowed) expect(verdict.message).toContain("interrupted");
  });
});
