import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Fastify from "fastify";
import { afterAll, describe, expect, it } from "vitest";
import {
  CLOUD_INIT_SCRIPT_PATH,
  installTargetProblem,
  registerInstallScriptRoute,
  workerCloudInit,
  workerInstallScript,
  workerUserData,
} from "../../registry/src/machines-install/machines-install.js";

/*
 * The `machines-install` recipe (ADR 0350): the install script and user
 * data a host's own code builds, which the server no longer generates.
 */

const root = fs.mkdtempSync(path.join(os.tmpdir(), "work-install-script-"));
afterAll(() => fs.rmSync(root, { recursive: true, force: true }));

const target = {
  controlPlaneUrl: "https://brain.example.com",
  image: "ghcr.io/example/work-worker:0.1.0-alpha.18",
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

/**
 * The machine's own commands, without the ones the script installs or
 * stubs: a runner image's real Docker must not stand in for the stub.
 */
const system = path.join(root, "system");
fs.mkdirSync(system);
for (const dir of ["/usr/bin", "/bin"]) {
  for (const name of fs.readdirSync(dir)) {
    if (/^(docker|dockerd|containerd|runsc)/.test(name)) continue;
    // The first directory wins, as on PATH; /bin is often /usr/bin.
    const link = path.join(system, name);
    if (!fs.lstatSync(link, { throwIfNoEntry: false }))
      fs.symlinkSync(path.join(dir, name), link);
  }
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
    /** The worker image is not on the machine. */
    withoutImage?: boolean;
    /** Another script than the default target's. */
    script?: string;
    /** Root's Docker configuration directory, for `--registry ecr`. */
    dockerConfig?: string;
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
        '  image) [ ! -f "$STUB_STATE/no-image" ] || exit 1 ;;',
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
    if (args.withoutImage)
      fs.writeFileSync(path.join(args.state, "no-image"), "");
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
    const file = args.script ?? write("run.sh", workerInstallScript(target));
    const result = spawnSync(shell, [file, ...args.argv], {
      encoding: "utf8",
      env: {
        PATH: `${stubs}:${system}`,
        STUB_LOG: log,
        STUB_STATE: args.state,
        FAKE_UID: String(args.uid ?? 0),
        ...(args.dockerConfig ? { DOCKER_CONFIG: args.dockerConfig } : {}),
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
      "--detach --name work-worker --restart unless-stopped --no-healthcheck",
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

  it("runs the backend --sandbox names: gVisor for container even with KVM", () => {
    const state = fs.mkdtempSync(path.join(root, "sandbox-"));
    const contained = run({
      argv: [
        "--code",
        "wke_x",
        "--data-dir",
        path.join(state, "data"),
        "--sandbox",
        "container",
      ],
      state,
    });
    expect(contained.stderr).toBe("");
    expect(contained.status).toBe(0);
    const runCall = contained.log.find((call) => call.startsWith("docker run"));
    expect(runCall).toContain("--env WORK_SANDBOX=container");
    expect(runCall).not.toContain("/dev/kvm");
    expect(contained.log).toContain(
      "runsc install -- --host-uds=open --net-raw",
    );
    const bogus = run({
      argv: ["--code", "wke_x", "--sandbox=vm"],
      state: fs.mkdtempSync(path.join(root, "sandbox-")),
    });
    expect(bogus.status).toBe(1);
    expect(bogus.stderr).toContain(
      "--sandbox is auto, microsandbox or container",
    );
    if (!usableKvm()) {
      const microVMs = run({
        argv: [
          "--code",
          "wke_x",
          "--data-dir",
          path.join(state, "vm"),
          "--sandbox",
          "microsandbox",
        ],
        state: fs.mkdtempSync(path.join(root, "sandbox-")),
      });
      expect(microVMs.status).toBe(1);
      expect(microVMs.stderr).toContain("needs a /dev/kvm");
      expect(microVMs.log.some((call) => call.startsWith("docker run"))).toBe(
        false,
      );
    }
  });

  it("pulls a private ECR image with the machine's own identity, through the credential helper", () => {
    const state = fs.mkdtempSync(path.join(root, "ecr-"));
    const dockerConfig = path.join(state, "root-docker");
    const dataDir = path.join(state, "data");
    const ecrTarget = {
      ...target,
      image: "111122223333.dkr.ecr.eu-west-1.amazonaws.com/work-worker:1.2.3",
    };
    const file = write("ecr.sh", workerInstallScript(ecrTarget));
    const first = run({
      argv: ["--code", "wke_x", "--data-dir", dataDir, "--registry", "ecr"],
      state,
      dockerConfig,
      script: file,
    });
    expect(first.status, first.stderr).toBe(0);
    // Without its recommended packages, which would bring a second Docker.
    expect(first.log).toContain(
      "apt-get -o DPkg::Lock::Timeout=300 install -y -qq --no-install-recommends amazon-ecr-credential-helper",
    );
    // Root's Docker configuration names the helper for the image's registry
    // alone, before the pull.
    expect(
      JSON.parse(
        fs.readFileSync(path.join(dockerConfig, "config.json"), "utf8"),
      ),
    ).toEqual({
      credHelpers: {
        "111122223333.dkr.ecr.eu-west-1.amazonaws.com": "ecr-login",
      },
    });
    const pull = first.log.findIndex((line) => line.startsWith("docker pull"));
    const helper = first.log.findIndex((line) =>
      line.includes("amazon-ecr-credential-helper"),
    );
    expect(helper).toBeGreaterThanOrEqual(0);
    expect(pull).toBeGreaterThan(helper);
    // A configuration someone else wrote is never overwritten.
    fs.writeFileSync(path.join(dockerConfig, "config.json"), "{}");
    const kept = run({
      argv: [
        "--code",
        "wke_x",
        "--data-dir",
        path.join(state, "data-2"),
        "--registry",
        "ecr",
      ],
      state,
      dockerConfig,
      script: file,
    });
    expect(kept.status).toBe(1);
    expect(kept.stderr).toContain("names no ecr-login helper");
    expect(
      run({
        argv: [
          "--code",
          "wke_x",
          "--data-dir",
          path.join(state, "data-3"),
          "--registry",
          "gcr",
        ],
        state,
      }).stderr,
    ).toContain("--registry is ecr");
  });

  it("runs a baked image's worker without pulling, and says when the image is not there", () => {
    const state = fs.mkdtempSync(path.join(root, "baked-"));
    const dataDir = path.join(state, "data");
    const baked = run({
      argv: ["--code", "wke_x", "--data-dir", dataDir, "--no-pull"],
      state,
    });
    expect(baked.status, baked.stderr).toBe(0);
    expect(baked.log.some((line) => line.startsWith("docker pull"))).toBe(
      false,
    );
    expect(baked.log.some((line) => line.startsWith("docker run"))).toBe(true);
    const missing = run({
      argv: [
        "--code",
        "wke_x",
        "--data-dir",
        path.join(state, "data-2"),
        "--no-pull",
      ],
      state: fs.mkdtempSync(path.join(root, "baked-missing-")),
      withoutImage: true,
    });
    expect(missing.status).toBe(1);
    expect(missing.stderr).toContain("is not on this machine");
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
    expect(
      workerCloudInit({ script, code: "wke_x", sandbox: "container" }),
    ).toContain(
      `  - ["sh", "${CLOUD_INIT_SCRIPT_PATH}", "--code", "wke_x", "--sandbox", "container"]`,
    );
    expect(
      workerCloudInit({ script, code: "wke_x", sandbox: "auto" }),
    ).toContain(`  - ["sh", "${CLOUD_INIT_SCRIPT_PATH}", "--code", "wke_x"]`);
    // Clouds bound user data (EC2 16 KiB before base64, Hetzner 32 KiB);
    // nothing is fetched to start.
    expect(Buffer.byteLength(userData)).toBeLessThan(32 * 1024);
    expect(userData).not.toContain("install.sh |");
  });

  it("builds a create's user data for a stock image, a private registry and a baked image", () => {
    const enrollment = {
      controlPlaneUrl: target.controlPlaneUrl,
      code: "wke_from-create",
    };
    const stock = workerUserData({ enrollment, image: target.image });
    const script = Buffer.from(
      stock
        .split("\n")
        .find((line) => line.startsWith("    content: "))
        ?.slice("    content: ".length) ?? "",
      "base64",
    ).toString();
    expect(script).toBe(workerInstallScript(target));
    expect(stock).toContain(
      `  - ["sh", "${CLOUD_INIT_SCRIPT_PATH}", "--code", "wke_from-create"]`,
    );
    // A private ECR image: the machine's instance profile reads it.
    expect(
      workerUserData({
        enrollment,
        image: target.image,
        registry: "ecr",
        sandbox: "container",
      }),
    ).toContain(
      `"--code", "wke_from-create", "--sandbox", "container", "--registry", "ecr"]`,
    );
    // A baked image holds the script and the worker image: the user data
    // only starts the worker, and stays small.
    const baked = workerUserData({
      enrollment,
      image: target.image,
      baked: true,
    });
    expect(baked).toBe(
      [
        "#cloud-config",
        "runcmd:",
        `  - ["sh", "${CLOUD_INIT_SCRIPT_PATH}", "--code", "wke_from-create", "--no-pull"]`,
        "",
      ].join("\n"),
    );
  });
});

describe("GET /api/workers/install.sh, mounted by a host", () => {
  it("serves the script, or says what the target is missing", async () => {
    const served = Fastify();
    registerInstallScriptRoute({ app: served, target });
    const ok = await served.inject({ url: "/api/workers/install.sh" });
    expect(ok.statusCode).toBe(200);
    expect(ok.headers["content-type"]).toContain("text/x-shellscript");
    expect(ok.body).toBe(workerInstallScript(target));

    const noImage = Fastify();
    registerInstallScriptRoute({
      app: noImage,
      target: { ...target, image: "" },
    });
    const missing = await noImage.inject({ url: "/api/workers/install.sh" });
    expect(missing.statusCode).toBe(503);
    expect(missing.body).toContain("worker image");

    expect(
      installTargetProblem({
        controlPlaneUrl: "http://127.0.0.1:4700",
        image: target.image,
      }),
    ).toContain("loopback");
    expect(installTargetProblem(target)).toBeUndefined();
    await Promise.all([served.close(), noImage.close()]);
  });
});
