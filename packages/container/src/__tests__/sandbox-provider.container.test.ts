import fs from "node:fs";
import http from "node:http";
import type net from "node:net";
import os from "node:os";
import path from "node:path";
import { RUNTIME_PROTOCOL_VERSION } from "@catamorphic/runtime";
import {
  dockerfileDigest,
  followProcess,
  machineSignInHome,
  volumeKey,
} from "@catamorphic/sandbox";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { DockerClient, dockerEndpoint } from "../docker-client.js";
import {
  type ContainerProviderConfig,
  ContainerSandboxProvider,
} from "../sandbox-provider.js";
import { type ContainerRuntime, probeContainerSupport } from "../support.js";

// Real containers: WORK_TEST_CONTAINER=1 with a Docker daemon, ideally with
// a `runsc` runtime registered with --host-uds=open --net-raw
// (scripts/test-in-docker.sh sets one up). WORK_TEST_CONTAINER_RUNTIME=runc
// runs the same tests under runc.
const enabled = process.env.WORK_TEST_CONTAINER === "1";
const IMAGE = process.env.WORK_TEST_CONTAINER_IMAGE ?? "oven/bun:1.3.14-alpine";
// Pinned, as every image these tests pull: an upstream release never
// changes a run.
const DIND_IMAGE = "docker:29.8.2-dind";
const NESTED_IMAGE = "alpine:3.22.2";
const MINUTES = 60_000;

