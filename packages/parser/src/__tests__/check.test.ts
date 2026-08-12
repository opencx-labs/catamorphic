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
    "workflows/src/orders.ts": WORKFLOW,
    "workflows/src/app-api.ts": APP_API,
    "apps/dashboard/package.json": APP_MANIFEST,
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
      "workflows/src/bad.ts": `
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
