import { describe, expect, it } from "vitest";
import {
  deterministicTestEnvironment,
  dockerPostgresRunArgs,
  parseDockerPort,
  type TestPostgresDriver,
  testContainerName,
  withDisposablePostgres,
} from "./test-postgres.js";

class RecordingDriver implements TestPostgresDriver {
  readonly calls: string[] = [];
  runError?: Error;
  healthResults: Array<"healthy" | "starting" | "unhealthy"> = ["healthy"];
  healthError?: Error;
  portOutput = "127.0.0.1:49175\n";
  logsOutput = "postgres startup log";

  async run(input: { name: string; args: readonly string[] }): Promise<void> {
    this.calls.push(`run:${input.name}:${input.args.join(" ")}`);
    if (this.runError) throw this.runError;
  }

  async port(input: { name: string }): Promise<string> {
    this.calls.push(`port:${input.name}`);
    return this.portOutput;
  }

  async inspectHealth(input: {
    name: string;
  }): Promise<"healthy" | "starting" | "unhealthy"> {
    this.calls.push(`health:${input.name}`);
    if (this.healthError) throw this.healthError;
    return this.healthResults.shift() ?? "healthy";
  }

  async logs(input: { name: string }): Promise<string> {
    this.calls.push(`logs:${input.name}`);
    return this.logsOutput;
  }

  async stop(input: { name: string }): Promise<void> {
    this.calls.push(`stop:${input.name}`);
  }
}

describe("disposable Postgres", () => {
  it("creates distinct Docker-safe lowercase names from distinct nonces", () => {
    const first = testContainerName({ pid: 42, nonce: "FIRST/Nonce" });
    const second = testContainerName({ pid: 42, nonce: "second nonce" });

    expect(first).not.toBe(second);
    expect(first).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
    expect(second).toMatch(/^[a-z0-9][a-z0-9.-]*$/);
  });

  it("runs Postgres 17 on an ephemeral IPv4 loopback port without a volume", () => {
    const args = dockerPostgresRunArgs({ name: "catamorphic-test-42-a" });

    expect(args).toContain("run");
    expect(args).toContain("--detach");
    expect(args).toContain("--rm");
    expect(args).toContain("127.0.0.1::5432");
    expect(args).toContain("postgres:17");
    expect(args).toContain("max_connections=300");
    expect(args.some((argument) => argument.includes("volume"))).toBe(false);
    expect(args).not.toContain("-v");
  });

  it("parses an ephemeral IPv4 loopback Docker port", () => {
    expect(parseDockerPort("127.0.0.1:49175\n")).toBe(49175);
  });

  it.each([
    "0.0.0.0:49175\n",
    "[::]:49175\n",
    "127.0.0.1:not-a-port\n",
    "127.0.0.1:0\n",
    "127.0.0.1:70000\n",
    "127.0.0.1:49175 extra\n",
  ])("rejects malformed or non-loopback Docker port output %j", (output) => {
    expect(() => parseDockerPort(output)).toThrow("Docker port output");
  });

  it("stops the container exactly once after a successful task", async () => {
    const driver = new RecordingDriver();

    const result = await withDisposablePostgres({
      driver,
      pid: 42,
      nonce: "success",
      task: async (databaseUrl) => databaseUrl,
    });

    expect(result).toBe(
      "postgresql://catamorphic:catamorphic@127.0.0.1:49175/catamorphic",
    );
    expect(
      driver.calls.filter((call) => call.startsWith("stop:")),
    ).toHaveLength(1);
  });

  it("reports the exact container name and published port before the task", async () => {
    const driver = new RecordingDriver();
    const reports: string[] = [];

    await withDisposablePostgres({
      driver,
      pid: 42,
      nonce: "evidence",
      report: (message) => reports.push(message),
      task: async () => {
        expect(reports).toEqual([
          "test-postgres container=catamorphic-test-42-ee8250fb76e094b3 published-port=49175",
        ]);
      },
    });
  });

  it("stops exactly once and rethrows the original task error", async () => {
    const driver = new RecordingDriver();
    const taskError = new Error("task failed");

    const operation = withDisposablePostgres({
      driver,
      pid: 42,
      nonce: "task-error",
      task: async () => {
        throw taskError;
      },
    });

    await expect(operation).rejects.toBe(taskError);
    expect(
      driver.calls.filter((call) => call.startsWith("stop:")),
    ).toHaveLength(1);
  });

  it.each(["startup", "health"])(
    "attempts cleanup after a %s failure without invoking the task",
    async (failure) => {
      const driver = new RecordingDriver();
      if (failure === "startup") {
        driver.runError = new Error("docker run failed");
      } else {
        driver.healthError = new Error("docker inspect failed");
      }
      let taskCalls = 0;

      await expect(
        withDisposablePostgres({
          driver,
          pid: 42,
          nonce: failure,
          task: async () => {
            taskCalls += 1;
          },
        }),
      ).rejects.toThrow(
        failure === "startup" ? "docker run failed" : "docker inspect failed",
      );

      expect(taskCalls).toBe(0);
      expect(
        driver.calls.filter((call) => call.startsWith("stop:")),
      ).toHaveLength(1);
    },
  );

  it("uses the disposable database and strips all external integration access", () => {
    const environment = deterministicTestEnvironment(
      {
        PATH: "/usr/bin",
        DATABASE_URL: "postgresql://ambient",
        ANTHROPIC_API_KEY: "anthropic",
        CATAMORPHIC_EXTERNAL_INTEGRATIONS: "1",
        CF_SANDBOX_INTEGRATION: "1",
        CLOUDFLARE_ACCOUNT_ID: "account",
        CLOUDFLARE_API_TOKEN: "token",
        CLOUDFLARE_ARTIFACTS_NAMESPACE: "namespace",
        CLOUDFLARE_SANDBOX_API_KEY: "sandbox-key",
        CLOUDFLARE_SANDBOX_API_URL: "https://sandbox.example",
        DAYTONA_API_KEY: "daytona",
        OPENAI_API_KEY: "openai",
        OPENROUTER_API_KEY: "openrouter",
        S3_ACCESS_KEY_ID: "access",
        S3_BUCKET: "bucket",
        S3_ENDPOINT: "https://s3.example",
        S3_FORCE_PATH_STYLE: "true",
        S3_REGION: "region",
        S3_SECRET_ACCESS_KEY: "secret",
      },
      "postgresql://disposable",
    );

    expect(environment).toEqual({
      PATH: "/usr/bin",
      DATABASE_URL: "postgresql://disposable",
    });
  });
});
