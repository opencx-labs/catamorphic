import path from "node:path";
import {
  ArtifactsApiError,
  ArtifactsClient,
  ArtifactsRemoteBackend,
  CloudflareSandboxProvider,
} from "@catamorphic/cloudflare";
import { FlueCodingAgent } from "@catamorphic/flue";
import {
  FsBackend,
  FsRemoteBackend,
  ProjectManager,
  type RemoteBackend,
} from "@catamorphic/git";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { type Catamorphic, createCatamorphic } from "@catamorphic/server-sdk";

/** Fixed demo identity — the playground stands in for the host's auth. */
export const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER_ID = "playground-user";

const DATA_DIR = path.resolve(import.meta.dirname, "../../.data");

const DEFAULT_DATABASE_URL =
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

/**
 * Cloudflare Artifacts is the playground's canonical code storage. It is in
 * closed beta, so accounts without access (REST error 10004 "Access denied
 * by feature gate") fall back to filesystem bare repos with a loud warning.
 */
async function resolveRemoteBackend(): Promise<RemoteBackend> {
  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespace = process.env.CLOUDFLARE_ARTIFACTS_NAMESPACE;

  const fsFallback = () => new FsRemoteBackend(path.join(DATA_DIR, "remotes"));

  if (!accountId || !apiToken || !namespace) {
    console.warn(
      "[playground] CLOUDFLARE_ACCOUNT_ID / CLOUDFLARE_API_TOKEN / " +
        "CLOUDFLARE_ARTIFACTS_NAMESPACE not set — using filesystem git remotes.",
    );
    return fsFallback();
  }

  const client = new ArtifactsClient({ accountId, apiToken, namespace });
  try {
    await client.getRepo("playground-access-probe");
  } catch (err) {
    if (err instanceof ArtifactsApiError && err.codes.includes(10004)) {
      console.warn(
        "[playground] Cloudflare Artifacts is feature-gated for this account " +
          "(closed beta). Falling back to filesystem git remotes. Request " +
          "access: https://www.cloudflare.com/products/artifacts/",
      );
      return fsFallback();
    }
    throw err;
  }

  console.log(
    `[playground] Code storage: Cloudflare Artifacts (namespace '${namespace}')`,
  );
  return new ArtifactsRemoteBackend({
    client,
    cachePath: path.join(DATA_DIR, "artifacts-cache"),
    repoPrefix: "playground",
  });
}

function resolveSandboxProvider(): CloudflareSandboxProvider | undefined {
  const apiUrl = process.env.CLOUDFLARE_SANDBOX_API_URL;
  if (!apiUrl) {
    console.warn(
      "[playground] CLOUDFLARE_SANDBOX_API_URL not set — workflow runs are " +
        "disabled. Start the bridge: `bun run dev` in " +
        "packages/cloudflare-sandbox-bridge.",
    );
    return undefined;
  }
  console.log(`[playground] Sandbox: Cloudflare bridge at ${apiUrl}`);
  return new CloudflareSandboxProvider({
    apiUrl,
    apiKey: process.env.CLOUDFLARE_SANDBOX_API_KEY,
  });
}

/**
 * The playground's coding agent is Flue (https://flueframework.com): the
 * harness runs in this server process and drives the Cloudflare dev sandbox
 * remotely. Model keys stay on the server and never enter the sandbox.
 */
function resolveCodingAgent(
  sandboxProvider: SandboxProvider | undefined,
): FlueCodingAgent | undefined {
  if (!sandboxProvider) return undefined;
  const model =
    process.env.FLUE_MODEL ??
    (process.env.OPENAI_API_KEY ? "openai/gpt-5.2-codex" : undefined) ??
    (process.env.ANTHROPIC_API_KEY ? "anthropic/claude-sonnet-4-5" : undefined);
  if (!model) {
    console.warn(
      "[playground] No FLUE_MODEL / OPENAI_API_KEY / ANTHROPIC_API_KEY set — " +
        "the coding agent is disabled.",
    );
    return undefined;
  }
  console.log(`[playground] Coding agent: Flue (${model})`);
  return new FlueCodingAgent({
    model,
    sandboxProvider,
    instructions:
      "You are the Catamorphic workflow assistant. Edit the TypeScript " +
      "project in your working directory to build and modify workflows. " +
      "Consult .agents/skills/ for project-specific guidance before large " +
      "changes.",
  });
}

export async function bootCatamorphic(): Promise<Catamorphic> {
  const remoteBackend = await resolveRemoteBackend();
  const sandboxProvider = resolveSandboxProvider();

  const catamorphic = createCatamorphic({
    database: {
      connectionString: process.env.DATABASE_URL ?? DEFAULT_DATABASE_URL,
    },
    storage: {
      projectManager: new ProjectManager(
        new FsBackend(path.join(DATA_DIR, "projects")),
        remoteBackend,
      ),
    },
    sandboxProvider,
    codingAgent: resolveCodingAgent(sandboxProvider),
  });

  const { applied } = await catamorphic.migrate();
  if (applied.length > 0) {
    console.log(`[playground] Applied migrations: ${applied.join(", ")}`);
  }

  return catamorphic;
}
