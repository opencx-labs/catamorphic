import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { JsonValue } from "@catamorphic/agent-protocol";
import {
  type AttemptStart,
  type HarnessEvent,
  RUNNER_PROTOCOL_VERSION,
  type RunnerFrame,
} from "@catamorphic/agent-protocol/runner";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  configureSandboxGateway,
  removeSandboxGateway,
} from "../services/sandbox-git.js";
import {
  deliverSandboxSecrets,
  removeSandboxSecrets,
  sandboxEnvFiles,
  sandboxSecretsFile,
} from "../services/sandbox-secrets.js";
import {
  type RunnerChannel,
  sandboxChannel,
  startSandboxRunner,
} from "../services/sessions/runner-channels.js";

/*
 * The runner bundle in a sandbox (ADR 0198): uploaded by hash, run as a
 * process with standard input, read by byte cursor, and read on by another
 * holder from the stored cursor.
 */

function attempt(text: string): AttemptStart {
  return {
    protocol: RUNNER_PROTOCOL_VERSION,
    sessionId: "session",
    projectId: "project",
    turnId: "turn",
    attemptId: "attempt",
    reason: "initial",
    harness: "echo",
    workingDirectory: "/workspace",
    stateDirectory: "/workspace/.work-session",
    thread: { mode: "fresh", providerThreadId: "thread" },
    input: { itemId: "input", text, attachments: [] },
    systemPrompt: "",
    context: "",
    permissions: {},
    modelAccess: { kind: "host" },
    toolPolicies: {},
    toolAnnotations: {},
    mcpServers: {},
    hostTools: [],
    plugins: [],
    env: {},
    options: {},
  };
}

/** Read a channel until `done`, answering the echo harness's state calls. */
async function readUntil(input: {
  channel: RunnerChannel;
  cursor: number;
  frames: RunnerFrame[];
  done: (frames: RunnerFrame[]) => boolean;
  /** What a native state load answers; nothing stored by default. */
  loaded?: JsonValue[];
}): Promise<number> {
  let cursor = input.cursor;
  const answered = new Set<string>();
  const deadline = Date.now() + 30_000;
  while (!input.done(input.frames)) {
    if (Date.now() > deadline)
      throw new Error("The sandbox runner never finished");
    const read = await input.channel.read({ cursor, waitMs: 500 });
    input.frames.push(...read.frames);
    cursor = read.cursor;
    for (const frame of read.frames)
      if (frame.type === "call" && !answered.has(frame.callId)) {
        answered.add(frame.callId);
        await input.channel.send([
          {
            id: `result:${frame.callId}`,
            command: {
              kind: "host_result",
              callId: frame.callId,
              result:
                frame.call.kind === "native_state.load"
                  ? (input.loaded ?? [])
                  : null,
            },
          },
        ]);
      }
  }
  return cursor;
}

const events = (frames: RunnerFrame[]) =>
  frames.flatMap((frame): HarnessEvent[] =>
    frame.type === "event" ? [frame.event] : [],
  );
/** The reply's text, from its streamed deltas. */
const replyText = (frames: RunnerFrame[]) =>
  events(frames)
    .map((event) =>
      event.type === "item.delta" && event.field === "text" ? event.text : "",
    )
    .join("");
const completed = (frames: RunnerFrame[]) =>
  events(frames).some((event) => event.type === "turn.completed");

