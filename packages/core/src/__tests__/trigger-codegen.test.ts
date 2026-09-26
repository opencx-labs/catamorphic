import { describe, expect, it } from "vitest";
import { renderTriggerTypesModule } from "../services/trigger-codegen.js";
import type { TriggerKindRuntime } from "../services/trigger-kinds.js";

function kind(
  partial: Pick<TriggerKindRuntime, "name"> & Partial<TriggerKindRuntime>,
): TriggerKindRuntime {
  return {
    payloadJsonSchema: { type: "object", properties: {} },
    configJsonSchema: { type: "object", properties: {} },
    validatePayload: () => ({ ok: true }),
    validateConfig: () => ({ ok: true }),
    ...partial,
  };
}

describe("trigger types codegen", () => {
  it("renders a module augmentation for @catamorphic/workflow", () => {
    const content = renderTriggerTypesModule({
      kinds: [
        kind({
          name: "ticket.created",
          description: "A ticket was created",
          payloadJsonSchema: {
            type: "object",
            properties: {
              ticketId: { type: "string" },
              priority: { enum: ["low", "high"] },
              tags: { type: "array", items: { type: "string" } },
              score: { type: "number" },
            },
            required: ["ticketId", "priority"],
          },
          configJsonSchema: {
            type: "object",
            properties: { onlyPriority: { enum: ["low", "high"] } },
          },
        }),
      ],
    });

    expect(content).toContain('declare module "@catamorphic/workflow"');
    expect(content).toContain("interface TriggerKinds");
    expect(content).toContain('"ticket.created"');
    expect(content).toContain("/** A ticket was created */");
    expect(content).toContain("ticketId: string;");
    expect(content).toContain('priority: "low" | "high";');
    expect(content).toContain("tags?: Array<string>;");
    expect(content).toContain("score?: number;");
    expect(content).toContain('onlyPriority?: "low" | "high";');
  });

  it("sorts kinds by name and degrades unknown schemas to wide types", () => {
    const content = renderTriggerTypesModule({
      kinds: [
        kind({
          name: "zzz.last",
          payloadJsonSchema: { not: { type: "string" } },
        }),
        kind({ name: "aaa.first" }),
      ],
    });
    expect(content.indexOf('"aaa.first"')).toBeLessThan(
      content.indexOf('"zzz.last"'),
    );
    expect(content).toContain("null | boolean | number | string");
  });

  it("renders holes as Hole<Name> and imports the brand only when used", () => {
    const content = renderTriggerTypesModule({
      kinds: [
        kind({
          name: "ai.tool-call",
          payloadJsonSchema: { "x-catamorphic-hole": "Args" },
          configJsonSchema: {
            type: "object",
            properties: { description: { type: "string" } },
            required: ["description"],
          },
        }),
        kind({
          name: "http.request",
          payloadJsonSchema: {
            type: "object",
            properties: {
              method: { type: "string" },
              body: { "x-catamorphic-hole": "Body" },
            },
            required: ["method", "body"],
          },
          outputJsonSchema: {
            type: "object",
            properties: {
              status: { type: "number" },
              body: { "x-catamorphic-hole": "Response" },
            },
            required: ["status", "body"],
          },
        }),
      ],
    });
    expect(content).toContain(
      'import type { Hole } from "@catamorphic/workflow";',
    );
    expect(content).toContain('payload: Hole<"Args">;');
    expect(content).toContain('body: Hole<"Body">;');
    expect(content).toContain("output: {");
    expect(content).toContain('body: Hole<"Response">;');
  });

  it("omits the Hole import and output member for plain kinds", () => {
    const content = renderTriggerTypesModule({
      kinds: [kind({ name: "plain.kind" })],
    });
    expect(content).not.toContain("import type { Hole }");
    expect(content).not.toContain("output:");
  });

  it("quotes non-identifier property keys", () => {
    const content = renderTriggerTypesModule({
      kinds: [
        kind({
          name: "odd.keys",
          configJsonSchema: {
            type: "object",
            properties: { "x-header": { type: "string" } },
            required: ["x-header"],
          },
        }),
      ],
    });
    expect(content).toContain('"x-header": string;');
  });

  it("types project kinds from their trigger modules", () => {
    const range = {
      start: 0,
      end: 0,
      startLine: 1,
      startColumn: 1,
      endLine: 1,
      endColumn: 1,
    };
    const content = renderTriggerTypesModule({
      kinds: [
        kind({ name: "webhook" }),
        kind({
          name: "http.request",
          outputJsonSchema: {
            type: "object",
            properties: { status: { type: "number" } },
            required: ["status"],
          },
        }),
      ],
      projectKinds: [
        {
          name: "gh.pull_request",
          description: "A pull request changed",
          exportName: "pullRequest",
          filePath: ".work/triggers/github.ts",
          from: { kind: "webhook", config: { name: "github" } },
          sourceRange: range,
        },
        {
          name: "api.orders",
          exportName: "orders",
          filePath: ".work/triggers/api/orders.ts",
          from: { kind: "http.request", config: {} },
          sourceRange: range,
        },
      ],
    });
    expect(content).toContain(
      'import type { PayloadOf } from "@catamorphic/workflow";',
    );
    expect(content).toContain(
      [
        "    /** A pull request changed */",
        '    "gh.pull_request": {',
        '      payload: PayloadOf<typeof import("../../triggers/github").pullRequest>;',
        "      config: Record<string, never>;",
        "    };",
      ].join("\n"),
    );
    // A project kind demands the output its host kind demands.
    expect(content).toContain(
      [
        '    "api.orders": {',
        '      payload: PayloadOf<typeof import("../../triggers/api/orders").orders>;',
        "      config: Record<string, never>;",
        "      output: {",
      ].join("\n"),
    );
  });
});
