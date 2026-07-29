import { createAnthropic } from "@ai-sdk/anthropic";
import { createOpenAI } from "@ai-sdk/openai";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import type { SandboxProvider } from "@catamorphic/sandbox";
import type { DesktopSettings } from "./settings.js";

const INSTRUCTIONS =
  "You are the Catamorphic workflow assistant. Edit the TypeScript project " +
  "in your working directory to build and modify workflows. Consult " +
  ".agents/skills/ for project-specific guidance before large changes.";

export function resolveCodingAgent(
  settings: DesktopSettings,
  sandboxProvider: SandboxProvider,
): AiSdkCodingAgent | undefined {
  if (!settings.apiKey) return undefined;
  const model =
    settings.provider === "anthropic"
      ? createAnthropic({ apiKey: settings.apiKey })(settings.model)
      : createOpenAI({ apiKey: settings.apiKey })(settings.model);
  return new AiSdkCodingAgent({
    model,
    sandboxProvider,
    instructions: INSTRUCTIONS,
  });
}