describe.skipIf(!enabled)("container sandboxes (ADR 0204)", () => {
  const docker = new DockerClient(dockerEndpoint(process.env.DOCKER_HOST));
  let runtime: ContainerRuntime;
  let root: string;
  let server: http.Server;
  let other: http.Server;
  let port: number;
  let otherPort: number;
  /** An address of this machine the sandboxes' proxy can reach. */
  let hostIp: string;
  const sandboxes: Array<{ provider: ContainerSandboxProvider; id: string }> =
    [];

  const provider = (config?: Partial<ContainerProviderConfig>) =>
    new ContainerSandboxProvider({
      docker,
      runtime,
      stateDirectory: path.join(root, "state"),
      image: IMAGE,
      namePrefix: "work-test",
      privilegedContainers: true,
      ...config,
    });

  const created = async (
    sandboxProvider: ContainerSandboxProvider,
    opts: Parameters<ContainerSandboxProvider["createSandbox"]>[0] = {},
  ) => {
    const handle = await sandboxProvider.createSandbox(opts);
    sandboxes.push({ provider: sandboxProvider, id: handle.id });
    return handle.id;
  };

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
    root = fs.mkdtempSync(path.join(os.tmpdir(), "work-ctest-"));
    const serve = (text: string) =>
      http.createServer((request, response) =>
        response.end(`${text} ${request.url}`),
      );
    server = serve("allowed");
    other = serve("other");
    for (const listening of [server, other])
      await new Promise<void>((resolve) =>
        listening.listen(0, "0.0.0.0", () => resolve()),
      );
    port = portOf(server);
    otherPort = portOf(other);
    hostIp =
      Object.values(os.networkInterfaces())
        .flat()
        .find((entry) => entry?.family === "IPv4" && !entry.internal)
        ?.address ?? "";
    if (!hostIp) throw new Error("This machine has no external IPv4 address");
    if (!(await docker.inspectImage(IMAGE))) await docker.pullImage(IMAGE);
  }, 10 * MINUTES);

  // Each test's sandboxes go with it: a machine runs only a few at once.
  afterEach(async () => {
    for (const { provider: owner, id } of sandboxes.splice(0))
      await owner.destroySandbox(id).catch(() => {});
  }, 5 * MINUTES);

  afterAll(async () => {
    for (const listening of [server, other])
      await new Promise((resolve) => listening?.close(resolve));
    if (root) fs.rmSync(root, { recursive: true, force: true });
  }, 5 * MINUTES);

  it(
    "runs commands, moves files, and keeps the workspace across a restart",
    async () => {
      const sandboxProvider = provider();
      expect(sandboxProvider.isolation).toBe(
        runtime.kind === "runsc" ? "sandbox" : "process",
      );
      const id = await created(sandboxProvider);
      const ran = await sandboxProvider.executeCommand(
        id,
        'echo "$GREETING from $(pwd)"; echo warning >&2; exit 3',
        { env: { GREETING: "hello" }, cwd: "/workspace/sub" },
      );
      expect(ran.exitCode).toBe(3);
      expect(ran.result).toBe("hello from /workspace/sub\n\nwarning\n");
      const long = `${"deep/".repeat(30)}file.txt`;
      await sandboxProvider.uploadFiles(
        id,
        { "a.txt": "alpha", [long]: "long path", "src/ü.ts": "unicode" },
        "/workspace/project",
      );
      expect(
        await sandboxProvider.downloadFile(id, "/workspace/project/a.txt"),
      ).toBe("alpha");
      expect(
        await sandboxProvider.downloadFile(id, `/workspace/project/${long}`),
      ).toBe("long path");
      expect(
        await sandboxProvider.downloadFile(id, "/workspace/project/src/ü.ts"),
      ).toBe("unicode");
      await expect(
        sandboxProvider.downloadFile(id, "/workspace/missing"),
      ).rejects.toThrow("Reading /workspace/missing failed");
      // The default setup installed git and bash.
      const git = await sandboxProvider.executeCommand(id, "git --version");
      expect(git.exitCode, git.result).toBe(0);

      await sandboxProvider.stopSandbox(id);
      expect(await sandboxProvider.getSandboxStatus(id)).toBe("stopped");
      await sandboxProvider.startSandbox(id);
      expect(await sandboxProvider.getSandboxStatus(id)).toBe("started");
      expect(
        await sandboxProvider.downloadFile(id, "/workspace/project/a.txt"),
      ).toBe("alpha");
      await sandboxProvider.destroySandbox(id);
      await sandboxProvider.destroySandbox(id);
      await expect(sandboxProvider.getSandboxStatus(id)).rejects.toThrow(
        "does not exist",
      );
    },
    10 * MINUTES,
  );

  it(
    "stops a command's whole process tree on timeout and cancellation",
    async () => {
      const sandboxProvider = provider();
      const id = await created(sandboxProvider);
      const started = Date.now();
      const timedOut = await sandboxProvider.executeCommand(
        id,
        "sleep 300 & sleep 301; echo never",
        { timeout: 2 },
      );
      expect(timedOut.exitCode).toBe(124);
      expect(timedOut.result).not.toContain("never");
      const controller = new AbortController();
      setTimeout(() => controller.abort(), 1_000);
      const cancelled = await sandboxProvider.executeCommand(id, "sleep 302", {
        signal: controller.signal,
      });
      expect(cancelled.exitCode).toBe(130);
      const stopped = await sandboxProvider.executeCommand(
        id,
        "ps -o args | grep -c '[s]leep 30[012]' || true",
      );
      expect(stopped.result.trim()).toBe("0");
      // A command that leaves a child holding its output still returns.
      const detached = await sandboxProvider.executeCommand(
        id,
        "sleep 303 & echo started",
      );
      expect(detached.result).toBe("started\n");
      expect(Date.now() - started).toBeLessThan(60_000);
    },
    10 * MINUTES,
  );

  it(
    "runs background processes that outlive the command starting them",
    async () => {
      const sandboxProvider = provider();
      const id = await created(sandboxProvider);
      const processes = sandboxProvider.processes;
      const started = await processes.startProcess({
        sandboxId: id,
        command: "for i in 1 2 3; do echo line$i; sleep 0.2; done",
        name: "Counter",
      });
      const followed = await followProcess({
        processes,
        sandboxId: id,
        processId: started.processId,
        cursor: 0,
        timeoutMs: 60_000,
      });
      expect(followed.status).toBe("exited");
      expect(followed.exitCode).toBe(0);
      expect(followed.output).toBe("line1\nline2\nline3\n");
      const server = await processes.startProcess({
        sandboxId: id,
        command: "sleep 600",
      });
      expect(
        (await processes.listProcesses({ sandboxId: id })).find(
          (entry) => entry.processId === server.processId,
        )?.status,
      ).toBe("running");
      await processes.signalProcess({
        sandboxId: id,
        processId: server.processId,
        signal: "SIGKILL",
      });
    },
    10 * MINUTES,
  );

  it(
    "enforces CPU and memory limits and refuses disk limits",
    async () => {
      const sandboxProvider = provider({ setupCommand: "" });
      await expect(
        sandboxProvider.createSandbox({ resources: { storageMb: 1024 } }),
      ).rejects.toThrow("cannot limit a sandbox's disk");
      const id = await created(sandboxProvider, {
        resources: { cpuMillis: 500, memoryMb: 128 },
      });
      expect(await docker.inspectContainer(id)).toMatchObject({
        HostConfig: {
          NanoCpus: 500_000_000,
          Memory: 128 * 1024 * 1024,
          PidsLimit: 4096,
        },
      });
      // Within the limit a process runs; past it, the kernel kills it (the
      // whole sandbox under gVisor), and the sandbox serves the next command.
      const fits = await sandboxProvider.executeCommand(
        id,
        "bun -e 'const kept = Buffer.alloc(32 * 1024 * 1024, 1); console.log(kept.length)'",
      );
      expect(fits.result.trim()).toBe(String(32 * 1024 * 1024));
      const hog = await sandboxProvider.executeCommand(
        id,
        "bun -e 'const kept = []; for (;;) kept.push(Buffer.alloc(16 * 1024 * 1024, 1))'",
        { timeout: 120 },
      );
      expect(hog.exitCode, hog.result).toBe(137);
      const after = await sandboxProvider.executeCommand(id, "echo alive");
      expect(after.exitCode, after.result).toBe(0);
      expect(after.result.trim()).toBe("alive");
    },
    10 * MINUTES,
  );

  it(
    "reaches only allowlisted hosts, through the proxy",
    async () => {
      const sandboxProvider = provider({
        // The test image has no git; a restricted image must bring its own.
        setupCommand: "",
        lookup: async (host) =>
          host === "allowed.test" ? [{ address: hostIp, family: 4 }] : [],
      });
      expect(sandboxProvider.capabilities).toContain("network.policy");
      const id = await created(sandboxProvider, {
        egress: {
          mode: "allowlist",
          allow: [`${hostIp}:${port}`, `allowed.test:${port}`],
        },
      });
      const allowed = await sandboxProvider.executeCommand(
        id,
        `wget -q -T 10 -O- http://${hostIp}:${port}/by-ip`,
      );
      expect(allowed.result).toBe("allowed /by-ip");
      const named = await sandboxProvider.executeCommand(
        id,
        `wget -q -T 10 -O- http://allowed.test:${port}/by-name`,
      );
      expect(named.result).toBe("allowed /by-name");
      const viaBun = await sandboxProvider.executeCommand(
        id,
        `bun -e 'console.log(await (await fetch("http://${hostIp}:${port}/bun")).text())'`,
      );
      expect(viaBun.result.trim()).toBe("allowed /bun");
      const refused = await sandboxProvider.executeCommand(
        id,
        `wget -q -T 10 -O- http://${hostIp}:${otherPort}/`,
      );
      expect(refused.exitCode).not.toBe(0);
      expect(refused.result).not.toContain("other");
      const direct = await sandboxProvider.executeCommand(
        id,
        `wget -Y off -q -T 5 -O- http://${hostIp}:${port}/direct`,
      );
      expect(direct.exitCode).not.toBe(0);
      // The forwarder comes back with the sandbox.
      await sandboxProvider.stopSandbox(id);
      await sandboxProvider.startSandbox(id);
      const again = await sandboxProvider.executeCommand(
        id,
        `wget -q -T 10 -O- http://${hostIp}:${port}/again`,
      );
      expect(again.result).toBe("allowed /again");
      // A provider that never saw this sandbox (a restarted worker) serves
      // its proxy again; starting a running sandbox changes nothing.
      const restarted = provider({ setupCommand: "" });
      await restarted.startSandbox(id);
      const fresh = await restarted.executeCommand(
        id,
        `wget -q -T 10 -O- http://${hostIp}:${port}/restarted`,
      );
      expect(fresh.result).toBe("allowed /restarted");
      await restarted.destroySandbox(id);
    },
    10 * MINUTES,
  );

  it(
    "keeps open sandboxes from reaching each other",
    async () => {
      const sandboxProvider = provider();
      const first = await created(sandboxProvider);
      const second = await created(sandboxProvider);
      await sandboxProvider.processes.startProcess({
        sandboxId: first,
        command: `bun -e 'require("net").createServer((c) => c.end("neighbour")).listen(9000)'`,
      });
      const address = await docker
        .inspectContainer(first)
        .then((inspected) =>
          JSON.stringify(inspected?.NetworkSettings).match(
            /"IPAddress":"(\d+\.\d+\.\d+\.\d+)"/,
          ),
        );
      expect(address?.[1]).toBeTruthy();
      // The server answers inside its own sandbox...
      const own = await sandboxProvider.executeCommand(
        first,
        "for i in $(seq 1 50); do nc -w 2 127.0.0.1 9000 </dev/null && exit 0; sleep 0.2; done; exit 1",
      );
      expect(own.result).toContain("neighbour");
      // ...and not to the sandbox beside it, which still reaches outside.
      const neighbour = await sandboxProvider.executeCommand(
        second,
        `nc -w 3 ${address?.[1]} 9000 </dev/null`,
      );
      expect(neighbour.result).not.toContain("neighbour");
      const outside = await sandboxProvider.executeCommand(
        second,
        `wget -q -T 10 -O- http://${hostIp}:${port}/outside`,
      );
      expect(outside.result).toBe("allowed /outside");
    },
    10 * MINUTES,
  );

  it(
    "runs Docker inside the sandbox: containers, published ports, the proxy",
    async () => {
      const sandboxProvider = provider({ image: DIND_IMAGE });
      expect(sandboxProvider.capabilities).toContain("containers");
      const id = await created(sandboxProvider, { containers: true });
      const nested = await sandboxProvider.executeCommand(
        id,
        `docker run --rm ${NESTED_IMAGE} echo nested-ok`,
        { timeout: 300 },
      );
      expect(nested.result, nested.result).toContain("nested-ok");
      const published = await sandboxProvider.executeCommand(
        id,
        [
          `docker run -d -p 8080:80 ${NESTED_IMAGE} nc -lk -p 80 -e echo served >/dev/null`,
          "for i in $(seq 1 60); do nc -w 2 127.0.0.1 8080 </dev/null && exit 0; sleep 1; done; exit 1",
        ].join("\n"),
        { timeout: 300 },
      );
      expect(published.result, published.result).toContain("served");
      if (runtime.kind === "runsc") {
        // Nested containers under gVisor reach out only through the proxy.
        const out = await sandboxProvider.executeCommand(
          id,
          `docker run --rm ${NESTED_IMAGE} wget -q -T 10 -O- http://${hostIp}:${port}/nested`,
          { timeout: 300 },
        );
        expect(out.result, out.result).toContain("allowed /nested");
        // Its forwarders listen on loopback and the nested bridge only.
        const listening = await sandboxProvider.executeCommand(
          id,
          "netstat -ltn | grep ':3128 '",
        );
        expect(listening.result).toContain("127.0.0.1:3128");
        expect(listening.result).not.toMatch(/0\.0\.0\.0:3128|:::3128/);
      }
      await sandboxProvider.stopSandbox(id);
      await sandboxProvider.startSandbox(id);
      const again = await sandboxProvider.executeCommand(
        id,
        "docker info --format '{{.ServerVersion}}'",
        { timeout: 120 },
      );
      expect(again.exitCode, again.result).toBe(0);
    },
    20 * MINUTES,
  );

  it(
    "keeps volumes across sandboxes and gives a held one's sandbox a temporary one",
    async () => {
      const sandboxProvider = provider({ setupCommand: "" });
      expect(sandboxProvider.capabilities).toContain("volumes");
      const cache = volumeKey({ projectId: "p1", owner: "m1", name: "cache" });
      const data = volumeKey({ projectId: "p1", owner: "m1", name: "data" });
      const first = await created(sandboxProvider, {
        volumes: [
          { key: cache, path: "~/.cache/work" },
          { key: data, path: "/data/db", exclusive: true, sizeMb: 512 },
        ],
      });
      await sandboxProvider.executeCommand(
        first,
        "echo kept > ~/.cache/work/file && echo db > /data/db/file",
      );
      // A second sandbox while the first holds the exclusive volume.
      const second = await created(sandboxProvider, {
        volumes: [
          { key: cache, path: "~/.cache/work" },
          { key: data, path: "/data/db", temporary: true },
        ],
      });
      const seen = await sandboxProvider.executeCommand(
        second,
        "cat ~/.cache/work/file; ls -A /data/db | wc -l",
      );
      expect(seen.result).toBe("kept\n0\n");
      const mounts = (await docker.inspectContainer(second))?.Mounts;
      const temporary = (Array.isArray(mounts) ? mounts : [])
        .map((mount: unknown) =>
          typeof mount === "object" &&
          mount !== null &&
          Reflect.get(mount, "Destination") === "/data/db"
            ? String(Reflect.get(mount, "Name"))
            : undefined,
        )
        .find(Boolean);
      expect(temporary).toBeTruthy();
      await sandboxProvider.destroySandbox(second);
      expect(
        await docker.json({
          method: "GET",
          path: `/volumes/${temporary}`,
          accept: [404],
        }),
      ).toMatchObject({ status: 404 });
      await sandboxProvider.destroySandbox(first);
      const third = await created(sandboxProvider, {
        volumes: [{ key: data, path: "/data/db", exclusive: true }],
      });
      const db = await sandboxProvider.executeCommand(
        third,
        "cat /data/db/file",
      );
      expect(db.result).toBe("db\n");
      // Pruning keeps what a sandbox mounts and what was used lately.
      expect(
        await sandboxProvider.volumes.prune({ unusedForMs: MINUTES }),
      ).toEqual([]);
      expect(await sandboxProvider.volumes.prune({ unusedForMs: 0 })).toEqual([
        cache,
      ]);
      await sandboxProvider.destroySandbox(third);
      await sandboxProvider.volumes.removeAll();
      const left = await docker.listVolumes({ label: ["work.volume"] });
      expect(
        left.filter((volume) =>
          [cache, data].some((key) => String(volume.Name).endsWith(key)),
        ),
      ).toEqual([]);
    },
    10 * MINUTES,
  );

  it(
    "mounts members' own sign-ins from the machine and refuses missing ones",
    async () => {
      const signInRoot = path.join(root, "sign-ins");
      const home = machineSignInHome({
        root: signInRoot,
        harness: "claude-code",
        member: "member-1",
      });
      fs.mkdirSync(home, { recursive: true });
      fs.writeFileSync(path.join(home, "token.json"), "{}");
      const sandboxProvider = provider({ setupCommand: "", signInRoot });
      await expect(
        sandboxProvider.createSandbox({
          signIns: [{ harness: "codex", member: "member-1" }],
        }),
      ).rejects.toThrow("This machine has no codex sign-in for member-1");
      const id = await created(sandboxProvider, {
        signIns: [{ harness: "claude-code", member: "member-1" }],
      });
      const read = await sandboxProvider.executeCommand(
        id,
        "cat /workspace/.work-sign-in/claude-code/token.json && echo refreshed > /workspace/.work-sign-in/claude-code/refresh",
      );
      expect(read.result).toBe("{}");
      expect(fs.readFileSync(path.join(home, "refresh"), "utf8")).toBe(
        "refreshed\n",
      );
    },
    10 * MINUTES,
  );

  it(
    "runs a warm deployment runtime over the command's input and output",
    async () => {
      const sandboxProvider = provider();
      const id = await created(sandboxProvider);
      await sandboxProvider.uploadFiles(
        id,
        {
          "workflow.mjs": `export const greeter = {
  steps: [
    {
      run: async ({ input }) =>
        globalThis.__catamorphicRunStep(
          "greet-node",
          "Greet",
          async () => ({ message: \`hello \${input.name}\` }),
          input,
        ),
    },
  ],
};`,
        },
        "/workspace/project",
      );
      const identity = {
        deploymentArtifactId: "artifact-1",
        artifactDigest: "digest-1",
        transformVersion: "transform-1",
        runtimeVersion: "runtime-1",
      };
      const runtime = await sandboxProvider.deploymentRuntime.ensureRuntime({
        sandboxId: id,
        ...identity,
        workingDirectory: "/workspace/project",
        maxConcurrency: 1,
      });
      const receipt = await sandboxProvider.deploymentRuntime.invoke({
        runtimeId: runtime.runtimeId,
        protocolVersion: RUNTIME_PROTOCOL_VERSION,
        invocationId: "invocation-1",
        ...identity,
        kind: "durable-boundary",
        target: {
          modulePath: "workflow.mjs",
          exportName: "greeter",
          stepIndex: 0,
        },
        input: { value: { name: "Ada" } },
        attempt: 1,
        deadlineAt: new Date(Date.now() + 60_000).toISOString(),
      });
      expect(receipt.terminal).toMatchObject({
        status: "completed",
        result: { type: "completed", output: { message: "hello Ada" } },
      });
      // Releasing the sandbox stops its supervisor.
      await sandboxProvider.deploymentRuntime.releaseSandbox?.({
        sandboxId: id,
      });
      const left = await sandboxProvider.executeCommand(
        id,
        "ps -o args | grep -c '[e]ntry.mjs' || true",
      );
      expect(left.result.trim()).toBe("0");
    },
    10 * MINUTES,
  );

  it(
    "boots an image built from a project Dockerfile",
    async () => {
      const dockerfile = `FROM ${IMAGE}\nRUN echo built-${Date.now()} > /built\n`;
      const sandboxProvider = provider({ setupCommand: "" });
      expect(sandboxProvider.capabilities).toContain("images.build");
      const id = await created(sandboxProvider, {
        image: {
          kind: "dockerfile",
          path: ".work/images/test.Dockerfile",
          content: dockerfile,
          digest: dockerfileDigest(dockerfile),
        },
      });
      const built = await sandboxProvider.executeCommand(id, "cat /built");
      expect(built.result).toContain("built-");
    },
    10 * MINUTES,
  );
});

/** The TCP port a listening server took. */
function portOf(server: net.Server): number {
  const address = server.address();
  if (typeof address !== "object" || address === null)
    throw new Error("The server is not listening on TCP");
  return address.port;
}