describe("sandbox runner", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;

  beforeAll(() => {
    root = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-sandbox-runner-"),
    );
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs an attempt from the bundle and answers over standard input", async () => {
    const sandbox = await provider.createSandbox({});
    const channel = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    await channel.send([
      { id: "start", command: { kind: "start", attempt: attempt("hello") } },
    ]);
    const frames: RunnerFrame[] = [];
    await readUntil({ channel, cursor: 0, frames, done: completed });
    expect(frames[0]).toMatchObject({ type: "hello", harness: { id: "echo" } });
    expect(replyText(frames)).toContain("Echo: hello");
    expect(frames.map((frame) => frame.seq)).toEqual(
      frames.map((_, index) => index + 1),
    );
    await channel.kill();
  }, 60_000);

  it("is read on by another holder from the stored cursor, and reuses the uploaded bundle", async () => {
    const sandbox = await provider.createSandbox({});
    const first = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    await first.send([
      {
        id: "start",
        command: { kind: "start", attempt: attempt("[[wait 1500]] later") },
      },
    ]);
    const seen: RunnerFrame[] = [];
    const cursor = await readUntil({
      channel: first,
      cursor: 0,
      frames: seen,
      done: (frames) => events(frames).some((event) => event.type === "status"),
    });
    if (first.location.kind !== "sandbox_process")
      throw new Error("Expected a sandbox runner");
    // The first holder is gone; another reattaches by location and cursor.
    const second = sandboxChannel({ provider, location: first.location });
    const rest: RunnerFrame[] = [];
    await readUntil({ channel: second, cursor, frames: rest, done: completed });
    expect(rest[0]?.seq).toBe((seen.at(-1)?.seq ?? 0) + 1);
    expect(replyText(rest)).toContain("Echo: later");
    // A second runner in the same sandbox finds the bundle already there.
    const again = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    const listing = await provider.executeCommand(sandbox.id, "ls runner", {
      cwd: "/workspace/.work-session",
    });
    expect(listing.result.trim().split("\n")).toHaveLength(1);
    await again.kill();
  }, 60_000);

  it("replaces a bundle someone changed in the sandbox before it runs", async () => {
    const sandbox = await provider.createSandbox({});
    const stateDirectory = "/workspace/.work-session";
    const first = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory,
    });
    await first.kill();
    const listed = await provider.executeCommand(sandbox.id, "ls runner", {
      cwd: stateDirectory,
    });
    const file = listed.result.trim();
    await provider.executeCommand(
      sandbox.id,
      `printf 'console.log("not the runner")' > runner/${file}`,
      {
        cwd: stateDirectory,
      },
    );
    const channel = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory,
    });
    await channel.send([
      {
        id: "start",
        command: { kind: "start", attempt: attempt("still mine") },
      },
    ]);
    const frames: RunnerFrame[] = [];
    await readUntil({ channel, cursor: 0, frames, done: completed });
    expect(replyText(frames)).toContain("Echo: still mine");
    await channel.kill();
  }, 60_000);

  it("carries frames and commands larger than one read or write whole", async () => {
    const sandbox = await provider.createSandbox({});
    const channel = await startSandboxRunner({
      provider,
      allocationId: "allocation",
      sandboxId: sandbox.id,
      stateDirectory: "/workspace/.work-session",
    });
    // 400 000 three-byte characters: 1.2 MB of UTF-8, more than the 1 MiB
    // one process read returns or one input write carries.
    const big = "界".repeat(400_000);
    await channel.send([
      {
        id: "start",
        command: {
          kind: "start",
          attempt: {
            ...attempt("[[big 400000]] done"),
            thread: {
              mode: "resume",
              providerThreadId: "thread",
              nativeRef: { id: "native", strength: "strong" },
            },
          },
        },
      },
    ]);
    const frames: RunnerFrame[] = [];
    await readUntil({
      channel,
      cursor: 0,
      frames,
      done: completed,
      loaded: [{ turn: 1, text: big }],
    });
    // The loaded state arrived whole over several writes: turn 2 follows it.
    expect(replyText(frames)).toContain("Echo: done (turn 2)");
    // A call is never shortened: the stored entry was read across reads.
    const stored = frames.flatMap((frame) =>
      frame.type === "call" &&
      frame.call.kind === "native_state.append" &&
      frame.call.subpath === "big"
        ? frame.call.entries
        : [],
    );
    expect(stored).toEqual([{ big }]);
    // An event is shortened, by its bytes, to fit one read.
    const said = events(frames).flatMap((event) =>
      event.type === "item.started" &&
      event.key.startsWith("big:") &&
      event.item.kind === "assistant_message"
        ? [event.item.text]
        : [],
    );
    expect(said).toHaveLength(1);
    expect(said[0]).toContain("[Shortened: ");
    expect(frames.map((frame) => frame.seq)).toEqual(
      frames.map((_, index) => index + 1),
    );
    await channel.kill();
  }, 60_000);

  it("gives every attempt the session's environment files as they are then (ADRs 0206, 0212)", async () => {
    const sandbox = await provider.createSandbox({});
    const stateDirectory = "/workspace/.work-session";
    const target = {
      provider,
      sandboxId: sandbox.id,
      projectDir: "/workspace/project",
    };
    const envFile = sandboxSecretsFile({
      workspaceRoot: provider.workspaceRoot,
    });
    const envFiles = sandboxEnvFiles({
      workspaceRoot: provider.workspaceRoot,
    });
    /** What the echo harness says the attempt's environment holds. */
    const run = async () => {
      const channel = await startSandboxRunner({
        provider,
        allocationId: "allocation",
        sandboxId: sandbox.id,
        stateDirectory,
      });
      await channel.send([
        {
          id: "start",
          command: {
            kind: "start",
            attempt: {
              ...attempt(
                "[[env CLICKHOUSE_API_KEY]] [[env BASH_ENV]] [[env WORK_HTTP_LOGS]] [[env WORK_HTTP_LOGS_GRANT_FILE]] [[env DATA_PATH]]",
              ),
              envFiles,
            },
          },
        },
      ]);
      const frames: RunnerFrame[] = [];
      await readUntil({ channel, cursor: 0, frames, done: completed });
      await channel.kill();
      return events(frames)
        .flatMap((event) =>
          event.type === "item.started" &&
          event.item.kind === "assistant_message"
            ? [event.item.text]
            : [],
        )
        .join("\n");
    };
    await deliverSandboxSecrets({
      ...target,
      variables: {
        CLICKHOUSE_API_KEY: "ch-key-'one'",
        DATA_PATH: "/workspace/project/data",
      },
    });
    await configureSandboxGateway({
      provider,
      sandboxId: sandbox.id,
      gatewayGitUrl: "http://127.0.0.1:9/api/gateway/git",
      grants: [{ alias: "logs", grant: "grant-one" }],
      gitAliases: [],
      httpAliases: [
        { alias: "logs", url: "http://127.0.0.1:9/api/gateway/http/logs" },
      ],
    });
    const first = await run();
    expect(first).toContain("CLICKHOUSE_API_KEY=ch-key-'one'");
    // A value is passed as the secret holds it, even one that looks like
    // a path the provider maps.
    expect(first).toContain("DATA_PATH=/workspace/project/data");
    // The provider's virtual path, mapped where this sandbox really is.
    expect(first).toMatch(/BASH_ENV=\/.+\/\.work-session\/env\/secrets\.sh/);
    expect(first).not.toContain(`BASH_ENV=${envFile}`);
    expect(first).toContain(
      "WORK_HTTP_LOGS=http://127.0.0.1:9/api/gateway/http/logs",
    );
    // The grant file where code in this sandbox really finds it.
    const grantFile = /WORK_HTTP_LOGS_GRANT_FILE=(\S+)/.exec(first)?.[1] ?? "";
    expect(grantFile).toMatch(/\/\.work-session\/grants\/logs$/);
    expect(grantFile.startsWith(provider.workspaceRoot)).toBe(false);
    expect(fs.readFileSync(grantFile, "utf8")).toBe("grant-one");
    // Read again for the next attempt: gone once removed.
    await removeSandboxSecrets(target);
    const second = await run();
    expect(second).toContain("CLICKHOUSE_API_KEY is not set");
    expect(second).toMatch(/BASH_ENV=\/.+\/\.work-session\/env\/gateway\.sh/);
    expect(second).toContain("WORK_HTTP_LOGS=http://127.0.0.1:9");
    await removeSandboxGateway(target);
    const third = await run();
    expect(third).toContain("BASH_ENV is not set");
    expect(third).toContain("WORK_HTTP_LOGS is not set");
    expect(fs.existsSync(grantFile)).toBe(false);
  }, 60_000);
});
