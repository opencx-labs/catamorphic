import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLOUD_INIT_SCRIPT_PATH,
  installTarget,
  registerInstallScriptRoute,
  workerCloudInit,
  workerInstallScript,
} from "./install-script.js";

const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-install-script-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const target = {
  controlPlaneUrl: "https://brain.example.com",
  image: "ghcr.io/opencx-labs/work-server:0.1.0-alpha.18",
};

/** A POSIX shell to run the script with: dash where present, else sh. */
const shell =
  ["/bin/dash", "/usr/bin/dash"].find((candidate) =>
    fs.existsSync(candidate),
  ) ?? "/bin/sh";

function onPath(command: string): string | undefined {
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, command);
    if (fs.existsSync(candidate)) return candidate;
  }
  return undefined;
}

function write(name: string, content: string): string {
  const file = path.join(root, name);
  fs.writeFileSync(file, content, { mode: 0o755 });
  return file;
}

describe("the worker install script", () => {
  it("is a POSIX sh script", () => {
    const file = write("install.sh", workerInstallScript(target));
    for (const candidate of new Set(["/bin/sh", shell])) {
      const checked = spawnSync(candidate, ["-n", file], { encoding: "utf8" });
      expect(checked.stderr).toBe("");
      expect(checked.status).toBe(0);
    }
    const shellcheck = onPath("shellcheck");
    if (shellcheck) {
      const linted = spawnSync(shellcheck, ["-s", "sh", file], {
        encoding: "utf8",
      });
      expect(linted.stdout).toBe("");
      expect(linted.status).toBe(0);
    }
  });

  it("bakes in the control plane and image, quoted whatever they hold", () => {
    const script = workerInstallScript({
      controlPlaneUrl: "https://brain.example.com/o'brien",
      image: target.image,
    });
    expect(script).toContain(
      "CONTROL_PLANE_URL='https://brain.example.com/o'\\''brien'",
    );
    expect(script).toContain(`IMAGE='${target.image}'`);
    const file = write("quoted.sh", script);
    expect(spawnSync(shell, ["-n", file]).status).toBe(0);
    // Work's gVisor arguments (ADR 0204), and no secret of any kind.
    expect(script).toContain("runsc install -- --host-uds=open --net-raw");
    expect(script).not.toMatch(/WORK_SECRET|DATABASE_URL|WORK_VAULT_KEY/);
  });

  /**
   * Runs the script with every system command it calls replaced by a stub
   * that records its arguments, as root on a machine that has Docker.
   */
  function run(args: {
    argv: string[];
    uid?: number;
    state: string;
    /** Docker is not installed yet: Docker's install script adds it. */
    withoutDocker?: boolean;
    /** apt's lock is held for this many checks. */
    aptBusy?: number;
  }): {
    status: number | null;
    stdout: string;
    stderr: string;
    log: string[];
  } {
    const stubs = path.join(args.state, "bin");
    fs.mkdirSync(stubs, { recursive: true });
    const log = path.join(args.state, "calls.log");
    const script = (name: string, body: string) =>
      `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\nexit 0\n`;
    const stub = (name: string, body = "") =>
      fs.writeFileSync(path.join(stubs, name), script(name, body), {
        mode: 0o755,
      });
    stub("id", 'echo "$FAKE_UID"');
    stub("stat", "echo 998");
    const docker = script(
      "docker",
      [
        'case "$1" in',
        `  info) echo '{"runc":{"path":"runc"},"runsc":{"path":"/usr/bin/runsc"}}' ;;`,
        '  container) [ -f "$STUB_STATE/container" ] || exit 1 ;;',
        '  rm) rm -f "$STUB_STATE/container" ;;',
        '  run) : > "$STUB_STATE/container" ;;',
        "esac",
      ].join("\n"),
    );
    fs.writeFileSync(path.join(args.state, "docker.stub"), docker, {
      mode: 0o755,
    });
    if (args.withoutDocker)
      fs.rmSync(path.join(stubs, "docker"), { force: true });
    else fs.writeFileSync(path.join(stubs, "docker"), docker, { mode: 0o755 });
    // Downloads write what the URL serves to the -o file; Docker's install
    // script installs the docker stub.
    stub(
      "curl",
      [
        'out=""',
        'while [ "$#" -gt 0 ]; do',
        '  if [ "$1" = "-o" ]; then out=$2; shift; fi',
        "  shift",
        "done",
        `printf '#!/bin/sh\\ncp "$STUB_STATE/docker.stub" "$STUB_STATE/bin/docker"\\n' > "$out"`,
      ].join("\n"),
    );
    fs.writeFileSync(
      path.join(args.state, "apt-busy"),
      String(args.aptBusy ?? 0),
    );
    stub(
      "fuser",
      [
        'n=$(cat "$STUB_STATE/apt-busy")',
        'if [ "$n" -gt 0 ]; then echo $((n - 1)) > "$STUB_STATE/apt-busy"; exit 0; fi',
        "exit 1",
      ].join("\n"),
    );
    for (const name of [
      "chown",
      "chmod",
      "runsc",
      "systemctl",
      "service",
      "apt-get",
      "gpg",
      "dpkg",
      "sleep",
    ])
      stub(name);
    const file = write("run.sh", workerInstallScript(target));
    const result = spawnSync(shell, [file, ...args.argv], {
      encoding: "utf8",
      env: {
        PATH: `${stubs}:/usr/bin:/bin`,
        STUB_LOG: log,
        STUB_STATE: args.state,
        FAKE_UID: String(args.uid ?? 0),
      },
    });
    return {
      status: result.status,
      stdout: result.stdout,
      stderr: result.stderr,
      log: fs.existsSync(log)
        ? fs.readFileSync(log, "utf8").trim().split("\n")
        : [],
    };
  }

  it("refuses to run without a code or as another user than root", () => {
    const state = fs.mkdtempSync(path.join(root, "refuse-"));
    const noCode = run({ argv: [], state });
    expect(noCode.status).toBe(1);
    expect(noCode.stderr).toContain("--code <code>");
    const notRoot = run({ argv: ["--code", "wke_x"], uid: 1000, state });
    expect(notRoot.status).toBe(1);
    expect(notRoot.stderr).toContain("as root");
    const unknown = run({ argv: ["--code", "wke_x", "--bogus"], state });
    expect(unknown.status).toBe(1);
    expect(unknown.stderr).toContain("Unknown option: --bogus");
    expect(notRoot.log.some((call) => call.startsWith("docker"))).toBe(false);
  });

  it("runs the worker image with the socket, its data directory and the right isolation, again and again", () => {
    const state = fs.mkdtempSync(path.join(root, "install-"));
    const dataDir = path.join(state, "data");
    const first = run({
      argv: ["--code", "wke_first", "--data-dir", dataDir],
      state,
    });
    expect(first.stderr).toBe("");
    expect(first.status).toBe(0);
    expect(fs.statSync(dataDir).isDirectory()).toBe(true);
    expect(first.log).toContain(`chown 1000:1000 ${dataDir}`);
    expect(first.log).toContain(`chmod 0700 ${dataDir}`);
    expect(first.log).toContain(`docker pull ${target.image}`);
    // Docker is present: nothing installs it.
    expect(first.log.some((call) => call.startsWith("curl"))).toBe(false);
    const kvm = usableKvm();
    const runCall = first.log.find((call) => call.startsWith("docker run"));
    expect(runCall).toBeDefined();
    for (const part of [
      "--detach --name work-worker --restart unless-stopped",
      `--volume ${dataDir}:${dataDir} --env WORK_DATA_DIR=${dataDir}`,
      "--volume /var/run/docker.sock:/var/run/docker.sock --group-add 998",
      `--env WORK_CONTROL_PLANE_URL=${target.controlPlaneUrl}`,
      "--env WORK_WORKER_ENROLLMENT=wke_first",
      "--env WORK_SANDBOX=auto",
      `${target.image} bun apps/server/src/worker.ts`,
    ])
      expect(runCall).toContain(part);
    if (kvm) {
      expect(runCall).toContain("--device /dev/kvm --group-add 998");
      expect(first.log.some((call) => call.startsWith("runsc"))).toBe(false);
    } else {
      expect(runCall).not.toContain("/dev/kvm");
      // runsc is present here; its runtime is registered with Work's
      // arguments, and Docker restarts only when that changed it.
      expect(first.log).toContain("runsc install -- --host-uds=open --net-raw");
    }
    expect(first.stdout).toContain("docker logs -f work-worker");

    // Again: the existing container is replaced, nothing else changes. The
    // data directory now exists, and it is a worker's.
    fs.writeFileSync(path.join(dataDir, "worker-credential"), "worker.x:s");
    const second = run({
      argv: ["--code=wke_first", "--data-dir", dataDir, "--name", "worker-b"],
      state,
    });
    expect(second.status).toBe(0);
    const calls = second.log.slice(first.log.length);
    expect(calls).toContain("docker rm -f worker-b");
    expect(calls.some((call) => call.startsWith("systemctl restart"))).toBe(
      false,
    );
    expect(calls.find((call) => call.startsWith("docker run"))).toContain(
      "--name worker-b",
    );
  });

  it("never takes a system directory, or someone else's, for its data", () => {
    const state = fs.mkdtempSync(path.join(root, "data-dir-"));
    const taken = path.join(state, "taken");
    fs.mkdirSync(taken);
    fs.writeFileSync(path.join(taken, "notes.txt"), "someone's files");
    for (const dataDir of [
      "/",
      "/etc",
      "/usr/local/work",
      "/var/lib",
      "/home",
      "/root/work",
      "relative/work",
      "/var/lib/../etc",
      taken,
    ]) {
      const refused = run({
        argv: ["--code", "wke_x", "--data-dir", dataDir],
        state,
      });
      expect(refused.status, dataDir).toBe(1);
      expect(refused.stderr).toContain("is not a place for the worker's data");
      expect(refused.log.some((call) => call.startsWith("chown"))).toBe(false);
    }
    // A new directory, with a trailing slash, is fine.
    const fresh = run({
      argv: ["--code", "wke_x", "--data-dir", `${path.join(state, "new")}/`],
      state,
    });
    expect(fresh.status).toBe(0);
    expect(fresh.log).toContain(`chown 1000:1000 ${path.join(state, "new")}`);
  });

  it("installs Docker from a downloaded, checked script, after waiting for apt", () => {
    const state = fs.mkdtempSync(path.join(root, "docker-"));
    const installed = run({
      argv: ["--code", "wke_x", "--data-dir", path.join(state, "data")],
      state,
      withoutDocker: true,
      aptBusy: 2,
    });
    expect(installed.stderr).toBe("");
    expect(installed.status).toBe(0);
    const download = installed.log.find((call) => call.startsWith("curl"));
    expect(download).toContain("https://get.docker.com -o ");
    expect(installed.stdout).toContain(
      "Waiting for another package installation to finish",
    );
    expect(installed.log.filter((call) => call.startsWith("sleep"))).toEqual([
      "sleep 10",
      "sleep 10",
    ]);
    // The script ran and Docker is there.
    expect(installed.log).toContain(`docker pull ${target.image}`);
  });

  it("gives up waiting for apt after ten minutes", () => {
    const state = fs.mkdtempSync(path.join(root, "apt-"));
    const stuck = run({
      argv: ["--code", "wke_x", "--data-dir", path.join(state, "data")],
      state,
      withoutDocker: true,
      aptBusy: 1_000,
    });
    expect(stuck.status).toBe(1);
    expect(stuck.stderr).toContain("held apt's lock for ten minutes");
    expect(stuck.log.filter((call) => call.startsWith("sleep"))).toHaveLength(
      60,
    );
  });
});

