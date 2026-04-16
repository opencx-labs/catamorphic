const WORKFLOW_STARTER_TEMPLATE = `/**
 * @displayname __DISPLAY_NAME__
 * @description A new workflow
 */
export async function __WORKFLOW_NAME__() {
  "use workflow";

  return { success: true };
}
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

export function readWorkflowDisplayName(
  source: string,
  workflowName: string,
): string | null {
  const escapedName = escapeRegExp(workflowName);
  const docAndFnPattern = new RegExp(
    `\\/\\*\\*[\\s\\S]*?\\*\\/\\s*export\\s+async\\s+function\\s+${escapedName}\\s*\\(`,
  );
  const match = source.match(docAndFnPattern);
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
  const fnPattern = new RegExp(
    `(\\/\\*\\*[\\s\\S]*?\\*\\/\\s*)?(export\\s+async\\s+function\\s+${escapedName}\\s*\\()`,
  );
  const match = source.match(fnPattern);
  if (!match) return source;

  const existingDoc = match[1];
  const fnSignature = match[2];
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

  return source.replace(fnPattern, `${nextDoc}${fnSignature}`);
}
