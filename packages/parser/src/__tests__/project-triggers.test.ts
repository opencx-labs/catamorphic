import { describe, expect, it } from "vitest";
import {
  checkProject,
  matchesAllWhere,
  matchesWhere,
  parseProject,
  resolveTriggerBinding,
  whereErrors,
} from "../index.js";

const GITHUB_TRIGGERS = `
import { defineTrigger, trigger } from "@catamorphic/workflow";

const verify = { scheme: "hmac", secret: "GITHUB_WEBHOOK_SECRET" };

export const pullRequest = defineTrigger<PullRequestDelivery>({
  name: "gh.pull_request",
  description: "A pull request was opened, updated, or closed",
  from: trigger("webhook", {
    name: "github",
    verify: {
      scheme: "hmac",
      secret: "GITHUB_WEBHOOK_SECRET",
      header: "x-hub-signature-256",
      prefix: "sha256=",
    },
  }),
  where: { payload: { headers: { "x-github-event": "pull_request" } } },
});

export const merged = defineTrigger({
  name: "gh.merged",
  from: trigger("gh.pull_request", {
    where: { payload: { body: { action: "closed" } } },
  }),
  where: { payload: { body: { pull_request: { merged: true } } } },
});
`;

const REVIEW_WORKFLOWS = `
import { defineWorkflow, trigger } from "@catamorphic/workflow";

export const onMerged = defineWorkflow(({ defineBoundary }) => ({
  triggers: [
    trigger("gh.merged", { where: { payload: { body: { repository: { name: ["work", "site"] } } } } }),
  ],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));

export const onSchedule = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("schedule", { cron: "0 8 * * *", timezone: "UTC", where: { activationId: { $exists: true } } })],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));
`;

const webhookKind = {
  name: "webhook",
  configJsonSchema: {
    type: "object",
    properties: { name: { type: "string" }, verify: { type: "object" } },
    required: ["name"],
    additionalProperties: false,
  },
};
const scheduleKind = { name: "schedule", configJsonSchema: {} };

