import type { AgentDefinition, CodingAgentRegistry } from "@catamorphic/core";
import { describe, expect, it } from "vitest";
import { buildAgentRegistry } from "./agents.js";

/** The server's committed agents whose harness runs in the sandbox (ADRs 0180, 0255). */
function registry(): CodingAgentRegistry {
  const { registry } = buildAgentRegistry({
    settings: { effort: "medium", fake: false },
  });
  if (!registry) throw new Error("No registry");
  return registry;
}

async function served(definition: Partial<AgentDefinition>) {
  const id = "project:6b1f0e5e-2b6c-4b16-9a51-7f1a1f1f1f1f:reviewer";
  return registry().projectAgent?.({
    id,
    entry: {
      slug: "reviewer",
      definition: { version: 1, name: "Reviewer", kind: "acp", ...definition },
      promptFile: "Review pull requests.",
    },
  });
}

describe("committed ACP agents on the Work server (ADR 0255)", () => {
  it("runs one on a model connection in its chat's sandbox, under a harness of its own", async () => {
    const agent = await served({
      acp: { command: ["opencode", "acp"] },
      model: "deepseek/v4-flash",
      credentials: { source: "connection", connection: "openrouter" },
      connections: ["github"],
    });
    expect(agent).toMatchObject({
      harness: {
        placement: "sandbox",
        id: "acp:project:6b1f0e5e-2b6c-4b16-9a51-7f1a1f1f1f1f:reviewer",
      },
      options: { command: ["opencode", "acp"] },
      modelConnection: "openrouter",
      defaults: { model: "deepseek/v4-flash" },
      sandboxing: "propose",
    });
    expect(agent?.connectionRequirements).toEqual([
      { alias: "github" },
      { alias: "openrouter" },
    ]);
    expect(agent?.systemPrompt).toContain("Review pull requests.");
  });

  it("serves none without a model connection or a command", async () => {
    expect(await served({ acp: { command: ["opencode", "acp"] } })).toBe(
      undefined,
    );
    expect(
      await served({
        acp: { command: ["hermes", "acp"] },
        credentials: { source: "personal" },
      }),
    ).toBe(undefined);
    expect(
      await served({
        credentials: { source: "connection", connection: "openrouter" },
      }),
    ).toBe(undefined);
  });
});
