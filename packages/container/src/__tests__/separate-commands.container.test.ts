import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import {
  commandShellFiles,
  followProcess,
  SANDBOX_CAPABILITIES,
  SEPARATE_COMMANDS_SOCKET,
} from "@catamorphic/sandbox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DockerClient, dockerEndpoint } from "../docker-client.js";
import { ContainerSandboxProvider } from "../sandbox-provider.js";
import { type ContainerRuntime, probeContainerSupport } from "../support.js";

// Real containers, as sandbox-provider.container.test.ts: WORK_TEST_CONTAINER=1
// with a Docker daemon (scripts/test-in-docker.sh sets up gVisor).
const enabled = process.env.WORK_TEST_CONTAINER === "1";
const IMAGE =
  process.env.WORK_TEST_CONTAINER_IMAGE ??
  "oven/bun:1.4.4-alpine@sha256:4cf82f5686b196504fe119db3fcd9185b191f82ece82c40680e597228ec6070a";
const MINUTES = 60_000;
const PROJECT = "/workspace/project";
const SECRETS = "/workspace/.work-session/env/secrets.sh";
const SHIM = "/workspace/.work-session/commands";
const RETURNS = `${SHIM}/tmp`;

/**
 * A sandbox that runs an agent's commands apart from the agent (ADR 0332):
 * what the command side can and cannot reach, how its commands come back,
 * and that the pair lives and ends as one sandbox.
 */
