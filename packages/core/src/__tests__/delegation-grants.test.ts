import { describe, expect, it } from "vitest";
import {
  type AgentDelegationPolicy,
  AgentDelegationPolicySchema,
} from "../services/agent-definitions-service.js";
import {
  catalogRefusal,
  chooseGrant,
  DEFAULT_DELEGATION_POLICY,
  type DelegationRequest,
  delegationMenu,
} from "../services/delegation-grants.js";

const projectId = "11111111-1111-4111-8111-111111111111";

const request = (
  overrides: Partial<DelegationRequest> = {},
): DelegationRequest => ({
  targetAgentId: "worker",
  sourceAgentId: "worker",
  projectId,
  wildcardAdmits: true,
  ...overrides,
});

const policy = (agents: unknown[]): AgentDelegationPolicy =>
  AgentDelegationPolicySchema.parse({ agents });

describe("delegation grants (ADR 0270)", () => {
  it("lets an agent start copies of itself on any model and effort by default", () => {
    expect(
      chooseGrant(
        DEFAULT_DELEGATION_POLICY,
        request({ model: "opus", effort: "max" }),
      ),
    ).toEqual({
      grant: { agent: "self", model: "any", effort: "any", delegate: true },
    });
    expect(AgentDelegationPolicySchema.parse({})).toEqual(
      DEFAULT_DELEGATION_POLICY,
    );
    expect(
      chooseGrant(
        DEFAULT_DELEGATION_POLICY,
        request({ targetAgentId: "reviewer" }),
      ),
    ).toEqual({
      refusal: "You may not start agent reviewer.",
    });
  });

  it("admits by exact agent, project slug or wildcard, and takes the first grant that allows the settings", () => {
    const grants = policy([
      { agent: "project:reviewer", model: ["sonnet"], effort: "fixed" },
      { agent: "project:reviewer", model: "any", delegate: false },
      { agent: "*", model: "fixed", effort: "fixed" },
    ]);
    const reviewer = `project:${projectId}:reviewer`;
    expect(
      chooseGrant(
        grants,
        request({ targetAgentId: reviewer, model: "sonnet" }),
      ),
    ).toMatchObject({ grant: { model: ["sonnet"] } });
    expect(
      chooseGrant(grants, request({ targetAgentId: reviewer, model: "opus" })),
    ).toMatchObject({ grant: { model: "any", delegate: false } });
    expect(
      chooseGrant(grants, request({ targetAgentId: "builder" })),
    ).toMatchObject({ grant: { agent: "*" } });
    expect(
      chooseGrant(
        grants,
        request({ targetAgentId: "builder", wildcardAdmits: false }),
      ),
    ).toEqual({ refusal: "You may not start agent builder." });
    expect(
      chooseGrant(grants, request({ targetAgentId: "builder", model: "opus" })),
    ).toEqual({
      refusal: "You may start agent builder, but its model is fixed.",
    });
  });

  it("holds effort to the parent's, a list, or nothing", () => {
    const grants = policy([{ agent: "self", effort: "at-most-parent" }]);
    expect(
      chooseGrant(grants, request({ effort: "medium", parentEffort: "high" })),
    ).toMatchObject({ grant: { effort: "at-most-parent" } });
    expect(
      chooseGrant(grants, request({ effort: "max", parentEffort: "high" })),
    ).toEqual({
      refusal:
        "You may start a copy of yourself, but its effort is at most this chat's, high.",
    });
    expect(chooseGrant(grants, request({ effort: "low" }))).toEqual({
      refusal:
        "You may start a copy of yourself, but its effort can be no higher than this chat's, which is the harness default.",
    });
    // Inheriting is no choice: a copy may always start.
    expect(chooseGrant(grants, request())).toMatchObject({
      grant: { agent: "self" },
    });
    expect(
      chooseGrant(
        policy([
          { agent: "self", effort: ["low", "medium"] },
          { agent: "self", effort: "fixed", model: ["haiku"] },
        ]),
        request({ effort: "high" }),
      ),
    ).toEqual({
      refusal:
        "You may start a copy of yourself, but its effort is one of low, medium; or its effort is fixed.",
    });
  });

  it("refuses a definition that still names routes", () => {
    expect(() =>
      AgentDelegationPolicySchema.parse({
        routes: [{ id: "same-agent", target: "self" }],
      }),
    ).toThrow("delegation.routes was replaced by delegation.agents (ADR 0270)");
  });

  it("checks a model and effort against the harness's own catalog", () => {
    const catalog = [
      {
        id: "opus",
        resolvedId: "claude-opus-5-5",
        supportedEffortLevels: ["low", "high", "max"] as const,
      },
      { id: "haiku", supportsEffort: false },
    ];
    expect(
      catalogRefusal({
        catalog,
        model: "claude-opus-5-5",
        runningModel: "claude-opus-5-5",
        effort: "max",
      }),
    ).toBeNull();
    expect(catalogRefusal({ catalog, model: "gpt-5" })).toBe(
      "gpt-5 is not a model its harness offers. It offers: opus, haiku",
    );
    expect(
      catalogRefusal({ catalog, runningModel: "haiku", effort: "high" }),
    ).toBe("haiku takes no effort setting");
    expect(
      catalogRefusal({ catalog, runningModel: "opus", effort: "medium" }),
    ).toBe("opus takes effort low, high, max");
    // A model the catalog does not know is the harness's to judge.
    expect(
      catalogRefusal({ catalog, runningModel: "sonnet", effort: "medium" }),
    ).toBeNull();
    expect(catalogRefusal({ catalog: [], model: "anything" })).toBeNull();
  });

  it("tells the agent whom it may start and what it may set, without an id to copy for itself", () => {
    const menu = delegationMenu({
      policy: policy([
        { agent: "self" },
        {
          agent: "project:reviewer",
          model: ["sonnet"],
          effort: "at-most-parent",
          delegate: false,
          description: "Reviews security.",
        },
        { agent: "*", model: "fixed", effort: ["low"] },
      ]),
      projectId,
      wildcardAgents: [{ id: "writer", name: "Writer" }, { id: "plain" }],
      nameOf: (id) => (id.endsWith(":reviewer") ? "Reviewer" : undefined),
    });
    expect(menu).toEqual([
      "- A copy of yourself (leave agent out): any model its harness offers, any effort (low, medium, high, xhigh, max)",
      `- Agent project:${projectId}:reviewer (Reviewer): model sonnet, effort no higher than this chat's, and it cannot start subsessions. Reviews security.`,
      "- Any of: writer (Writer), plain: its own model, effort low",
    ]);
  });
});
