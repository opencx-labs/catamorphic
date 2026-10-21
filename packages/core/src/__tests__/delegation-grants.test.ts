import { describe, expect, it } from "vitest";
import {
  type AgentDelegationPolicy,
  AgentDelegationPolicySchema,
} from "../services/agent-definitions-service.js";
import type { AgentModelChoice } from "../services/coding-agent-registry.js";
import {
  catalogEntry,
  catalogRefusal,
  childSettings,
  chooseGrant,
  DEFAULT_DELEGATION_POLICY,
  type DelegationRequest,
  delegationMenu,
  effortFits,
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

const catalog: AgentModelChoice[] = [
  {
    id: "opus",
    resolvedId: "claude-opus-5-5",
    supportedEffortLevels: ["low", "high", "max"],
  },
  { id: "sonnet", resolvedId: "claude-sonnet-5-5" },
  { id: "haiku", supportsEffort: false },
];
/** The names a model goes by, as session creation finds them. */
const modelNames = (model: string): string[] => {
  const entry = catalogEntry(catalog, model);
  return entry
    ? [entry.id, ...(entry.resolvedId ? [entry.resolvedId] : [])]
    : [model];
};

describe("delegation grants (ADR 0271)", () => {
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
    ).toEqual({ refusal: "You may not start agent reviewer." });
  });

  it("lets grants that name an agent decide before a wildcard, the first that takes the settings", () => {
    const grants = policy([
      { agent: "project:reviewer", model: ["sonnet"], effort: "fixed" },
      { agent: "project:reviewer", model: "any", delegate: false },
      { agent: "self", model: "fixed" },
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
    // `*` never lifts the limits set for an agent it names.
    expect(chooseGrant(grants, request({ model: "opus" }))).toEqual({
      refusal: "You may start a copy of yourself, but its model is fixed.",
    });
    expect(
      chooseGrant(grants, request({ targetAgentId: "builder" })),
    ).toMatchObject({ grant: { agent: "*" } });
    expect(
      chooseGrant(
        grants,
        request({
          targetAgentId: "builder",
          wildcardAdmits: false,
        }),
      ),
    ).toEqual({ refusal: "You may not start agent builder." });
    expect(
      chooseGrant(grants, request({ targetAgentId: "builder", model: "opus" })),
    ).toEqual({
      refusal: "You may start agent builder, but its model is fixed.",
    });
  });

  it("matches a listed model by any name its harness gives it, in any case", () => {
    const grants = policy([{ agent: "self", model: ["claude-sonnet-5-5"] }]);
    expect(
      chooseGrant(grants, request({ model: "sonnet", modelNames })),
    ).toMatchObject({ grant: { agent: "self" } });
    expect(
      chooseGrant(grants, request({ model: "Sonnet", modelNames })),
    ).toMatchObject({ grant: { agent: "self" } });
    expect(chooseGrant(grants, request({ model: "opus", modelNames }))).toEqual(
      {
        refusal:
          "You may start a copy of yourself, but its model is one of claude-sonnet-5-5.",
      },
    );
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
    // A parent on its harness's default runs at least low.
    expect(chooseGrant(grants, request({ effort: "low" }))).toMatchObject({
      grant: { agent: "self" },
    });
    expect(chooseGrant(grants, request({ effort: "medium" }))).toEqual({
      refusal:
        "You may start a copy of yourself, but this chat runs on its harness's default effort, so ask for low or leave effort out.",
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

  it("starts a copy on the parent chat's model and effort as a pair, and holds a child to its grant's lists", () => {
    const any = policy([{ agent: "self" }]).agents[0];
    if (!any) throw new Error("Expected a grant");
    const parent: { model: string; effort: "high" } = {
      model: "opus",
      effort: "high",
    };
    expect(
      childSettings({ grant: any, copy: true, requested: {}, parent, own: {} }),
    ).toEqual({ model: "opus", effort: "high" });
    // A new model drops the effort chosen for the old one.
    expect(
      childSettings({
        grant: any,
        copy: true,
        requested: { model: "haiku" },
        parent,
        own: {},
      }),
    ).toEqual({ model: "haiku" });
    // Another agent starts on its own.
    expect(
      childSettings({
        grant: any,
        copy: false,
        requested: {},
        parent,
        own: {},
      }),
    ).toEqual({});
    const listed = policy([
      { agent: "self", model: ["claude-sonnet-5-5"], effort: ["low"] },
    ]).agents[0];
    if (!listed) throw new Error("Expected a grant");
    expect(
      childSettings({
        grant: listed,
        copy: true,
        requested: {},
        parent,
        own: {},
        modelNames,
      }),
    ).toEqual({ model: "claude-sonnet-5-5", effort: "low" });
    expect(
      childSettings({
        grant: listed,
        copy: true,
        requested: {},
        parent: { model: "sonnet", effort: "low" },
        own: {},
        modelNames,
      }),
    ).toEqual({ model: "sonnet", effort: "low" });
    // Another agent's own listed default stands; an unlisted one gives way.
    const reviewer = policy([
      { agent: "reviewer", model: ["sonnet", "opus"], effort: ["high", "max"] },
    ]).agents[0];
    if (!reviewer) throw new Error("Expected a grant");
    expect(
      childSettings({
        grant: reviewer,
        copy: false,
        requested: {},
        parent,
        own: { model: "opus", effort: "max" },
        modelNames,
      }),
    ).toEqual({});
    expect(
      childSettings({
        grant: reviewer,
        copy: false,
        requested: {},
        parent,
        own: { model: "haiku", effort: "low" },
        modelNames,
      }),
    ).toEqual({ model: "sonnet", effort: "high" });
  });

  it("holds what a child runs on to the parent's effort, not only what is asked", () => {
    const capped = policy([{ agent: "*", effort: "at-most-parent" }]).agents[0];
    if (!capped) throw new Error("Expected a grant");
    // Another agent whose own effort is max, beside a parent at low.
    expect(
      childSettings({
        grant: capped,
        copy: false,
        requested: {},
        parent: { model: "opus", effort: "low" },
        parentEffort: "low",
        own: { effort: "max" },
      }),
    ).toEqual({ effort: "low" });
    // A copy on a new model, whose agent default is above the parent's.
    expect(
      childSettings({
        grant: capped,
        copy: true,
        requested: { model: "sonnet" },
        parent: { model: "opus", effort: "medium" },
        parentEffort: "medium",
        own: { effort: "xhigh" },
      }),
    ).toEqual({ model: "sonnet", effort: "medium" });
    // At or under the parent's, nothing changes.
    expect(
      childSettings({
        grant: capped,
        copy: false,
        requested: {},
        parent: {},
        parentEffort: "high",
        own: { effort: "low" },
      }),
    ).toEqual({});
  });

  it("refuses a definition that still names routes", () => {
    expect(() =>
      AgentDelegationPolicySchema.parse({
        routes: [{ id: "same-agent", target: "self" }],
      }),
    ).toThrow("delegation.routes was replaced by delegation.agents (ADR 0271)");
  });

  it("checks a model and effort against the harness's own catalog", () => {
    const harness = "your harness";
    expect(
      catalogRefusal({
        catalog,
        harness,
        model: "claude-opus-5-5",
        runningModel: "claude-opus-5-5",
        effort: "max",
      }),
    ).toBeNull();
    expect(catalogRefusal({ catalog, harness, model: "Opus" })).toBeNull();
    expect(
      catalogRefusal({
        catalog,
        harness: "the harness of codex",
        model: "gpt-5",
      }),
    ).toBe(
      "gpt-5 is not a model the harness of codex offers. It offers: opus, sonnet, haiku",
    );
    expect(
      catalogRefusal({
        catalog,
        harness,
        runningModel: "haiku",
        effort: "high",
      }),
    ).toBe("haiku takes no effort setting");
    expect(
      catalogRefusal({
        catalog,
        harness,
        runningModel: "opus",
        effort: "medium",
      }),
    ).toBe("opus takes effort low, high, max");
    // A model the catalog does not know is the harness's to judge.
    expect(
      catalogRefusal({
        catalog,
        harness,
        runningModel: "unlisted",
        effort: "medium",
      }),
    ).toBeNull();
    expect(
      catalogRefusal({ catalog: [], harness, model: "anything" }),
    ).toBeNull();
    expect(effortFits({ catalog, model: "haiku", effort: "low" })).toBe(false);
    expect(effortFits({ catalog, model: undefined, effort: "low" })).toBe(true);
  });

  it("tells the agent whom it may start and what it may set, without an id for itself", () => {
    const menu = delegationMenu({
      policy: policy([
        { agent: "self", model: "fixed" },
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
      "- A copy of yourself (leave agent out): this chat's model, any effort (low, medium, high, xhigh, max)",
      `- Agent project:${projectId}:reviewer (Reviewer): model sonnet, effort no higher than this chat's, and it cannot start subsessions. Reviews security.`,
      "- Any of: writer (Writer), plain: its own model, effort low",
    ]);
    expect(
      delegationMenu({
        policy: policy([{ agent: "*" }]),
        projectId,
        wildcardAgents: [],
        nameOf: () => undefined,
      }),
    ).toEqual([
      "- Any of: no agents right now: any model its harness offers, any effort (low, medium, high, xhigh, max)",
    ]);
  });
});