describe.skipIf(!enabled)("commands apart from the agent (ADR 0332)", () => {
  const docker = new DockerClient(dockerEndpoint(process.env.DOCKER_HOST));
  let runtime: ContainerRuntime;
  let root: string;
  let server: http.Server;
  let other: http.Server;
  let hostIp: string;
  let provider: ContainerSandboxProvider;
  const sandboxes: string[] = [];

  beforeAll(async () => {
    const support = await probeContainerSupport(docker);
    if (!support.ok) throw new Error(support.reason);
    const wanted = process.env.WORK_TEST_CONTAINER_RUNTIME ?? "runsc";
    if (wanted === "runsc") {
      if (!support.runsc)
        throw new Error(
          "The daemon has no runsc runtime; run scripts/test-in-docker.sh, or set WORK_TEST_CONTAINER_RUNTIME=runc",
        );
      runtime = support.runsc;
    } else runtime = { kind: "runc", ...support.runc };
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-sep-"));
    const serve = (text: string) =>
      http.createServer((_request, response) => response.end(text));
    server = serve("gateway");
    other = serve("elsewhere");
    for (const listening of [server, other])
      await new Promise<void>((resolve) =>
        listening.listen(0, "0.0.0.0", () => resolve()),
      );
    hostIp =
      Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal)
        ?.address ?? "";
    if (!hostIp) throw new Error("This machine has no external IPv4 address");
    if (!(await docker.inspectImage(IMAGE))) await docker.pullImage(IMAGE);
    provider = new ContainerSandboxProvider({
      docker,
      runtime,
      stateDirectory: path.join(root, "state"),
      image: IMAGE,
      namePrefix: "work-sep",
      // Restricted sandboxes install nothing: the image has what they need.
      setupCommand: "",
    });
  }, 10 * MINUTES);

  afterEach(async () => {
    for (const id of sandboxes.splice(0))
      await provider.destroySandbox(id).catch(() => {});
  }, 5 * MINUTES);

  afterAll(async () => {
    for (const listening of [server, other])
      await new Promise((resolve) => listening?.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 5 * MINUTES);

  /** A separated sandbox reaching only the "gateway", with the shim on its agent side. */
  const separated = async (owner: ContainerSandboxProvider = provider) => {
    expect(owner.capabilities).toContain(SANDBOX_CAPABILITIES.separateCommands);
    const { id } = await owner.createSandbox({
      egress: { mode: "allowlist", allow: [`${hostIp}:${portOf(server)}`] },
      separateCommands: { shared: [PROJECT], envFiles: [SECRETS] },
    });
    sandboxes.push(id);
    const runtimePath = (
      await agent(id, "command -v bun || command -v node", undefined, owner)
    ).result.trim();
    const { files } = commandShellFiles({
      directory: SHIM,
      socket: SEPARATE_COMMANDS_SOCKET,
      runtime: runtimePath,
      returnFolder: RETURNS,
    });
    await owner.uploadFiles(
      id,
      Object.fromEntries(
        Object.entries(files).map(([file, { content }]) => [
          path.posix.relative(SHIM, file),
          content,
        ]),
      ),
      SHIM,
      { side: "agent" },
    );
    await agent(
      id,
      `chmod 700 ${SHIM}/bin/bash ${SHIM}/path/git && mkdir -p ${RETURNS}`,
      undefined,
      owner,
    );
    // What the agent side holds and its commands must not reach.
    await owner.uploadFiles(
      id,
      {
        "grants/model/1": "model-grant",
        "grants/github/1": "github-grant",
        "runner/state.json": '{"thread":"harness state"}',
      },
      "/workspace/.work-session",
      { side: "agent" },
    );
    await owner.uploadFiles(
      id,
      { "abc/skills/review.md": "trusted procedure" },
      "/workspace/.work-program",
      { side: "agent" },
    );
    // What the command side's own session folder holds for its commands.
    await owner.uploadFiles(
      id,
      { "env/secrets.sh": "export TEST_SECRET='for-tests'\n" },
      "/workspace/.work-session",
    );
    return id;
  };

  const agent = (
    id: string,
    command: string,
    env?: Record<string, string>,
    owner: ContainerSandboxProvider = provider,
  ) =>
    owner.executeCommand(id, command, {
      side: "agent",
      timeout: 120,
      ...(env ? { env } : {}),
    });

  /** A command as the agent's harness runs it: through its shell. */
  const throughShim = (
    id: string,
    script: string,
    env?: Record<string, string>,
  ) => agent(id, `cd ${PROJECT} && ${SHIM}/bin/bash -c ${quote(script)}`, env);

  it(
    "runs the agent's commands on the command side, which reaches nothing of the agent's",
    async () => {
      const id = await separated();
      // Output, errors and the exit code come back to the agent.
      const ran = await throughShim(id, "echo out; echo err >&2; exit 7");
      expect(ran.exitCode).toBe(7);
      expect(ran.result).toContain("out");
      expect(ran.result).toContain("err");
      // It ran on the command side: its own session files loaded, the
      // agent's grants, harness state and program absent.
      expect(
        (await throughShim(id, 'printf "%s" "$TEST_SECRET"')).result.trim(),
      ).toBe("for-tests");
      const looked = await throughShim(
        id,
        "for f in /workspace/.work-session/grants /workspace/.work-session/runner /workspace/.work-program /run/work-commands; do [ -e $f ] && echo found $f; done; echo looked",
      );
      expect(looked.result).not.toContain("found");
      expect(looked.result).toContain("looked");
      // The agent side still has them.
      expect(
        (await agent(id, "cat /workspace/.work-session/grants/model/1")).result,
      ).toBe("model-grant");
      // Work's variables and model keys stay with the agent.
      expect(
        (
          await throughShim(
            id,
            'echo "[$WORK_MODEL_API_KEY][$OPENAI_API_KEY][$OTHER][$TZ]"',
            {
              WORK_MODEL_API_KEY: "loopback",
              OPENAI_API_KEY: "loopback",
              OTHER: "from the agent",
              TZ: "Asia/Amman",
            },
          )
        ).result.trim(),
      ).toBe("[][][][Asia/Amman]");
    },
    10 * MINUTES,
  );

  it(
    "keeps the agent's loopback endpoints out of the command side's reach",
    async () => {
      const id = await separated();
      // The model and Work tool endpoints listen on the agent's loopback.
      const endpoint = await provider.processes.startProcess({
        sandboxId: id,
        side: "agent",
        command:
          'exec bun -e \'Bun.serve({ hostname: "127.0.0.1", port: 4555, fetch: () => new Response("agent endpoint") }); await new Promise(() => {})\'',
        name: "Agent endpoint",
      });
      expect(endpoint.processId).toMatch(/^proc-agent/);
      const probe =
        'bun -e \'fetch("http://127.0.0.1:4555").then(async (r) => console.log("reached " + (await r.text())), () => console.log("refused"))\'';
      await waitFor(async () =>
        (await agent(id, probe)).result.includes("reached agent endpoint"),
      );
      expect((await throughShim(id, probe)).result.trim()).toBe("refused");
      // The command side reaches what its policy admits (the gateway) and
      // nothing else; its own services are its own.
      const fetch = (url: string) =>
        `bun -e 'fetch(${JSON.stringify(url)}).then(async (r) => console.log(r.status + " " + (await r.text())), (e) => console.log("failed"))'`;
      expect(
        (await throughShim(id, fetch(`http://${hostIp}:${portOf(server)}/`)))
          .result,
      ).toContain("200 gateway");
      expect(
        (await throughShim(id, fetch(`http://${hostIp}:${portOf(other)}/`)))
          .result,
      ).not.toContain("elsewhere");
      const service = await provider.processes.startProcess({
        sandboxId: id,
        command:
          'exec bun -e \'Bun.serve({ hostname: "127.0.0.1", port: 4600, fetch: () => new Response("test service") }); await new Promise(() => {})\'',
        name: "Test service",
      });
      expect(service.processId).not.toMatch(/^proc-agent/);
      await waitFor(async () =>
        (
          await throughShim(
            id,
            'bun -e \'fetch("http://127.0.0.1:4600").then(async (r) => console.log(await r.text()), () => console.log("refused"))\'',
          )
        ).result.includes("test service"),
      );
      const listed = await provider.processes.listProcesses({ sandboxId: id });
      expect(listed.map((process) => process.name).sort()).toEqual([
        "Agent endpoint",
        "Test service",
      ]);
    },
    10 * MINUTES,
  );

  it(
    "shares only the checkout, and runs Work's own commands on the command side",
    async () => {
      const id = await separated();
      await agent(id, `echo from-agent > ${PROJECT}/agent.txt`);
      expect(
        (
          await provider.executeCommand(id, `cat ${PROJECT}/agent.txt`)
        ).result.trim(),
      ).toBe("from-agent");
      // Setup, exec and Work's Git name no side: they run with the commands.
      await provider.executeCommand(
        id,
        `echo setup > /workspace/.work-session/setup.log && echo from-setup > ${PROJECT}/setup.txt`,
      );
      expect((await agent(id, `cat ${PROJECT}/setup.txt`)).result.trim()).toBe(
        "from-setup",
      );
      expect(
        (
          await agent(
            id,
            "test -e /workspace/.work-session/setup.log && echo shared || echo apart",
          )
        ).result.trim(),
      ).toBe("apart");
      // Each side has its own temporary folder.
      await throughShim(id, "echo side > /tmp/marker");
      expect(
        (
          await agent(id, "test -e /tmp/marker && echo shared || echo apart")
        ).result.trim(),
      ).toBe("apart");
    },
    10 * MINUTES,
  );

  it(
    "brings back a file the command wrote in the shim's return folder",
    async () => {
      const id = await separated();
      const cwdFile = `${RETURNS}/claude-1a2b-cwd`;
      const ran = await agent(
        id,
        `mkdir -p ${PROJECT}/sub && cd ${PROJECT} && ${SHIM}/bin/bash -c ${quote(`cd sub && pwd -P >| ${cwdFile}`)} && cat ${cwdFile}`,
      );
      expect(ran.exitCode).toBe(0);
      expect(ran.result.trim()).toBe(`${PROJECT}/sub`);
    },
    10 * MINUTES,
  );

  it(
    "stops the command's whole group when the agent interrupts it or goes away",
    async () => {
      const id = await separated();
      for (const signal of ["SIGTERM", "SIGKILL"] as const) {
        const pidFile = `${PROJECT}/background-${signal}.pid`;
        const started = await provider.processes.startProcess({
          sandboxId: id,
          side: "agent",
          cwd: PROJECT,
          command: `exec ${SHIM}/bin/bash -c ${quote(`sleep 300 & echo $! > ${pidFile}; wait`)}`,
          name: `Interrupted ${signal}`,
        });
        await waitFor(async () =>
          /^\d+$/.test(
            (
              await provider.executeCommand(id, `cat ${pidFile} 2>/dev/null`)
            ).result.trim(),
          ),
        );
        const pid = (
          await provider.executeCommand(id, `cat ${pidFile}`)
        ).result.trim();
        expect(
          (
            await provider.executeCommand(id, `kill -0 ${pid} && echo alive`)
          ).result.trim(),
        ).toBe("alive");
        await provider.processes.signalProcess({
          sandboxId: id,
          processId: started.processId,
          signal,
        });
        await waitFor(async () =>
          (
            await provider.executeCommand(
              id,
              `kill -0 ${pid} 2>/dev/null && echo alive || echo gone`,
            )
          ).result.includes("gone"),
        );
        const ended = await followProcess({
          processes: provider.processes,
          sandboxId: id,
          processId: started.processId,
          cursor: 0,
          timeoutMs: 30_000,
        });
        expect(ended.status).toBe("exited");
      }
    },
    10 * MINUTES,
  );

  it(
    "runs every session's commands in the one command side it shares",
    async () => {
      const id = await separated();
      // Two runners (a chat and its shared subagent, ADR 0322) beside the agent.
      const first = await provider.processes.startProcess({
        sandboxId: id,
        side: "agent",
        cwd: PROJECT,
        command: `exec ${SHIM}/bin/bash -c ${quote("echo parent > /tmp/shared-marker; sleep 5")}`,
        name: "Parent runner",
      });
      await waitFor(async () =>
        (
          await throughShim(id, "cat /tmp/shared-marker 2>/dev/null || true")
        ).result.includes("parent"),
      );
      const child = await provider.processes.startProcess({
        sandboxId: id,
        side: "agent",
        cwd: PROJECT,
        command: `exec ${SHIM}/bin/bash -c ${quote("cat /tmp/shared-marker")}`,
        name: "Child runner",
      });
      const read = await followProcess({
        processes: provider.processes,
        sandboxId: id,
        processId: child.processId,
        cursor: 0,
        timeoutMs: 60_000,
      });
      expect(read.output.trim()).toBe("parent");
      await provider.processes.signalProcess({
        sandboxId: id,
        processId: first.processId,
        signal: "SIGKILL",
      });
    },
    10 * MINUTES,
  );

  it(
    "runs the agent side as a user that owns none of the checkout, which both sides still edit",
    async () => {
      const id = await separated();
      const agentUid = (await agent(id, "id -u")).result.trim();
      const commandUid = (
        await provider.executeCommand(id, "id -u")
      ).result.trim();
      expect(agentUid).toBe("10001");
      expect(agentUid).not.toBe(commandUid);
      // Work's own Git and the change's code make the checkout's files.
      await provider.executeCommand(
        id,
        `mkdir -p ${PROJECT}/src && echo one > ${PROJECT}/src/a.txt`,
      );
      const owners = await agent(
        id,
        `stat -c '%u %g %a' ${PROJECT} ${PROJECT}/src ${PROJECT}/src/a.txt`,
      );
      for (const line of owners.result.trim().split("\n")) {
        const [owner, group, mode] = line.split(" ");
        expect(owner).not.toBe(agentUid);
        expect(group).toBe("10001");
        // Group-writable: the agent edits through the shared group.
        expect(Number.parseInt(mode ?? "0", 8) & 0o020).toBe(0o020);
      }
      // The agent edits and adds files; the command side changes them.
      expect(
        (
          await agent(
            id,
            `echo two >> ${PROJECT}/src/a.txt && echo three > ${PROJECT}/src/b.txt && echo ok`,
          )
        ).result.trim(),
      ).toBe("ok");
      expect(
        (
          await provider.executeCommand(
            id,
            `echo four >> ${PROJECT}/src/b.txt && cat ${PROJECT}/src/a.txt ${PROJECT}/src/b.txt`,
          )
        ).result.trim(),
      ).toBe("one\ntwo\nthree\nfour");
      // Git beside the agent refuses a repository it does not own, so the
      // pull request's configuration names nothing it runs there.
      const hasGit = await provider.executeCommand(id, "command -v git");
      if (hasGit.exitCode === 0) {
        await provider.executeCommand(
          id,
          `cd ${PROJECT} && git init -q && git config core.fsmonitor 'touch /tmp/fsmonitor-ran'`,
        );
        const refused = await agent(id, `git -C ${PROJECT} status`);
        expect(refused.exitCode).not.toBe(0);
        expect(refused.result).toMatch(/dubious ownership/);
        expect(
          (
            await agent(
              id,
              "test -e /tmp/fsmonitor-ran && echo ran || echo not",
            )
          ).result.trim(),
        ).toBe("not");
      }
    },
    10 * MINUTES,
  );

  it(
    "stops a command that prints past its budget, with everything it started",
    async () => {
      const bounded = new ContainerSandboxProvider({
        docker,
        runtime,
        stateDirectory: path.join(root, "state"),
        image: IMAGE,
        namePrefix: "work-sep",
        setupCommand: "",
        separateCommandOutputBytes: 1024 * 1024,
      });
      const id = await separated(bounded);
      const ran = await agent(
        id,
        `cd ${PROJECT} && ${SHIM}/bin/bash -c ${quote("head -c 8000000 /dev/zero | tr '\\0' a; echo never")} | wc -c`,
        undefined,
        bounded,
      );
      const printed = Number(ran.result.trim().split("\n")[0]);
      expect(printed).toBeLessThan(2 * 1024 * 1024);
      expect(ran.result).not.toContain("never");
      // Within budget it runs as before.
      expect(
        (
          await agent(
            id,
            `cd ${PROJECT} && ${SHIM}/bin/bash -c 'echo fine'`,
            undefined,
            bounded,
          )
        ).result.trim(),
      ).toBe("fine");
      await bounded.destroySandbox(id);
    },
    10 * MINUTES,
  );

  it(
    "limits the command side as the Environment says and the agent side to its own share",
    async () => {
      const { id } = await provider.createSandbox({
        resources: { cpuMillis: 2000, memoryMb: 1536 },
        separateCommands: {
          shared: [PROJECT],
          agentResources: { cpuMillis: 500, memoryMb: 768 },
        },
      });
      sandboxes.push(id);
      const limits = async (name: string) => {
        const host = (await docker.inspectContainer(name))?.HostConfig as
          | { NanoCpus?: number; Memory?: number }
          | undefined;
        return [host?.NanoCpus, host?.Memory];
      };
      expect(await limits(id)).toEqual([2000 * 1_000_000, 1536 * 1024 * 1024]);
      expect(await limits(`${id}-agent`)).toEqual([
        500 * 1_000_000,
        768 * 1024 * 1024,
      ]);
    },
    10 * MINUTES,
  );

  it(
    "starts, stops and ends both sides as one sandbox",
    async () => {
      const id = await separated();
      await agent(id, `echo kept > ${PROJECT}/kept.txt`);
      const both = async () =>
        Promise.all(
          [id, `${id}-agent`].map(async (name) => {
            const inspected = await docker.inspectContainer(name);
            return inspected
              ? Boolean(
                  (inspected.State as { Running?: boolean } | undefined)
                    ?.Running,
                )
              : undefined;
          }),
        );
      expect(await both()).toEqual([true, true]);
      // Idle release stops both; the next turn starts both, the socket
      // served again and the checkout kept.
      await provider.stopSandbox(id);
      expect(await both()).toEqual([false, false]);
      expect(await provider.getSandboxStatus(id)).toBe("stopped");
      await provider.startSandbox(id);
      expect(await both()).toEqual([true, true]);
      expect(await provider.getSandboxStatus(id)).toBe("started");
      expect(
        (await throughShim(id, `cat ${PROJECT}/kept.txt`)).result.trim(),
      ).toBe("kept");
      // One side stopped behind Work's back: the sandbox reads stopped and
      // starts whole.
      await docker.stopContainer(`${id}-agent`, 1);
      expect(await provider.getSandboxStatus(id)).toBe("stopped");
      await provider.startSandbox(id);
      expect((await throughShim(id, "echo again")).result.trim()).toBe("again");
      // A rebuild destroys it: both containers and what they shared go.
      await provider.destroySandbox(id);
      expect(await both()).toEqual([undefined, undefined]);
      const shared = await docker.listVolumes({ label: [`work.shared=${id}`] });
      expect(shared).toEqual([]);
    },
    10 * MINUTES,
  );
});

function portOf(server: http.Server): number {
  return (server.address() as net.AddressInfo).port;
}

function quote(value: string): string {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function waitFor(
  check: () => Promise<boolean>,
  timeoutMs = 60_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (await check()) return;
    if (Date.now() > deadline) throw new Error("Timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}
