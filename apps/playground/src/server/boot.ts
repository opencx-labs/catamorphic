import path from "node:path";
import { anthropic } from "@ai-sdk/anthropic";
import { openai } from "@ai-sdk/openai";
import { AiSdkCodingAgent } from "@catamorphic/ai-sdk";
import {
  ArtifactsApiError,
  ArtifactsClient,
  ArtifactsRemoteBackend,
  CloudflareSandboxProvider,
} from "@catamorphic/cloudflare";
import {
  FsBackend,
  FsRemoteBackend,
  ProjectManager,
  type RemoteBackend,
} from "@catamorphic/git";
import { S3ObjectStore, S3RemoteBackend } from "@catamorphic/s3";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { type Catamorphic, createCatamorphic } from "@catamorphic/server-sdk";

/** Fixed demo identity — the playground stands in for the host's auth. */
export const DEMO_TENANT_ID = "00000000-0000-4000-8000-000000000001";
export const DEMO_USER_ID = "playground-user";

const DATA_DIR = path.resolve(import.meta.dirname, "../../.data");

const DEFAULT_DATABASE_URL =
  "postgresql://catamorphic:catamorphic@localhost:5432/catamorphic";

/**
 * Code storage resolution order (see docs/decisions/0012):
 * 1. S3-compatible object storage (Cloudflare R2 et al.) when `S3_*` is set —
 *    the default until the account gets Cloudflare Artifacts access.
 * 2. Cloudflare Artifacts when configured and not feature-gated.
 * 3. Filesystem bare repos, with a loud warning.
 */
async function resolveRemoteBackend(): Promise<RemoteBackend> {
  const s3Backend = resolveS3RemoteBackend();
  if (s3Backend) return s3Backend;

  const accountId = process.env.CLOUDFLARE_ACCOUNT_ID;
  const apiToken = process.env.CLOUDFLARE_API_TOKEN;
  const namespace = process.env.CLOUDFLARE_ARTIFACTS_NAMESPACE;

  const fsFallback = () => new FsRemoteBackend(path.join(DATA_DIR, "remotes"));

  if (!accountId || !apiToken || !namespace) {
    console.warn(
      "[playground] Neither S3_BUCKET/S3_ACCESS_KEY_ID/S3_SECRET_ACCESS_KEY " +
        "nor CLOUDFLARE_ACCOUNT_ID/CLOUDFLARE_API_TOKEN/" +
        "CLOUDFLARE_ARTIFACTS_NAMESPACE are set — using filesystem git remotes.",
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

function resolveS3RemoteBackend(): S3RemoteBackend | undefined {
  const bucket = process.env.S3_BUCKET;
  const accessKeyId = process.env.S3_ACCESS_KEY_ID;
  const secretAccessKey = process.env.S3_SECRET_ACCESS_KEY;
  if (!bucket || !accessKeyId || !secretAccessKey) return undefined;

  const endpoint = process.env.S3_ENDPOINT;
  console.log(
    `[playground] Code storage: S3-compatible bucket '${bucket}'` +
      (endpoint ? ` at ${endpoint}` : ""),
  );
  return new S3RemoteBackend({
    store: new S3ObjectStore({
      bucket,
      endpoint,
      region: process.env.S3_REGION,
      forcePathStyle: process.env.S3_FORCE_PATH_STYLE === "true",
      credentials: { accessKeyId, secretAccessKey },
    }),
    keyPrefix: process.env.S3_KEY_PREFIX ?? "playground/",
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
 * The AI SDK agent loop runs in this server process and drives the Cloudflare
 * dev sandbox remotely. Model keys stay on the server and never enter it.
 */
function resolveCodingAgent(
  sandboxProvider: SandboxProvider | undefined,
): AiSdkCodingAgent | undefined {
  if (!sandboxProvider) return undefined;
  const configuredModel = process.env.CODING_AGENT_MODEL;
  const model = configuredModel
    ? resolveCodingAgentModel(configuredModel)
    : process.env.OPENAI_API_KEY
      ? openai("gpt-5.2-codex")
      : process.env.ANTHROPIC_API_KEY
        ? anthropic("claude-sonnet-4-5")
        : undefined;
  if (model === undefined) {
    console.warn(
      "[playground] No CODING_AGENT_MODEL / OPENAI_API_KEY / " +
        "ANTHROPIC_API_KEY set; the coding agent is disabled.",
    );
    return undefined;
  }
  console.log(
    `[playground] Coding agent: AI SDK (${configuredModel ?? "default"})`,
  );
  return new AiSdkCodingAgent({
    model,
    sandboxProvider,
    instructions:
      "You are the Catamorphic workflow assistant. Edit the TypeScript " +
      "project in your working directory to build and modify workflows. " +
      "Consult .agents/skills/ for project-specific guidance before large " +
      "changes.",
  });
}

function resolveCodingAgentModel(model: string) {
  if (model.startsWith("openai/")) {
    return openai(model.slice("openai/".length));
  }
  if (model.startsWith("anthropic/")) {
    return anthropic(model.slice("anthropic/".length));
  }
  throw new Error(
    `Unsupported CODING_AGENT_MODEL '${model}'. Use openai/<model> or anthropic/<model>.`,
  );
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
  if (sandboxProvider) {
    catamorphic.startWorker({
      workerId: "playground",
      concurrency: 2,
    });
  }

  return catamorphic;
}
