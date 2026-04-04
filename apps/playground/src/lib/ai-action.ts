"use server";

import OpenAI from "openai";

function getClient() {
  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error("OPENAI_API_KEY environment variable is not set");
  }
  return new OpenAI({ apiKey });
}

const SYSTEM_PROMPT = `You are a workflow code generator for Catamorphic AI. You write TypeScript workflow code.

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

export async function generateWorkflowCode({
  prompt,
  currentCode,
}: {
  prompt: string;
  currentCode: string;
}): Promise<string> {
  const client = getClient();

  const userMessage = currentCode.trim()
    ? `Current workflow code:\n\`\`\`typescript\n${currentCode}\n\`\`\`\n\nUser request: ${prompt}`
    : `User request: ${prompt}`;

  const response = await client.chat.completions.create({
    model: "gpt-4.1",
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userMessage },
    ],
    temperature: 0.3,
  });

  const content = response.choices[0]?.message?.content ?? "";

  const codeBlockMatch = content.match(
    /```(?:typescript|ts)?\s*\n([\s\S]*?)\n```/,
  );
  if (codeBlockMatch?.[1]) {
    return codeBlockMatch[1].trim();
  }

  return content.trim();
}
