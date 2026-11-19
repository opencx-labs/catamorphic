import path from "node:path";
import { projectPrincipalIdentity } from "@catamorphic/core";
import { parseProject } from "@catamorphic/parser";

/**
 * For pack tests: what a shipped workflow's runs reach of the project
 * store once it is turned on for the project (ADR 0335). Core builds the
 * project principal from the workflow's parsed `documents`, and the
 * returned source checks each store call with core's own `scopeCovers`,
 * so a fake host refuses exactly what Work refuses ("Not authorized").
 */
export function projectStoreCheck(input: {
  files: Readonly<Record<string, string>>;
  workflowName: string;
}): string {
  const parsed = parseProject({ ...input.files });
  const workflow = parsed.workflows.find(
    (candidate) => candidate.functionName === input.workflowName,
  );
  if (!workflow) throw new Error(`Missing workflow ${input.workflowName}`);
  const projectId = "project-1";
  const principal = projectPrincipalIdentity({
    tenantId: "tenant-1",
    projectId,
    environment: "default",
    workflowName: input.workflowName,
    permissions: workflow.graph.permissions,
    documents: workflow.graph.documents,
  });
  const identityModule = path.resolve(
    import.meta.dirname,
    "../../core/src/identity.ts",
  );
  return `
      import { scopeCovers } from ${JSON.stringify(identityModule)};
      const STORE_SCOPE = ${JSON.stringify(principal.scope ?? [])};
      /** Whether Work lets the project automation reach a store path. */
      const mayReach = (path, access) =>
        scopeCovers(STORE_SCOPE, { kind: "document", projectId: ${JSON.stringify(projectId)}, path, access });
      const authorize = (path, access) => {
        if (!mayReach(path, access)) throw new Error("Not authorized");
      };
  `;
}