describe("project trigger kinds", () => {
  it("reads kinds from .work/triggers and splits where from binding config", () => {
    const result = parseProject({
      ".work/triggers/github.ts": GITHUB_TRIGGERS,
      ".work/workflows/src/review.ts": REVIEW_WORKFLOWS,
    });
    expect(result.errors).toEqual([]);
    expect(
      result.triggerKinds.map(({ sourceRange: _, ...kind }) => kind),
    ).toEqual([
      {
        name: "gh.merged",
        exportName: "merged",
        filePath: ".work/triggers/github.ts",
        from: {
          kind: "gh.pull_request",
          config: {},
          where: { payload: { body: { action: "closed" } } },
        },
        where: { payload: { body: { pull_request: { merged: true } } } },
      },
      {
        name: "gh.pull_request",
        description: "A pull request was opened, updated, or closed",
        exportName: "pullRequest",
        filePath: ".work/triggers/github.ts",
        from: {
          kind: "webhook",
          config: {
            name: "github",
            verify: {
              scheme: "hmac",
              secret: "GITHUB_WEBHOOK_SECRET",
              header: "x-hub-signature-256",
              prefix: "sha256=",
            },
          },
        },
        where: { payload: { headers: { "x-github-event": "pull_request" } } },
      },
    ]);
    const schedule = result.workflows.find(
      (workflow) => workflow.functionName === "onSchedule",
    );
    expect(schedule?.graph.triggers[0]).toMatchObject({
      kind: "schedule",
      config: { cron: "0 8 * * *", timezone: "UTC" },
      where: { activationId: { $exists: true } },
    });
  });

  it("resolves a chain to the host kind with every filter", () => {
    const result = parseProject({
      ".work/triggers/github.ts": GITHUB_TRIGGERS,
      ".work/workflows/src/review.ts": REVIEW_WORKFLOWS,
    });
    const binding = result.workflows.find(
      (workflow) => workflow.functionName === "onMerged",
    )?.graph.triggers[0];
    if (!binding) throw new Error("missing binding");
    const resolved = resolveTriggerBinding({
      binding,
      projectKinds: result.triggerKinds,
    });
    expect(resolved).toEqual({
      ok: true,
      binding: {
        kind: "webhook",
        config: expect.objectContaining({ name: "github" }),
        projectKind: "gh.merged",
        where: [
          { payload: { body: { repository: { name: ["work", "site"] } } } },
          { payload: { body: { pull_request: { merged: true } } } },
          { payload: { body: { action: "closed" } } },
          { payload: { headers: { "x-github-event": "pull_request" } } },
        ],
      },
    });
    // Host kinds pass through untouched.
    expect(
      resolveTriggerBinding({
        binding: { kind: "schedule", config: { at: "x" } },
        projectKinds: result.triggerKinds,
      }),
    ).toEqual({
      ok: true,
      binding: { kind: "schedule", config: { at: "x" }, where: [] },
    });
  });

  it("reports cycles, duplicates, computed values and misplaced kinds", () => {
    const result = parseProject({
      ".work/triggers/loop.ts": `
import { defineTrigger, trigger } from "@catamorphic/workflow";
export const a = defineTrigger({ name: "loop.a", from: trigger("loop.b") });
export const b = defineTrigger({ name: "loop.b", from: trigger("loop.a") });
export const again = defineTrigger({ name: "loop.a", from: trigger("webhook", { name: "x" }) });
const event = "push";
export const computed = defineTrigger({ name: "computed", from: trigger("webhook", { name: "x" }), where: { payload: { body: { event } } } });
export const badLeaf = defineTrigger({ name: "bad.leaf", from: trigger("webhook", { name: "x" }), where: { payload: { body: [{ a: 1 }] } } });
const notExported = defineTrigger({ name: "hidden", from: trigger("webhook", { name: "x" }) });
`,
      ".work/workflows/src/misplaced.ts": `
import { defineTrigger, trigger } from "@catamorphic/workflow";
export const misplaced = defineTrigger({ name: "misplaced", from: trigger("webhook", { name: "x" }) });
`,
    });
    const messages = result.errors.map((error) => error.message);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Trigger kinds form a cycle: loop.a -> loop.b -> loop.a",
        "Trigger kinds form a cycle: loop.b -> loop.a -> loop.b",
        expect.stringContaining("Trigger kind 'loop.a' is defined twice"),
        expect.stringContaining("where.payload.body must use plain"),
        expect.stringContaining("where.payload.body lists values to match"),
        expect.stringContaining("must be exported"),
        expect.stringContaining("Define trigger kinds in .work/triggers/"),
      ]),
    );
  });

  it("rejects config besides where on a project kind binding", () => {
    expect(
      resolveTriggerBinding({
        binding: { kind: "gh.any", config: { name: "other" } },
        projectKinds: [
          {
            name: "gh.any",
            exportName: "any",
            filePath: ".work/triggers/github.ts",
            from: { kind: "webhook", config: { name: "github" } },
            sourceRange: {
              start: 0,
              end: 0,
              startLine: 1,
              startColumn: 1,
              endLine: 1,
              endColumn: 1,
            },
          },
        ],
      }),
    ).toEqual({
      ok: false,
      error:
        "Trigger kind 'gh.any' is defined by the project and takes only 'where'",
    });
  });

  it("checks project kinds against the host catalog", () => {
    const files = {
      ".work/triggers/github.ts": GITHUB_TRIGGERS,
      ".work/triggers/bad.ts": `
import { defineTrigger, trigger } from "@catamorphic/workflow";
export const shadow = defineTrigger({ name: "schedule", from: trigger("webhook", { name: "x" }) });
export const unknownRoot = defineTrigger({ name: "unknown.root", from: trigger("nope") });
export const badConfig = defineTrigger({ name: "bad.config", from: trigger("webhook", { nam: "x" }) });
`,
      ".work/workflows/src/review.ts": REVIEW_WORKFLOWS,
      ".work/workflows/src/unknown.ts": `
import { defineWorkflow, trigger } from "@catamorphic/workflow";
export const onUnknown = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("gh.pul_request")],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));
`,
    };
    // Without a catalog, only what the project alone decides is checked:
    // the project's own `schedule` kind takes no cron config.
    const shadowed =
      "Workflow 'onSchedule' trigger 'schedule': Trigger kind 'schedule' is defined by the project and takes only 'where'";
    expect(
      checkProject(files).findings.map((finding) => finding.message),
    ).toEqual([shadowed]);
    const result = checkProject(files, {
      triggerKinds: [webhookKind, scheduleKind],
    });
    const messages = result.findings.map((finding) => finding.message);
    expect(messages).toHaveLength(5);
    expect(messages).toEqual(
      expect.arrayContaining([
        "Trigger kind 'bad.config' from 'webhook': config.name: required",
        "Trigger kind 'schedule' is already a host kind; give the project's kind another name",
        "Trigger kind 'unknown.root' builds on unknown trigger kind 'nope' (host kinds: webhook, schedule)",
        shadowed,
        expect.stringContaining(
          "Workflow 'onUnknown' binds unknown trigger kind 'gh.pul_request'",
        ),
      ]),
    );
  });
});

