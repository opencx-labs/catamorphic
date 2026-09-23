import type { HookCallback, Options } from "@anthropic-ai/claude-agent-sdk";

/**
 * Per-turn context (ADR 0152) rides Claude Code's own channel for context
 * beside a prompt: UserPromptSubmit's additionalContext, which the CLI keeps
 * apart from the user's words. The turn's first prompt takes it; inputs
 * streamed mid-turn carry only their own text.
 */
export function turnContextHooks(live: {
  turnContext?: string;
}): NonNullable<Options["hooks"]> {
  const onPrompt: HookCallback = async () => {
    const additionalContext = live.turnContext;
    live.turnContext = undefined;
    return additionalContext
      ? {
          hookSpecificOutput: {
            hookEventName: "UserPromptSubmit",
            additionalContext,
          },
        }
      : {};
  };
  return { UserPromptSubmit: [{ hooks: [onPrompt] }] };
}
