import { parseProject } from "@catamorphic/parser";
import { describe, expect, it } from "vitest";
import { findTemplate } from "../templates.js";

describe("orders dashboard template", () => {
  it("parses workflows and resolves the app contract surface", () => {
    const template = findTemplate("orders-dashboard");
    if (!template) throw new Error("orders-dashboard template is missing");

    const parsed = parseProject(template.files);

    expect(parsed.errors).toEqual([]);
    expect(
      parsed.workflows.map((workflow) => workflow.functionName).sort(),
    ).toEqual(["listOpenOrders", "markOrderShipped"]);
    // The app-api surface resolves to exactly the exported workflows.
    expect(
      parsed.appApi?.entries.map((entry) => entry.workflowName).sort(),
    ).toEqual(["listOpenOrders", "markOrderShipped"]);
    // Workflows are defineWorkflow definitions; the contract is Workflow<T>
    // and the app invokes through the client's .call() method.
    expect(template.files["workflows/src/orders.ts"]).toContain(
      "defineWorkflow",
    );
    expect(template.files["workflows/src/orders.ts"]).not.toContain(
      '"use workflow"',
    );
    expect(template.files["contracts/src/index.ts"]).toContain(
      "Workflow<ListOpenOrders>",
    );
    expect(template.files["apps/dashboard/src/app.tsx"]).toContain(
      ".call({ limit: 20 })",
    );
    // App sources are present in the template but excluded from parsing.
    expect(template.files["apps/dashboard/src/app.tsx"]).toBeDefined();
    expect(
      parsed.workflows.every(
        (workflow) => !workflow.filePath.startsWith("apps/"),
      ),
    ).toBe(true);
  });

  it("ships the workspace and app scaffolding", () => {
    const template = findTemplate("orders-dashboard");
    if (!template) throw new Error("orders-dashboard template is missing");

    const root = JSON.parse(template.files["package.json"] ?? "{}");
    expect(root.workspaces).toEqual(["contracts", "workflows", "apps/*"]);
    expect(template.files["apps/dashboard/vite.config.ts"]).toContain("iife");
    expect(template.files["apps/dashboard/package.json"]).toBeDefined();
    expect(template.files[".agents/skills/building-apps/SKILL.md"]).toContain(
      "app-api.ts",
    );
    // The app must not depend on the workflows package.
    const appPkg = JSON.parse(
      template.files["apps/dashboard/package.json"] ?? "{}",
    );
    expect(JSON.stringify(appPkg)).not.toContain("@project/workflows");
  });
});
