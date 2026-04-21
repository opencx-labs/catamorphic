"use server";

import { ensurePrimaryWorkflowExportName } from "@catamorphic/react/workflow-helpers";
import OpenAI from "openai";

const API_URL = process.env.NEXT_PUBLIC_API_URL ?? "http://localhost:3001";

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  return new OpenAI({ apiKey });
}

async function fetchAgentContext(projectId: string): Promise<string> {
  try {
    const res = await fetch(
      `${API_URL}/api/projects/${projectId}/agent-context`,
    );
    if (!res.ok) return "";
    const parsed = (await res.json()) as { systemPromptSuffix?: unknown };
    return typeof parsed.systemPromptSuffix === "string"
      ? parsed.systemPromptSuffix
      : "";
  } catch {
    return "";
  }
}

function buildSystemPrompt(workflowExportName: string): string {
  return `You are a workflow code generator for Catamorphic AI. You write TypeScript workflow code.

RULES:
1. The main function MUST have \`"use workflow"\` as the first statement
2. Step functions MUST have \`"use step"\` as the first statement
3. Use JSDoc annotations for metadata:
   - \`@displayname\` - Human-readable name
   - \`@description\` - What this step/workflow does
   - \`@icon\` - Icon name (e.g. mail, database, user-plus, bell, shield, clock, globe, code, file, search, settings, zap)
   - \`@param\` - Parameter docs with sub-tags: \`@param name - @displayname Display Name | @description Description text\`
4. Step parameters should use a single object parameter with typed properties
5. Use \`await sleep("duration")\` for delays (e.g. "5 minutes", "1 hour", "7 days")
6. Use \`Promise.all()\` for parallel execution
7. Use standard if/else for branching
8. Use for...of loops for iteration
9. Export only the main workflow function
10. Step functions should be declared at module level (not nested)
11. The workflow function body must only orchestrate by awaiting step functions (plus sleep, Promise.all, branches, loops). Do not call console.log, fetch, or other side effects directly in the workflow body — those belong inside a step function with "use step". For "hello world" or logging, define a step (e.g. printHello) and await it from the workflow.
12. The exported workflow entry MUST be named exactly \`${workflowExportName}\`: \`export async function ${workflowExportName}(...) { "use workflow"; ... }\`. Never rename this identifier — the app URL, graph, and sandbox run use this exact name.

RESPONSE FORMAT:
Return ONLY the TypeScript code. No markdown, no explanation, no backticks.
The code should be a complete, valid TypeScript module.

EXAMPLE:
/**
 * @displayname Send Notification
 * @description Send a notification to a user
 */
export async function sendNotification({ userId, message }: { userId: string; message: string }) {
  "use workflow";

  const user = await getUser({ userId });
  await sendEmail({ to: user.email, subject: "Notification", body: message });
  await sendPush({ userId, message });

  return { success: true };
}

/**
 * @displayname Get User
 * @icon user-plus
 * @param userId - @displayname User ID | @description The unique user identifier
 */
async function getUser({ userId }: { userId: string }) {
  "use step";
  return { id: userId, email: "user@example.com", name: "User" };
}

/**
 * @displayname Send Email
 * @icon mail
 */
async function sendEmail({ to, subject, body }: { to: string; subject: string; body: string }) {
  "use step";
}

/**
 * @displayname Send Push Notification
 * @icon bell
 */
async function sendPush({ userId, message }: { userId: string; message: string }) {
  "use step";
}`;
}

export async function generateWorkflowCode({
  prompt,
  currentCode,
  workflowFunctionName,
  projectId,
}: {
  prompt: string;
  currentCode: string;
  workflowFunctionName: string;
  projectId?: string;
}): Promise<string> {
  const client = getClient();

  const nameReminder = `Required exported workflow function name: ${workflowFunctionName} (must match exactly).\n\n`;

  const userMessage = currentCode.trim()
    ? `${nameReminder}Current workflow code:\n\`\`\`typescript\n${currentCode}\n\`\`\`\n\nUser request: ${prompt}`
    : `${nameReminder}User request: ${prompt}`;

  const pluginContext = projectId ? await fetchAgentContext(projectId) : "";
  const systemPrompt = [buildSystemPrompt(workflowFunctionName), pluginContext]
    .filter(Boolean)
    .join("\n\n");

  const response = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content ?? "";

  const codeBlockMatch = content.match(
    /```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/,
  );
  const raw = codeBlockMatch?.[1] ? codeBlockMatch[1].trim() : content.trim();

  return ensurePrimaryWorkflowExportName(raw, workflowFunctionName);
}