describe("where filters", () => {
  const delivery = {
    kind: "webhook",
    payload: {
      name: "github",
      headers: { "x-github-event": "pull_request" },
      body: {
        action: "closed",
        number: 7,
        draft: null,
        pull_request: { merged: true, labels: ["a"] },
      },
    },
  };

  it("matches equality, one-of, exists and nesting", () => {
    expect(
      matchesWhere(
        {
          kind: "webhook",
          payload: {
            body: {
              action: ["opened", "closed"],
              number: 7,
              pull_request: { merged: true, labels: { $exists: true } },
              draft: { $exists: false },
              missing: { $exists: false },
            },
          },
        },
        delivery,
      ),
    ).toBe(true);
    expect(
      matchesWhere({ payload: { body: { action: "opened" } } }, delivery),
    ).toBe(false);
    expect(
      matchesWhere({ payload: { body: { number: ["7"] } } }, delivery),
    ).toBe(false);
    expect(
      matchesWhere(
        { payload: { body: { missing: { $exists: true } } } },
        delivery,
      ),
    ).toBe(false);
    expect(
      matchesWhere({ payload: { body: { action: { deeper: 1 } } } }, delivery),
    ).toBe(false);
    expect(matchesWhere({}, delivery)).toBe(true);
    expect(matchesWhere({ payload: { body: { action: [] } } }, delivery)).toBe(
      false,
    );
  });

  it("matches a string's prefix", () => {
    const chat = {
      payload: { session: { key: "slack:C1:1.2" }, detail: { status: 7 } },
    };
    expect(
      matchesWhere(
        { payload: { session: { key: { $prefix: "slack:" } } } },
        chat,
      ),
    ).toBe(true);
    expect(
      matchesWhere({ payload: { session: { key: { $prefix: "pr-" } } } }, chat),
    ).toBe(false);
    // Only strings have prefixes; an absent or null key never matches.
    expect(
      matchesWhere({ payload: { detail: { status: { $prefix: "7" } } } }, chat),
    ).toBe(false);
    expect(
      matchesWhere(
        { payload: { session: { key: { $prefix: "slack:" } } } },
        { payload: { session: { key: null } } },
      ),
    ).toBe(false);
    expect(
      matchesWhere(
        { payload: { body: { action: { $prefix: "clo" } } } },
        delivery,
      ),
    ).toBe(true);
  });

  it("matches header names case-insensitively", () => {
    expect(
      matchesWhere(
        { payload: { headers: { "X-GitHub-Event": "pull_request" } } },
        delivery,
      ),
    ).toBe(true);
    // Only header names: body keys stay exact.
    expect(
      matchesWhere({ payload: { body: { Action: "closed" } } }, delivery),
    ).toBe(false);
  });

  it("requires every filter in a chain", () => {
    expect(matchesAllWhere([], delivery)).toBe(true);
    expect(
      matchesAllWhere(
        [
          { payload: { body: { action: "closed" } } },
          { payload: { body: { pull_request: { merged: true } } } },
        ],
        delivery,
      ),
    ).toBe(true);
    expect(
      matchesAllWhere(
        [
          { payload: { body: { action: "closed" } } },
          { payload: { body: { pull_request: { merged: false } } } },
        ],
        delivery,
      ),
    ).toBe(false);
  });

  it("validates filter shapes", () => {
    expect(
      whereErrors({
        a: [1, "x", null, true],
        b: { $exists: false },
        c: { $prefix: "slack:" },
      }),
    ).toEqual([]);
    expect(whereErrors({ key: { $prefix: "" } })).toEqual([
      "where.key.$prefix must not be empty; leave the position out instead",
    ]);
    expect(whereErrors({ a: [{ b: 1 }] })).toEqual([
      "where.a lists values to match; each must be a string, number, boolean or null",
    ]);
    expect(whereErrors({ a: { $exist: true } })).toEqual([
      "where.a.$exist is not an operator; use $exists or $prefix",
    ]);
    expect(whereErrors({ a: { $exists: true, b: 1 } })).toEqual([
      "where.a must hold one operator alone, without other keys",
    ]);
    expect(whereErrors({ a: { $exists: "yes" } })).toEqual([
      "where.a.$exists must be true or false",
    ]);
    expect(whereErrors({ a: { $prefix: 4 } })).toEqual([
      "where.a.$prefix must be a string",
    ]);
  });

  it("matches payload fields named exists or prefix by equality", () => {
    const event = {
      payload: { body: { flag: { exists: true }, ref: { prefix: "v1" } } },
    };
    expect(
      whereErrors({ flag: { exists: true }, ref: { prefix: "" } }),
    ).toEqual([]);
    expect(
      matchesWhere(
        {
          payload: { body: { flag: { exists: true }, ref: { prefix: "v1" } } },
        },
        event,
      ),
    ).toBe(true);
    expect(
      matchesWhere({ payload: { body: { flag: { exists: false } } } }, event),
    ).toBe(false);
    // The field named `prefix` is compared, not treated as an operator.
    expect(
      matchesWhere({ payload: { body: { ref: { prefix: "v" } } } }, event),
    ).toBe(false);
    // A malformed operator fails closed instead of matching everything.
    expect(
      matchesWhere({ payload: { body: { flag: { $exist: true } } } }, event),
    ).toBe(false);
  });
});
