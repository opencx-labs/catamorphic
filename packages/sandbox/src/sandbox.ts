import type { CatamorphicSandbox, SandboxConfig } from "./types.js";

const WORKFLOW_SYSTEM_PROMPT = `You are a workflow code assistant for Catamorphic AI.

You write TypeScript workflow code following these conventions:

1. Workflows are async functions with a "use workflow" directive as the first statement.
2. Steps are async functions with a "use step" directive as the first statement.
3. ALL step functions must take a single destructured object parameter, never positional params.
4. Use JSDoc tags for metadata:
   - @displayname on functions for UI labels
   - @icon for step icons
   - @description for descriptions
   - @param tags with @displayname and @description sub-tags for each property
5. Supported constructs: await fn(), if/else, for/for-of loops, Promise.all([...]), sleep(), return.
6. Only import from packages explicitly configured for the sandbox.

Example step function:
/**
 * @displayname Send Email
 * @icon mail
 * @param to - @displayname Recipient | @description Email address to send to
 * @param subject - @displayname Subject | @description Email subject line
 */
async function sendEmail({ to, subject }: { to: string; subject: string }) {
  "use step";
  // implementation
}
`;

export function createSandbox(config: SandboxConfig): CatamorphicSandbox {
  const packagesList = config.packages ?? [];

  return {
    async *prompt({ message, currentCode }) {
      const contextMessage = currentCode
        ? `Current workflow code:\n\`\`\`typescript\n${currentCode}\n\`\`\`\n\nUser request: ${message}`
        : message;

      const systemPrompt =
        packagesList.length > 0
          ? `${WORKFLOW_SYSTEM_PROMPT}\nAvailable packages: ${packagesList.join(", ")}`
          : `${WORKFLOW_SYSTEM_PROMPT}\nNo npm packages available. Only use built-in JS/TS features.`;

      yield {
        type: "text" as const,
        content: `[Sandbox: would send to ${config.agent} agent with ${config.provider} provider]\nSystem: ${systemPrompt.slice(0, 100)}...\nMessage: ${contextMessage.slice(0, 200)}...`,
      };

      yield { type: "done" as const };
    },

    async executeWorkflow({ code, triggerData }) {
      return {
        success: false,
        error: `Execution not yet implemented. Provider: ${config.provider}. Code length: ${code.length}. Trigger: ${JSON.stringify(triggerData)}`,
      };
    },

    async dispose() {
      // cleanup
    },
  };
}
