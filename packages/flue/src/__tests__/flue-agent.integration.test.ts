import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import type { AgentEvent } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { FlueCodingAgent } from "../flue-agent.js";

const CF_SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_API_URL;
const CF_SANDBOX_KEY = process.env.CLOUDFLARE_SANDBOX_API_KEY;
// Same explicit opt-in as the cloudflare provider integration tests, plus a
// model key: the Flue harness runs in this process and calls the LLM directly.
const CF_INTEGRATION = process.env.CF_SANDBOX_INTEGRATION === "1";
const MODEL = process.env.FLUE_MODEL ?? "openai/gpt-5.2-codex";
const HAS_MODEL_KEY = Boolean(
  process.env.OPENAI_API_KEY || process.env.ANTHROPIC_API_KEY,
);

const describeIf =
  CF_SANDBOX_URL && CF_INTEGRATION && HAS_MODEL_KEY ? describe : describe.skip;

describeIf("FlueCodingAgent (integration)", () => {
  let provider: CloudflareSandboxProvider;
  let sandboxId: string;
  let projectDir: string;

  beforeAll(async () => {
    provider = new CloudflareSandboxProvider({
      apiUrl: CF_SANDBOX_URL!,
      apiKey: CF_SANDBOX_KEY,
    });
    const handle = await provider.createSandbox({});
    sandboxId = handle.providerId;
    projectDir = `${provider.workspaceRoot}/project`;

    await provider.uploadFiles(
      sandboxId,
      {
        "package.json": JSON.stringify({
          name: "flue-integration-fixture",
          private: true,
          type: "module",
        }),
        "src/index.ts": 'export const greeting = "hello";\n',
        ".agents/skills/naming/SKILL.md": `---
name: naming
description: Naming conventions for this project. Use when creating files.
---

All new text files created by the agent must live at the project root and
use lowercase kebab-case names.
`,
      },
      projectDir,
    );
  }, 300_000);

  afterAll(async () => {
    if (sandboxId) {
      await provider.destroySandbox(sandboxId).catch(() => {});
    }
  }, 120_000);

  it("edits files in the remote sandbox from a server-side harness", async () => {
    const agent = new FlueCodingAgent({
      model: MODEL,
      sandboxProvider: provider,
    });

    const session = await agent.startSession({
      projectId: "flue-integration",
      userId: "integration-test",
      sandboxId,
      workingDirectory: projectDir,
      systemPrompt:
        "You are operating on a tiny fixture project. Follow instructions " +
        "literally and do not ask questions.",
    });
    expect(session.providerSessionId).toBeTruthy();

    const events: AgentEvent[] = [];
    for await (const event of agent.sendMessage(
      session,
      "Create a file named flue-was-here.txt at the project root containing " +
        "exactly the single line: flue integration ok",
    )) {
      events.push(event);
    }

    expect(events.at(-1)?.type).toBe("done");
    expect(events.some((event) => event.type === "error")).toBe(false);

    const content = await provider.downloadFile(
      sandboxId,
      `${projectDir}/flue-was-here.txt`,
    );
    expect(content.trim()).toBe("flue integration ok");

    await agent.dispose(session);
  }, 600_000);
});
