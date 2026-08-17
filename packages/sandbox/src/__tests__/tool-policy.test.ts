import { describe, expect, it } from "vitest";
import {
  resolveToolPermission,
  resolveToolPermissionAcross,
  stricterPermission,
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
