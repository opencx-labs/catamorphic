const WORKFLOW_STARTER_TEMPLATE = `import {
  type BoundaryContext,
  defineWorkflow,
} from "@catamorphic/workflow";

/**
 * @displayname __DISPLAY_NAME__
 * @description A new workflow
 */
export const __WORKFLOW_NAME__ = defineWorkflow(({ defineBoundary }) => ({
  steps: [
    defineBoundary({
      run: async (_context: BoundaryContext<Record<string, never>>) => {
        return { success: true };
      },
    }),
  ],
}));
`;

export function workflowFilePathFromName(workflowName: string): string {
  const fileSafe = workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
    .replace(/[^a-zA-Z0-9-]/g, "-")
    .toLowerCase();
  return `src/${fileSafe}.ts`;
}

export function buildUntitledWorkflowName(
  existingWorkflowNames: Set<string>,
): string {
  const baseName = "untitledWorkflow";
  if (!existingWorkflowNames.has(baseName)) return baseName;

  let suffix = 2;
  while (existingWorkflowNames.has(`${baseName}${suffix}`)) {
    suffix += 1;
  }
  return `${baseName}${suffix}`;
}

export function displayNameFromWorkflowName(workflowName: string): string {
  return workflowName
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .replace(/^./, (char) => char.toUpperCase());
}

export function starterCodeForWorkflow(
  workflowName: string,
  displayName: string,
): string {
  return WORKFLOW_STARTER_TEMPLATE.replace(
    "__WORKFLOW_NAME__",
    workflowName,
  ).replace("__DISPLAY_NAME__", displayName);
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Ensures the primary exported `defineWorkflow` declaration matches the
 * project workflow identifier so routing and the sandbox harness resolve the
 * entry point.
 */
export function ensurePrimaryWorkflowExportName(
  source: string,
  workflowName: string,
): string {
  const expected = new RegExp(
    `export\\s+const\\s+${escapeRegExp(workflowName)}\\s*=\\s*defineWorkflow\\s*\\(`,
  );
  if (expected.test(source)) return source;
  return source.replace(
    /export\s+const\s+\w+\s*=\s*defineWorkflow\s*\(/,
    `export const ${workflowName} = defineWorkflow(`,
  );
}

export function readWorkflowDisplayName(
  source: string,
  workflowName: string,
): string | null {
  const escapedName = escapeRegExp(workflowName);
  const docAndDeclarationPattern = new RegExp(
    `\\/\\*\\*[\\s\\S]*?\\*\\/\\s*export\\s+const\\s+${escapedName}\\s*=\\s*defineWorkflow\\s*\\(`,
  );
  const match = source.match(docAndDeclarationPattern);
  if (!match) return null;

  const displayMatch = match[0].match(/@displayname\s+([^\n\r*]+)/);
  const displayName = displayMatch?.[1]?.trim() ?? "";
  return displayName.length > 0 ? displayName : null;
}

export function upsertWorkflowDisplayName(
  source: string,
  workflowName: string,
  displayName: string,
): string {
  const escapedName = escapeRegExp(workflowName);
  const declarationPattern = new RegExp(
    `(\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?(export\\s+const\\s+${escapedName}\\s*=\\s*defineWorkflow\\s*\\()`,
  );
  const match = source.match(declarationPattern);
  if (!match) return source;

  const existingDoc = match[1];
  const declaration = match[2];
  let nextDoc: string;

  if (existingDoc) {
    const trimmedDoc = existingDoc.replace(/\s*$/, "");
    if (/@displayname\s+([^\n\r*]+)/.test(trimmedDoc)) {
      nextDoc = `${trimmedDoc.replace(
        /@displayname\s+([^\n\r*]+)/,
        `@displayname ${displayName}`,
      )}\n`;
    } else {
      nextDoc = `${trimmedDoc.replace(/\*\/$/, ` * @displayname ${displayName}\n */`)}\n`;
    }
  } else {
    nextDoc = `/**\n * @displayname ${displayName}\n */\n`;
  }

  return source.replace(declarationPattern, `${nextDoc}${declaration}`);
}
