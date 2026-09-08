import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);
const POSTGRES_USER = "catamorphic";
const POSTGRES_PASSWORD = "catamorphic";
const POSTGRES_DATABASE = "catamorphic";
const STARTUP_TIMEOUT_MS = 60_000;
const HEALTH_POLL_INTERVAL_MS = 250;

const EXTERNAL_TEST_VARIABLES = [
  "ANTHROPIC_API_KEY",
  "CATAMORPHIC_EXTERNAL_INTEGRATIONS",
  "CF_SANDBOX_INTEGRATION",
  "CLOUDFLARE_ACCOUNT_ID",
  "CLOUDFLARE_API_TOKEN",
  "CLOUDFLARE_ARTIFACTS_NAMESPACE",
  "CLOUDFLARE_SANDBOX_API_KEY",
  "CLOUDFLARE_SANDBOX_API_URL",
  "DAYTONA_API_KEY",
  "OPENAI_API_KEY",
  "OPENROUTER_API_KEY",
  "S3_ACCESS_KEY_ID",
  "S3_BUCKET",
  "S3_ENDPOINT",
  "S3_FORCE_PATH_STYLE",
  "S3_REGION",
  "S3_SECRET_ACCESS_KEY",
] as const;

export type TestPostgresHealth = "healthy" | "starting" | "unhealthy";

export interface TestPostgresDriver {
  run(input: { name: string; args: readonly string[] }): Promise<void>;
  port(input: { name: string }): Promise<string>;
  inspectHealth(input: { name: string }): Promise<TestPostgresHealth>;
  logs(input: { name: string }): Promise<string>;
  stop(input: { name: string }): Promise<void>;
}

export function testContainerName(input: {
  pid: number;
  nonce: string;
}): string {
  const nonceHash = createHash("sha256")
    .update(input.nonce)
    .digest("hex")
    .slice(0, 16);
  return `catamorphic-test-${input.pid}-${nonceHash}`;
}

export function dockerPostgresRunArgs(input: { name: string }): string[] {
  return [
    "run",
    "--detach",
    "--rm",
    "--name",
    input.name,
    "--label",
    "catamorphic.test-run",
    "--publish",
    "127.0.0.1::5432",
    "--env",
    `POSTGRES_USER=${POSTGRES_USER}`,
    "--env",
    `POSTGRES_PASSWORD=${POSTGRES_PASSWORD}`,
    "--env",
    `POSTGRES_DB=${POSTGRES_DATABASE}`,
    "--health-cmd",
    `pg_isready -U ${POSTGRES_USER} -d ${POSTGRES_DATABASE}`,
    "--health-interval",
    "250ms",
    "--health-timeout",
    "5s",
    "--health-retries",
    "240",
    "postgres:17",
    "-c",
    "max_connections=300",
  ];
}

export function parseDockerPort(output: string): number {
  const match = /^127\.0\.0\.1:([0-9]+)\n?$/.exec(output);
  const port = match ? Number(match[1]) : Number.NaN;
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new Error(`Invalid Docker port output: ${JSON.stringify(output)}`);
  }
  return port;
}

export function deterministicTestEnvironment(
  source: NodeJS.ProcessEnv,
  databaseUrl: string,
): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...source,
    DATABASE_URL: databaseUrl,
  };
  delete environment.CATAMORPHIC_DB_SCHEMA;
  for (const variable of EXTERNAL_TEST_VARIABLES) {
    delete environment[variable];
  }
  return environment;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function wait(input: { milliseconds: number }): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, input.milliseconds));
}

async function waitForPostgres(input: {
  driver: TestPostgresDriver;
  name: string;
}): Promise<void> {
  const deadline = Date.now() + STARTUP_TIMEOUT_MS;
  while (Date.now() < deadline) {
    const health = await input.driver.inspectHealth({ name: input.name });
    if (health === "healthy") return;
    if (health === "unhealthy") {
      throw new Error("Postgres container reported unhealthy");
    }
    await wait({ milliseconds: HEALTH_POLL_INTERVAL_MS });
  }
  throw new Error(`Postgres did not become healthy within 60 seconds`);
}

