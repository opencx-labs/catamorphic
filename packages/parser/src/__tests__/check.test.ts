import { describe, expect, it } from "vitest";
import {
  appApiTypesPath,
  checkProject,
  renderAppApiTypesModule,
} from "../index.js";

const WORKFLOW = `
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

export const listOrders = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ticket.created", { onlyPriority: "high" })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ limit: number }>) => ({
        orders: [] as string[],
      }),
    }),
  ],
}));
`;

const APP_API = `
import { listOrders } from "./orders.js";

export const appApi = { listOrders };
`;

const APP_MANIFEST = JSON.stringify({ name: "dashboard", private: true });

function projectFiles(extra: Record<string, string> = {}) {
  return {
    ".work/workflows/src/orders.ts": WORKFLOW,
    ".work/workflows/src/app-api.ts": APP_API,
    ".work/apps/dashboard/package.json": APP_MANIFEST,
    ...extra,
  };
}

describe("checkProject", () => {
  it("passes a healthy project with fresh generated types", () => {
    const base = checkProject(projectFiles());
    const freshTypes = base.generated[appApiTypesPath("dashboard")];
    expect(freshTypes).toContain("ProjectAppApi");

    const result = checkProject(
      projectFiles({ [appApiTypesPath("dashboard")]: freshTypes ?? "" }),
    );
    expect(result.findings).toEqual([]);
    expect(result.ok).toBe(true);
  });

  it("warns when generated app-api types are missing", () => {
    const result = checkProject(projectFiles());
    expect(result.ok).toBe(true);
    expect(result.findings).toMatchObject([
      { level: "warning", file: appApiTypesPath("dashboard") },
    ]);
  });

  it("fails on stale generated app-api types", () => {
    const result = checkProject(
      projectFiles({
        [appApiTypesPath("dashboard")]: "// stale contract\n",
      }),
    );
    expect(result.ok).toBe(false);
    expect(result.findings[0]).toMatchObject({
      level: "error",
      file: appApiTypesPath("dashboard"),
    });
    expect(result.findings[0]?.message).toContain("stale");
  });

  it("fails on parse errors, including non-constant trigger config", () => {
    const result = checkProject({
      ".work/workflows/src/bad.ts": `
const description = "computed";
export const bad = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<{ q: string }>) => ({ ok: true }),
    }),
  ],
}));
`,
    });
    expect(result.ok).toBe(false);
    expect(result.findings[0]?.message).toContain("constant");
  });

  it("validates trigger bindings against a host kind catalog", () => {
    const kinds = [
      {
        name: "ticket.created",
        configJsonSchema: {
          type: "object",
          properties: { onlyPriority: { enum: ["low", "high"] } },
        },
      },
    ];
    const healthy = checkProject(projectFiles(), { triggerKinds: kinds });
    expect(
      healthy.findings.filter((finding) => finding.level === "error"),
    ).toEqual([]);

    const unknownKind = checkProject(projectFiles(), { triggerKinds: [] });
    expect(unknownKind.ok).toBe(false);
    expect(unknownKind.findings[0]?.message).toContain(
      "unknown trigger kind 'ticket.created'",
    );

    const badConfig = checkProject(projectFiles(), {
      triggerKinds: [
        {
          name: "ticket.created",
          configJsonSchema: {
            type: "object",
            properties: { onlyPriority: { enum: ["never"] } },
          },
        },
      ],
    });
    expect(badConfig.ok).toBe(false);
    expect(badConfig.findings[0]?.message).toContain("onlyPriority");
  });

  it("refuses a binding whose kind needs permissions the workflow does not declare", () => {
    const onboarding = (permissions: string) => ({
      ".work/triggers/engineers.ts": `
import { defineTrigger, trigger } from "@catamorphic/workflow";
export const engineerJoined = defineTrigger({
  name: "engineer.joined",
  from: trigger("directory.member-joined", { groups: ["eng@example.com"] }),
});
`,
      ".work/workflows/src/onboard.ts": `
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";
export const onboard = defineWorkflow(({ defineBoundary }) => ({
  ${permissions}
  triggers: [trigger("directory.member-joined"), trigger("engineer.joined")],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));
`,
    });
    const kinds = [
      {
        name: "directory.member-joined",
        configJsonSchema: {
          type: "object",
          properties: { groups: { type: "array", items: { type: "string" } } },
        },
        requiredPermissions: ["memberships:read"],
      },
    ];
    const missing = checkProject(onboarding(""), { triggerKinds: kinds });
    expect(missing.ok).toBe(false);
    // Bound directly or through a project kind, the root kind decides.
    expect(missing.findings.map((finding) => finding.message)).toEqual([
      `Workflow 'onboard' trigger 'directory.member-joined': 'directory.member-joined' events need memberships:read: declare permissions: ["memberships:read"] in the workflow`,
      `Workflow 'onboard' trigger 'engineer.joined': 'directory.member-joined' events need memberships:read: declare permissions: ["memberships:read"] in the workflow`,
    ]);
    const declared = checkProject(
      onboarding(`permissions: ["memberships:read"],`),
      { triggerKinds: kinds },
    );
    expect(declared.findings).toEqual([]);
  });

  it("applies the host's webhook settings rules without a host", () => {
    const hook = (name: string, config: string) => `
export const ${name} = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("webhook", ${config})],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));
`;
    const result = checkProject({
      ".work/triggers/github.ts": `
import { defineTrigger, trigger } from "@catamorphic/workflow";
export const github = defineTrigger({
  name: "github",
  from: trigger("webhook", {
    name: "github",
    verify: { scheme: "hmac", secret: "GITHUB_SECRET", header: "x-hub-signature-256", prefix: "sha256=" },
  }),
});
`,
      ".work/workflows/src/hooks.ts": [
        `import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";`,
        hook(
          "placeholder",
          `{ name: "a", verify: { scheme: "hmac", secret: "S", header: "h", content: "{nope}" } }`,
        ),
        hook(
          "unsignedTimestamp",
          `{ name: "b", verify: { scheme: "hmac", secret: "S", header: "h", timestamp: { header: "t" } } }`,
        ),
        hook(
          "bothLocations",
          `{ name: "c", verify: { scheme: "token", secret: "S", header: "h", query: "q" } }`,
        ),
        hook(
          "badHandshake",
          `{ name: "d", respond: [{ when: { body: { type: { $exist: true } } }, echo: "body.challenge" }] }`,
        ),
        hook("viaKind", `{ name: "github" }`),
        `
export const viaProjectKind = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("github")],
  steps: [defineBoundary({ run: async ({ input }: BoundaryContext<{ id: string }>) => input })],
}));
`,
      ].join("\n"),
    });
    expect(result.ok).toBe(false);
    expect(result.findings.map((finding) => finding.message)).toEqual([
      "Workflow 'placeholder' trigger 'webhook': config.verify.content: Unknown placeholder {nope}; use {body}, {timestamp} or {header:<name>}",
      "Workflow 'unsignedTimestamp' trigger 'webhook': config.verify.timestamp: A timestamp only rejects replays when the signed content includes {timestamp}",
      "Workflow 'bothLocations' trigger 'webhook': config.verify: Name exactly one of header or query",
      "Workflow 'badHandshake' trigger 'webhook': config.respond.0.when: when.body.type.$exist is not an operator; use $exists or $prefix",
      "Workflows 'viaKind' and 'viaProjectKind' bind webhook 'github' with different settings (verify, respond, deliveryId, maxBodyBytes); declare the webhook once in a project trigger kind",
    ]);
  });

  it("validates template holes against the derived input schema", () => {
    const toolKind = {
      name: "ai.tool-call",
      configJsonSchema: {
        type: "object",
        properties: { description: { type: "string" } },
        required: ["description"],
      },
      payloadJsonSchema: { "x-catamorphic-hole": "Args" },
    };
    const files = (input: string) => ({
      ".work/workflows/src/tool.ts": `
import { type BoundaryContext, defineWorkflow, trigger } from "@catamorphic/workflow";

export const searchTool = defineWorkflow(({ defineBoundary }) => ({
  triggers: [trigger("ai.tool-call", { description: "search" })],
  steps: [
    defineBoundary({
      run: async ({ input }: BoundaryContext<${input}>) => ({ ok: true }),
    }),
  ],
}));
`,
    });

    const healthy = checkProject(files("{ query: string }"), {
      triggerKinds: [toolKind],
    });
    expect(healthy.findings).toEqual([]);

    // `any` input degrades to a permissive schema: the hole would freeze
    // to nothing, so checking fails closed like the host's scan.
    const permissive = checkProject(files("any"), {
      triggerKinds: [toolKind],
    });
    expect(permissive.ok).toBe(false);
    expect(permissive.findings[0]?.message).toContain("hole 'Args'");
  });

  it("renders deterministic app-api types", () => {
    const parsedTwice = [
      checkProject(projectFiles()),
      checkProject(projectFiles()),
    ];
    expect(parsedTwice[0]?.generated).toEqual(parsedTwice[1]?.generated);
    const content = renderAppApiTypesModule([
      {
        exposedName: "listOrders",
        workflowName: "listOrders",
        capabilities: { batchProcessing: false, cancellation: false },
        inputSchema: {
          type: "object",
          properties: { limit: { type: "number" } },
          required: ["limit"],
        },
        outputSchema: {
          type: "object",
          properties: { orders: { type: "array", items: { type: "string" } } },
          required: ["orders"],
        },
      },
    ]);
    expect(content).toContain("listOrders: Workflow<{");
    expect(content).toContain("limit: number;");
    expect(content).toContain("orders: Array<string>;");
  });
});
