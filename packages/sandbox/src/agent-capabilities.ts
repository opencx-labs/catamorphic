import { z } from "zod";
import type { ExtraTool } from "./coding-agent/types.js";

/** Transport-neutral discovery. Definitions are loaded only when requested. */
export const CapabilityDescriptorSchema = z.object({
  name: z.string(),
  description: z.string(),
  effect: z.enum(["read", "write"]),
  inputSchema: z.record(z.string(), z.unknown()),
  outputSchema: z.record(z.string(), z.unknown()),
});
export const DiscoverCapabilitiesSchema = z.object({
  query: z.string().max(300).default(""),
  cursor: z.string().max(200).optional(),
  limit: z.number().int().min(1).max(20).default(10),
});
export const InvokeCapabilitySchema = z.object({
  name: z.string().min(1).max(200),
  input: z.record(z.string(), z.unknown()).default({}),
  requestId: z.string().min(1).max(200),
});
export const CapabilityPageSchema = z.object({
  items: z.array(CapabilityDescriptorSchema),
  nextCursor: z.string().optional(),
});
export interface AgentCapabilityGateway {
  discover(
    args: z.input<typeof DiscoverCapabilitiesSchema>,
  ): Promise<z.output<typeof CapabilityPageSchema>>;
  invoke(
    args: z.input<typeof InvokeCapabilitySchema> & { signal?: AbortSignal },
  ): Promise<unknown>;
}

/** Two bootstrap tools for harnesses without native deferred tool loading. */
export function agentCapabilityTools(
  gateway: AgentCapabilityGateway,
  signal?: AbortSignal,
): (ExtraTool & { parameters: z.ZodRawShape })[] {
  return [
    {
      name: "discover_capabilities",
      description:
        "Find permitted host capabilities by topic, such as apps, workflows, browser, terminal, sessions, documents, connections, or execution. Returns typed schemas. Visibility is not permission to perform another action.",
      parameters: DiscoverCapabilitiesSchema.shape,
      execute: (input) =>
        gateway.discover(DiscoverCapabilitiesSchema.parse(input)),
    },
    {
      name: "invoke_capability",
      description:
        "Invoke a capability using its discovered name and input schema. Reuse the requestId when explicitly retrying the same operation; never assume an uncertain write failed. Live authorization applies to every call.",
      parameters: InvokeCapabilitySchema.shape,
      execute: (input) =>
        gateway.invoke({ ...InvokeCapabilitySchema.parse(input), signal }),
    },
  ];
}

/** Factual context is separate from the user's message and refreshed each turn. */
export function withAgentContext(
  instructions: string | undefined,
  context: string | undefined,
): string {
  return [instructions, context].filter(Boolean).join("\n\n");
}
