import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  machineSignInHome,
  parseSandboxPaths,
  signInHomePath,
  volumeKey,
} from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { LocalProcessSandboxProvider } from "../sandbox-provider.js";

describe("LocalProcessSandboxProvider", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-lp-test-"));
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("releases sandbox environments and stopped ids after repeated destruction", async () => {
    const isolatedRoot = fs.mkdtempSync(
      path.join(os.tmpdir(), "catamorphic-lp-cleanup-"),
    );
    const isolated = new LocalProcessSandboxProvider({ root: isolatedRoot });
    try {
      for (let i = 0; i < 100; i++) {
        const sandbox = await isolated.createSandbox({
          envVars: { TEST_PAYLOAD: String(i) },
        });
        await isolated.destroySandbox(sandbox.id);
        await isolated.destroySandbox(sandbox.id);
      }
      expect(fs.readdirSync(isolatedRoot)).toEqual([]);
      expect(Reflect.get(isolated, "sandboxes").size).toBe(0);
      expect(Reflect.get(isolated, "stopped").size).toBe(0);
    } finally {
      fs.rmSync(isolatedRoot, { recursive: true, force: true });
    }
  });

  it("keeps volumes under ~ across sandboxes and refuses other paths (ADR 0207)", async () => {
    const machine = new LocalProcessSandboxProvider({
      root: path.join(root, "volume-sandboxes"),
    });
    expect(machine.capabilities).toContain("volumes");
    const cache = volumeKey({ projectId: "p", owner: "m", name: "cache" });
    const scratch = volumeKey({ projectId: "p", owner: "m", name: "scratch" });
    await expect(
      machine.createSandbox({ volumes: [{ key: cache, path: "/var/cache" }] }),
    ).rejects.toThrow("only under ~");
    const first = await machine.createSandbox({
      volumes: [
        { key: cache, path: "~/.cache/tool" },
        { key: scratch, path: "~/scratch", temporary: true },
      ],
    });
    await machine.executeCommand(
      first.id,
      "echo kept > ~/.cache/tool/file && echo gone > ~/scratch/file",
    );
    // Removing the sandbox's directory never follows the link.
    await machine.destroySandbox(first.id);
    const second = await machine.createSandbox({
      volumes: [
        { key: cache, path: "~/.cache/tool" },
        { key: scratch, path: "~/scratch", temporary: true },
      ],
    });
    const seen = await machine.executeCommand(
      second.id,
      "cat ~/.cache/tool/file; ls -A ~/scratch | wc -l",
    );
    expect(seen.result.replace(/ +/g, "")).toBe("kept\n0\n");
    expect(await machine.volumes.prune({ unusedForMs: 0 })).toEqual([]);
    await machine.destroySandbox(second.id);
    expect(await machine.volumes.prune({ unusedForMs: 60_000 })).toEqual([]);
    expect(await machine.volumes.prune({ unusedForMs: 0 })).toEqual([cache]);
    const third = await machine.createSandbox({
      volumes: [{ key: cache, path: "~/.cache/tool" }],
    });
    const fresh = await machine.executeCommand(
      third.id,
      "ls -A ~/.cache/tool | wc -l",
    );
    expect(fresh.result.trim()).toBe("0");
    await expect(machine.volumes.removeAll()).rejects.toThrow(
      "still linked by sandboxes",
    );
    // A pooled machine's reset removes the sandboxes holding them too.
    await machine.volumes.removeAll({ destroySandboxes: true });
    expect(fs.existsSync(path.join(root, "volume-sandboxes", third.id))).toBe(
      false,
    );
    await machine.volumes.removeAll();
    expect(
      fs.readdirSync(path.join(root, "volume-sandboxes", ".volumes")),
    ).toEqual(["usage.json"]);
  });

  it("refuses nested volumes and leaves nothing behind when creation fails", async () => {
    const sandboxRoot = path.join(root, "nested-volume-sandboxes");
    const machine = new LocalProcessSandboxProvider({ root: sandboxRoot });
    const home = volumeKey({ projectId: "p", owner: "m", name: "home" });
    const cache = volumeKey({ projectId: "p", owner: "m", name: "cache" });
    await expect(
      machine.createSandbox({
        volumes: [
          { key: home, path: "~" },
          { key: cache, path: "~/.cache" },
        ],
      }),
    ).rejects.toThrow("are nested");
    // The whole home as a volume works, and works again.
    for (let round = 0; round < 2; round++) {
      const sandbox = await machine.createSandbox({
        volumes: [{ key: home, path: "~" }],
      });
      await machine.destroySandbox(sandbox.id);
    }
    // A sign-in that cannot be linked fails creation; its directory goes.
    const signInRoot = path.join(root, "broken-sign-ins");
    fs.mkdirSync(
      machineSignInHome({
        root: signInRoot,
        harness: "codex",
        member: "dana",
      }),
      { recursive: true },
    );
    const broken = new LocalProcessSandboxProvider({
      root: sandboxRoot,
      signInRoot,
      projectDataDirectory: async () => {
        throw new Error("no project data");
      },
    });
    await expect(
      broken.createSandbox({
        signIns: [{ harness: "codex", member: "dana" }],
        labels: { purpose: "deployment-runtime", projectId: "p" },
      }),
    ).rejects.toThrow("no project data");
    expect(
      fs.readdirSync(sandboxRoot).filter((name) => name.startsWith("local-")),
    ).toEqual([]);
  });

  it("links exactly the owner's sign-in home from the machine (ADR 0199)", async () => {
    const signInRoot = path.join(root, "sign-ins");
    const home = (member: string) =>
      machineSignInHome({ root: signInRoot, harness: "claude-code", member });
    for (const member of ["alice", "bob"]) {
      fs.mkdirSync(home(member), { recursive: true });
      fs.writeFileSync(path.join(home(member), "owner"), member);
    }
    const machine = new LocalProcessSandboxProvider({
      root: path.join(root, "sign-in-sandboxes"),
      signInRoot,
    });
    const sandbox = await machine.createSandbox({
      signIns: [{ harness: "claude-code", member: "alice" }],
    });
    const inside = signInHomePath({
      workspaceRoot: machine.workspaceRoot,
      harness: "claude-code",
    });
    const seen = await machine.executeCommand(
      sandbox.id,
      'cat .work-sign-in/claude-code/owner && echo && ls -A .work-sign-in && printf "%s" "$CATAMORPHIC_SANDBOX_PATHS"',
    );
    expect(seen.exitCode).toBe(0);
    const [owner, listed, paths] = seen.result.split("\n");
    expect(owner).toBe("alice");
    expect(listed).toBe("claude-code");
    // Processes learn where their virtual paths really are.
    const mapping = parseSandboxPaths(paths);
    expect(mapping?.virtual).toBe(machine.workspaceRoot);
    expect(
      fs.realpathSync(
        path.join(
          mapping?.real ?? "",
          path.posix.relative(machine.workspaceRoot, inside),
        ),
      ),
    ).toBe(fs.realpathSync(home("alice")));
    // The CLI refreshing its token writes to the machine's home.
    await machine.executeCommand(
      sandbox.id,
      "printf refreshed > .work-sign-in/claude-code/token",
    );
    expect(fs.readFileSync(path.join(home("alice"), "token"), "utf8")).toBe(
      "refreshed",
    );
    // Destroying the sandbox leaves the sign-in where it was made.
    await machine.destroySandbox(sandbox.id);
    expect(fs.readFileSync(path.join(home("alice"), "owner"), "utf8")).toBe(
      "alice",
    );

    await expect(
      machine.createSandbox({
        signIns: [{ harness: "codex", member: "alice" }],
      }),
    ).rejects.toThrow("work worker sign-in codex --member alice");
    await expect(
      new LocalProcessSandboxProvider({
        root: path.join(root, "no-sign-ins"),
      }).createSandbox({
        signIns: [{ harness: "claude-code", member: "alice" }],
      }),
    ).rejects.toThrow("keeps no members' sign-ins");
  });

  it("keeps project data across runtime replacement without exposing it to build sandboxes", async () => {
    const data = path.join(root, "project-data");
    fs.mkdirSync(data);
    const requests: string[] = [];
    const isolated = new LocalProcessSandboxProvider({
      root: path.join(root, "runtimes"),
      projectDataDirectory: async ({ projectId }) => {
        requests.push(projectId);
        return data;
      },
    });
    const first = await isolated.createSandbox({
      labels: { purpose: "deployment-runtime", projectId: "one" },
    });
    const written = await isolated.executeCommand(
      first.id,
      'printf saved > "$WORK_APP_DATA_DIR/items.txt"',
    );
    expect(written.exitCode).toBe(0);
    await isolated.destroySandbox(first.id);
    const next = await isolated.createSandbox({
      labels: { purpose: "deployment-runtime", projectId: "one" },
    });
    expect(
      (
        await isolated.executeCommand(
          next.id,
          'cat "$WORK_APP_DATA_DIR/items.txt"',
        )
      ).result,
    ).toBe("saved");
    await isolated.destroySandbox(next.id);
    const build = await isolated.createSandbox({
      labels: { purpose: "app-build", projectId: "one" },
    });
    expect(
      (
        await isolated.executeCommand(
          build.id,
          'printf "%s" "$WORK_APP_DATA_DIR"',
        )
      ).result,
    ).toBe("");
    await isolated.destroySandbox(build.id);
    expect(requests).toEqual(["one", "one"]);
  });

  it("rejects resource promises it cannot enforce", async () => {
    await expect(
      provider.createSandbox({ resources: { memoryMb: 512 } }),
    ).rejects.toThrow("cannot enforce");
  });

  it("stops process groups and requires restart before more commands", async () => {
    const sandbox = await provider.createSandbox({});
    const running = provider.executeCommand(sandbox.id, "sleep 30 & wait", {
      timeout: 60,
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    await provider.stopSandbox(sandbox.id);
    expect((await running).exitCode).not.toBe(0);
    await expect(
      provider.executeCommand(sandbox.id, "echo unsafe"),
    ).rejects.toThrow("stopped");
    await provider.startSandbox(sandbox.id);
    expect(
      (await provider.executeCommand(sandbox.id, "echo resumed")).result,
    ).toContain("resumed");
    await provider.destroySandbox(sandbox.id);
  });

  it("removes a sandbox whose deployment was made read-only", async () => {
    const sandbox = await provider.createSandbox({});
    await provider.executeCommand(
      sandbox.id,
      "mkdir -p deployment/nested && echo x > deployment/nested/file && chmod -R a-w deployment",
    );
    await provider.destroySandbox(sandbox.id);
    expect(await provider.getSandboxStatus(sandbox.id)).not.toBe("started");
    expect(
      fs.readdirSync(root).some((name) => name.startsWith(sandbox.id)),
    ).toBe(false);
  });

  it("round-trips files through virtual /workspace paths", async () => {
    const sandbox = await provider.createSandbox({});
    await provider.uploadFiles(
      sandbox.id,
      { "project/src/hello.ts": "export const hi = 1;\n" },
      "/workspace",
    );
    const content = await provider.downloadFile(
      sandbox.id,
      "/workspace/project/src/hello.ts",
    );
    expect(content).toBe("export const hi = 1;\n");
    // The real directory lives inside this sandbox's own root.
    expect(
      fs.existsSync(
        path.join(root, sandbox.id, "workspace", "project/src/hello.ts"),
      ),
    ).toBe(true);
  });

  it("never leaks the host process env into commands", async () => {
    process.env.CATAMORPHIC_TEST_HOST_SECRET = "leak-me";
    try {
      const sandbox = await provider.createSandbox({});
      const result = await provider.executeCommand(
        sandbox.id,
        'echo "host=[$CATAMORPHIC_TEST_HOST_SECRET] passed=[$EXPLICIT]"',
        { env: { EXPLICIT: "yes" } },
      );
      expect(result.exitCode).toBe(0);
      expect(result.result).toContain("host=[] passed=[yes]");
    } finally {
      delete process.env.CATAMORPHIC_TEST_HOST_SECRET;
    }
  });

  it("gives each sandbox its own HOME and applies create-time envVars", async () => {
    const sandbox = await provider.createSandbox({
      envVars: { SANDBOX_WIDE: "present" },
    });
    const result = await provider.executeCommand(
      sandbox.id,
      'echo "$HOME|$SANDBOX_WIDE"',
    );
    expect(result.result.trim()).toBe(
      `${path.join(root, sandbox.id, "home")}|present`,
    );
  });

  it("kills commands that exceed the timeout", async () => {
    const sandbox = await provider.createSandbox({});
    const started = Date.now();
    const result = await provider.executeCommand(sandbox.id, "sleep 30", {
      timeout: 1,
    });
    expect(Date.now() - started).toBeLessThan(10_000);
    expect(result.exitCode).toBe(124);
    expect(result.result).toContain("timed out");
  });

  it("maps the runtime sibling directory inside the sandbox", async () => {
    const sandbox = await provider.createSandbox({});
    await provider.uploadFiles(
      sandbox.id,
      { "entry.txt": "runtime" },
      "/workspace/project/../runtime",
    );
    expect(
      fs.readFileSync(
        path.join(root, sandbox.id, "workspace", "runtime", "entry.txt"),
        "utf-8",
      ),
    ).toBe("runtime");
  });

  it("contains traversal inside the sandbox and rejects relative paths", async () => {
    const sandbox = await provider.createSandbox({});
    // Absolute traversal normalizes within the virtual root: it can never
    // reach the host's /etc/passwd, only a (nonexistent) path inside the
    // sandbox directory.
    const error = await provider
      .downloadFile(sandbox.id, "/workspace/../../../etc/passwd")
      .then(() => null)
      .catch((e: unknown) => e as NodeJS.ErrnoException);
    expect(error?.code).toBe("ENOENT");
    expect(error?.message).toContain(path.join(root, sandbox.id));

    await expect(
      provider.downloadFile(sandbox.id, "../outside.txt"),
    ).rejects.toThrow(/must be absolute/);
  });

  it("destroys a sandbox's directory", async () => {
    const sandbox = await provider.createSandbox({});
    expect(await provider.getSandboxStatus(sandbox.id)).toBe("started");
    await provider.destroySandbox(sandbox.id);
    expect(await provider.getSandboxStatus(sandbox.id)).toBe("stopped");
  });

  it("never says a clone's credentials when it fails (ADR 0206)", async () => {
    const sandbox = await provider.createSandbox({});
    // Nothing listens on the discard port: the clone fails at once.
    const failure = await provider
      .gitClone(
        sandbox.id,
        "http://127.0.0.1:9/acme/app.git",
        "/workspace/app",
        {
          username: "x-access-token",
          password: "ghs_clone_secret",
        },
      )
      .catch((error: unknown) => error);
    expect(failure).toBeInstanceOf(Error);
    const message = failure instanceof Error ? failure.message : "";
    expect(message).toContain("git clone failed");
    expect(message).not.toContain("ghs_clone_secret");
    expect(message).not.toContain("x-access-token");
    await provider.destroySandbox(sandbox.id);
  });
});
