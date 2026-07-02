/**
 * End-to-end workflow execution against a real Cloudflare Sandbox via the
 * Bridge Worker. Requires:
 *
 *   CLOUDFLARE_SANDBOX_API_URL (+ CLOUDFLARE_SANDBOX_API_KEY) in `.env`
 *   CF_SANDBOX_INTEGRATION=1  (explicit opt-in — the URL is usually a
 *   localhost bridge that may not be running)
 *
 * Start the bridge with `bun run dev` in packages/cloudflare-sandbox-bridge.
 */
import { CloudflareSandboxProvider } from "@catamorphic/cloudflare";
import { describe, expect, it } from "vitest";
import { PlaygroundExecutor } from "../services/playground-executor.js";

const CF_SANDBOX_URL = process.env.CLOUDFLARE_SANDBOX_API_URL;
const CF_INTEGRATION = process.env.CF_SANDBOX_INTEGRATION === "1";

const describeIf = CF_SANDBOX_URL && CF_INTEGRATION ? describe : describe.skip;

const WORKFLOW_SOURCE = `
/**
 * @displayname Greet
 * @param name - @displayname Name
 */
async function greet({ name }: { name: string }) {
  "use step";
  return \`Hello, \${name}!\`;
}

export async function welcomeWorkflow({ name }: { name: string }) {
  "use workflow";
  const greeting = await greet({ name });
  return { greeting };
}
`;

describeIf("PlaygroundExecutor on Cloudflare Sandbox (integration)", () => {
  it("executes a workflow and reports step-level results", async () => {
    const provider = new CloudflareSandboxProvider({
      apiUrl: CF_SANDBOX_URL!,
      apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
    });
    const executor = new PlaygroundExecutor(provider);

    const result = await executor.execute({
      files: { "src/index.ts": WORKFLOW_SOURCE },
      workflowName: "welcomeWorkflow",
      triggerData: { name: "Catamorphic" },
    });

    expect(result.status).toBe("completed");
    expect(result.result).toEqual({ greeting: "Hello, Catamorphic!" });
    expect(result.steps).toHaveLength(1);
    expect(result.steps[0]).toMatchObject({
      name: "greet",
      status: "completed",
      output: "Hello, Catamorphic!",
    });
  }, 180_000);

  it("reports failures from workflow code", async () => {
    const provider = new CloudflareSandboxProvider({
      apiUrl: CF_SANDBOX_URL!,
      apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
    });
    const executor = new PlaygroundExecutor(provider);

    const result = await executor.execute({
      files: {
        "src/index.ts": `
export async function boomWorkflow() {
  "use workflow";
  throw new Error("intentional failure");
}
`,
      },
      workflowName: "boomWorkflow",
    });

    expect(result.status).toBe("failed");
    expect(result.error).toContain("intentional failure");
  }, 180_000);
});