async function startupError(input: {
  driver: TestPostgresDriver;
  name: string;
  cause: unknown;
}): Promise<Error> {
  let logs = "<container logs unavailable>";
  try {
    const output = await input.driver.logs({ name: input.name });
    if (output.trim()) logs = output.trim();
  } catch {
    // The container may not exist when `docker run` itself failed.
  }
  return new Error(
    `Disposable Postgres startup failed: ${errorMessage(input.cause)}\n${logs}`,
    { cause: input.cause },
  );
}

export async function withDisposablePostgres<T>(input: {
  driver: TestPostgresDriver;
  pid: number;
  nonce: string;
  report?: (message: string) => void;
  task(databaseUrl: string): Promise<T>;
}): Promise<T> {
  const name = testContainerName({ pid: input.pid, nonce: input.nonce });
  let outcome:
    | { success: true; value: T }
    | { success: false; error: unknown }
    | undefined;
  let cleanupError: unknown;
  try {
    let databaseUrl: string;
    try {
      await input.driver.run({
        name,
        args: dockerPostgresRunArgs({ name }),
      });
      await waitForPostgres({ driver: input.driver, name });
      const port = parseDockerPort(await input.driver.port({ name }));
      databaseUrl =
        `postgresql://${POSTGRES_USER}:${POSTGRES_PASSWORD}` +
        `@127.0.0.1:${port}/${POSTGRES_DATABASE}`;
      (input.report ?? console.log)(
        `test-postgres container=${name} published-port=${port}`,
      );
    } catch (error) {
      throw await startupError({ driver: input.driver, name, cause: error });
    }
    outcome = { success: true, value: await input.task(databaseUrl) };
  } catch (error) {
    outcome = { success: false, error };
  } finally {
    try {
      await input.driver.stop({ name });
    } catch (error) {
      cleanupError = error;
    }
  }
  if (!outcome) throw new Error("Disposable Postgres task did not settle");
  if (!outcome.success) {
    if (cleanupError !== undefined) {
      throw new AggregateError(
        [outcome.error, cleanupError],
        "Disposable Postgres task and cleanup both failed",
      );
    }
    throw outcome.error;
  }
  if (cleanupError !== undefined) throw cleanupError;
  return outcome.value;
}

function dockerErrorOutput(error: unknown): string {
  if (typeof error !== "object" || error === null) return "";
  const stderr = "stderr" in error ? error.stderr : undefined;
  const stdout = "stdout" in error ? error.stdout : undefined;
  return `${typeof stderr === "string" ? stderr : ""}\n${
    typeof stdout === "string" ? stdout : ""
  }`;
}

export function dockerTestPostgresDriver(): TestPostgresDriver {
  return {
    async run({ args }) {
      await execFileAsync("docker", [...args]);
    },
    async port({ name }) {
      const { stdout } = await execFileAsync("docker", [
        "port",
        name,
        "5432/tcp",
      ]);
      return stdout;
    },
    async inspectHealth({ name }) {
      const { stdout } = await execFileAsync("docker", [
        "inspect",
        "--format={{if .State.Health}}{{.State.Health.Status}}{{else}}unhealthy{{end}}",
        name,
      ]);
      const health = stdout.trim();
      if (health === "healthy" || health === "starting") return health;
      return "unhealthy";
    },
    async logs({ name }) {
      const { stdout, stderr } = await execFileAsync("docker", ["logs", name]);
      return `${stdout}${stderr}`;
    },
    async stop({ name }) {
      try {
        await execFileAsync("docker", ["stop", "--time", "10", name]);
      } catch (error) {
        if (!dockerErrorOutput(error).includes("No such container"))
          throw error;
      }
    },
  };
}