/** Whether this machine's /dev/kvm is usable, as the script checks it. */
function usableKvm(): boolean {
  try {
    if (!fs.statSync("/dev/kvm").isCharacterDevice()) return false;
    fs.accessSync("/dev/kvm", fs.constants.R_OK | fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

describe("cloud-init for cloud machines", () => {
  it("writes the script and runs it once with the machine's code", () => {
    const script = workerInstallScript(target);
    const userData = workerCloudInit({ script, code: "wke_abc-DEF_123" });
    const lines = userData.split("\n");
    expect(lines[0]).toBe("#cloud-config");
    expect(userData).toContain(`  - path: ${CLOUD_INIT_SCRIPT_PATH}`);
    expect(userData).toContain('    permissions: "0700"');
    const content = lines
      .find((line) => line.startsWith("    content: "))
      ?.slice("    content: ".length);
    expect(Buffer.from(content ?? "", "base64").toString()).toBe(script);
    expect(userData).toContain(
      `  - ["sh", "${CLOUD_INIT_SCRIPT_PATH}", "--code", "wke_abc-DEF_123"]`,
    );
    // Hetzner accepts user data up to 32 KiB; nothing is fetched to start.
    expect(Buffer.byteLength(userData)).toBeLessThan(32 * 1024);
    expect(userData).not.toContain("install.sh |");
  });
});

describe("GET /api/workers/install.sh", () => {
  it("serves the script, or says what the server is missing", async () => {
    const served = Fastify();
    registerInstallScriptRoute(
      served,
      installTarget({
        publicBase: target.controlPlaneUrl,
        workerImage: target.image,
      }),
    );
    const ok = await served.inject({ url: "/api/workers/install.sh" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/x-shellscript");
    expect(ok.body).toBe(workerInstallScript(target));

    const noImage = Fastify();
    registerInstallScriptRoute(
      noImage,
      installTarget({ publicBase: target.controlPlaneUrl }),
    );
    const missing = await noImage.inject({ url: "/api/workers/install.sh" });
    expect(missing.statusCode).toBe(503);
    expect(missing.body).toContain("WORK_WORKER_IMAGE");

    expect(
      installTarget({
        publicBase: "http://127.0.0.1:4700",
        workerImage: target.image,
      }),
    ).toEqual({ unavailable: expect.stringContaining("WORK_PUBLIC_URL") });
    await Promise.all([served.close(), noImage.close()]);
  });
});
