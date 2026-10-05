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
    // Work's gVisor arguments (ADR 0203), and no secret of any kind.
    expect(script).toContain("runsc install -- --host-uds=open --net-raw");
    expect(script).not.toMatch(/WORK_SECRET|DATABASE_URL|WORK_VAULT_KEY/);
  });

  /**
   * Runs the script with every system command it calls replaced by a stub
   * that records its arguments, as root on a machine that has Docker.
   */
  function run(args: { argv: string[]; uid?: number; state: string }): {
    status: number | null;
    stdout: string;
    stderr: string;
    log: string[];
  } {
    const stubs = path.join(args.state, "bin");
    fs.mkdirSync(stubs, { recursive: true });
    const log = path.join(args.state, "calls.log");
    const stub = (name: string, body = "") =>
      fs.writeFileSync(
        path.join(stubs, name),
        `#!/bin/sh\necho "${name} $*" >> "$STUB_LOG"\n${body}\nexit 0\n`,
        { mode: 0o755 },
      );
    stub("id", 'echo "$FAKE_UID"');
    stub("stat", "echo 998");
    stub(
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
    for (const name of [
      "chown",
      "chmod",
      "runsc",
      "systemctl",
      "service",
      "curl",
      "apt-get",
      "gpg",
      "dpkg",
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

    // Again: the existing container is replaced, nothing else changes.
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
