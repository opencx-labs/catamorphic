import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  parseSetupRecord,
  planWorkspaceSetup,
  runWorkspaceSetup,
  SETUP_PROCESS_NAME,
  setupFingerprint,
  workspaceSetupFailedNote,
  workspaceSetupScript,
  workspaceSetupUnavailableNote,
} from "../services/workspace-setup.js";

/*
 * Workspace setup (ADR 0207): what runs when, the script that runs it, and
 * running it in a local-process sandbox.
 */

describe("planning a workspace's setup", () => {
  const env = "pnpm install --frozen-lockfile";
  const mine = "mise install";

  it("fingerprints commands, and none without one", () => {
    expect(setupFingerprint(env)).toMatch(/^sha256:[0-9a-f]{64}$/);
    expect(setupFingerprint(env)).toBe(setupFingerprint(env));
    expect(setupFingerprint(`${env} `)).not.toBe(setupFingerprint(env));
    expect(setupFingerprint(undefined)).toBe("none");
    expect(setupFingerprint("  \n")).toBe("none");
  });

  it("reads back only what a setup wrote", () => {
    const record = { environment: setupFingerprint(env), personal: "none" };
    expect(parseSetupRecord(JSON.stringify(record))).toEqual(record);
    for (const text of ["", "{", "[]", '{"environment":1,"personal":"none"}'])
      expect(parseSetupRecord(text)).toBeNull();
  });

  it("runs a new workspace's setup once, and again when a command changes", () => {
    const first = planWorkspaceSetup({
      environment: env,
      personalAllowed: false,
      recorded: null,
    });
    expect(first).toEqual({
      record: { environment: setupFingerprint(env), personal: "none" },
      environment: env,
    });
    expect(
      planWorkspaceSetup({
        environment: env,
        personalAllowed: false,
        recorded: first?.record ?? null,
      }),
    ).toBeNull();
    expect(
      planWorkspaceSetup({
        environment: `${env} --prefer-offline`,
        personalAllowed: false,
        recorded: first?.record ?? null,
      }),
    ).toMatchObject({ environment: `${env} --prefer-offline` });
  });

  it("adds the owner's own setup only where it may run, and never reruns for its absence", () => {
    const both = planWorkspaceSetup({
      environment: env,
      personal: mine,
      personalAllowed: true,
      recorded: null,
    });
    expect(both).toEqual({
      record: {
        environment: setupFingerprint(env),
        personal: setupFingerprint(mine),
      },
      environment: env,
      personal: mine,
    });
    // Someone else's turn keeps what the owner's turn set up.
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: false,
        recorded: both?.record ?? null,
      }),
    ).toBeNull();
    // And never runs the owner's setup itself.
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: false,
        recorded: null,
      }),
    ).toEqual({
      record: { environment: setupFingerprint(env), personal: "none" },
      environment: env,
    });
    // The owner's next turn adds it.
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: true,
        recorded: { environment: setupFingerprint(env), personal: "none" },
      }),
    ).toMatchObject({ environment: env, personal: mine });
  });

  it("writes a script that loads secrets, stops each part at its first failure, and records only success", () => {
    const script = workspaceSetupScript({
      plan: {
        record: { environment: setupFingerprint(env), personal: "none" },
        environment: env,
      },
    });
    expect(script).toContain('if [ -f "$work_session/env/secrets.sh" ]; then');
    expect(script).toContain('bash -e "$2"');
    expect(script).toContain(`'Environment setup'`);
    expect(script).not.toContain(`'Personal setup'`);
    expect(script).toContain('rm -f "$work_session/setup/personal.sh"');
    expect(script.indexOf("work_part ")).toBeLessThan(
      script.indexOf("setup.done.next"),
    );
  });

  it("tells the agent what failed, where it is set, and the end of the log", () => {
    const note = workspaceSetupFailedNote({
      outcome: {
        status: "failed",
        exitCode: 3,
        timedOut: false,
        log: "installing\nboom\n",
        parts: ["environment", "personal"],
      },
      timeoutMinutes: 30,
      logPath: "/workspace/.work-session/setup.log",
    });
    expect(note).toContain("failed with exit code 3");
    expect(note).toContain("runs again before the next turn");
    expect(note).toContain(".work/project.json");
    expect(note).toContain(".work/personal/environment.json");
    expect(note).toContain("boom");
    expect(note).toContain("The commands are");
    const timedOut = workspaceSetupFailedNote({
      outcome: {
        status: "failed",
        exitCode: null,
        timedOut: true,
        log: "",
        parts: ["environment"],
      },
      timeoutMinutes: 1,
      logPath: "/workspace/.work-session/setup.log",
    });
    expect(timedOut).toContain(
      "did not finish within 1 minute and was stopped",
    );
    expect(timedOut).toContain("The command is the Environment's `setup`");
    expect(timedOut).toContain(
      "Its output is in /workspace/.work-session/setup.log",
    );
    expect(
      workspaceSetupUnavailableNote({ reason: "The machine did not answer" }),
    ).toBe(
      "[Workspace] Setting up this workspace could not run (The machine did not answer), so what it installs may be missing. It runs again before the next turn.",
    );
    for (const text of [note, timedOut]) expect(text).not.toMatch(/[–—]/);
  });
});

describe("running a workspace's setup", () => {
  let root: string;
  let provider: LocalProcessSandboxProvider;
  const projectDir = "/workspace/project";
  const read = async (sandboxId: string, file: string) =>
    (
      await provider.executeCommand(sandboxId, `cat ${file} 2>/dev/null`, {
        cwd: projectDir,
      })
    ).result;

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-setup-"));
    provider = new LocalProcessSandboxProvider({ root });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it("runs once per workspace, in the project folder, logging to the session directory", async () => {
    const { id } = await provider.createSandbox({});
    const setup = {
      provider,
      sandboxId: id,
      projectDir,
      environment: 'echo "ran in $(basename "$PWD")" >> ../runs',
      personalAllowed: false,
      timeoutMinutes: 1,
    };
    const shown: string[] = [];
    const onRun = async () => {
      shown.push("shown");
    };
    expect(await runWorkspaceSetup({ ...setup, onRun })).toEqual({
      status: "succeeded",
    });
    expect(await runWorkspaceSetup({ ...setup, onRun })).toEqual({
      status: "current",
    });
    expect(shown).toEqual(["shown"]);
    expect(await read(id, "../runs")).toBe("ran in project\n");
    expect(await read(id, "../.work-session/setup.log")).toContain(
      "== Workspace setup finished",
    );
    expect(
      parseSetupRecord(await read(id, "../.work-session/setup.done")),
    ).toEqual({
      environment: setupFingerprint(setup.environment),
      personal: "none",
    });
  }, 30_000);

  it("stops a part at its first failing command and does not record it", async () => {
    const { id } = await provider.createSandbox({});
    const outcome = await runWorkspaceSetup({
      provider,
      sandboxId: id,
      projectDir,
      environment: "echo before\nfalse\necho after",
      personalAllowed: false,
      timeoutMinutes: 1,
    });
    expect(outcome).toMatchObject({ status: "failed", exitCode: 1 });
    if (outcome.status !== "failed") throw new Error("unreachable");
    expect(outcome.log).toContain("before");
    expect(outcome.log).not.toContain("after");
    expect(outcome.log).toContain("Environment setup failed with exit code 1");
    expect(await read(id, "../.work-session/setup.done")).toBe("");
  }, 30_000);

  it("loads the session's secrets for every part, and runs the owner's part after the Environment's", async () => {
    const { id } = await provider.createSandbox({});
    await provider.uploadFiles(
      id,
      { "secrets.sh": "DEMO_TOKEN=from-secrets\n" },
      "/workspace/.work-session/env",
    );
    expect(
      await runWorkspaceSetup({
        provider,
        sandboxId: id,
        projectDir,
        environment: "sh -c 'echo \"env $DEMO_TOKEN\"' >> ../order",
        personal: "sh -c 'echo \"mine $DEMO_TOKEN\"' >> ../order",
        personalAllowed: true,
        timeoutMinutes: 1,
      }),
    ).toEqual({ status: "succeeded" });
    expect(await read(id, "../order")).toBe(
      "env from-secrets\nmine from-secrets\n",
    );
  }, 30_000);

  it("runs in the foreground where the provider has no background processes", async () => {
    const { id } = await provider.createSandbox({});
    const foreground = new Proxy(provider, {
      get(target, property) {
        if (property === "processes") return undefined;
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) satisfies SandboxProvider;
    expect(
      await runWorkspaceSetup({
        provider: foreground,
        sandboxId: id,
        projectDir,
        environment: "echo foreground > ../where",
        personalAllowed: false,
        timeoutMinutes: 1,
      }),
    ).toEqual({ status: "succeeded" });
    expect(await read(id, "../where")).toBe("foreground\n");
  }, 30_000);

  it("stops the setup when the turn stops", async () => {
    const { id } = await provider.createSandbox({});
    const abort = new AbortController();
    const started = runWorkspaceSetup({
      provider,
      sandboxId: id,
      projectDir,
      environment: "sleep 30",
      personalAllowed: false,
      timeoutMinutes: 1,
      signal: abort.signal,
      onRun: async () => {
        setTimeout(() => abort.abort(), 200);
      },
    });
    expect(await started).toEqual({ status: "aborted" });
    const deadline = Date.now() + 10_000;
    for (;;) {
      const listed = await provider.processes.listProcesses({ sandboxId: id });
      const setup = listed.find(
        (process) => process.name === SETUP_PROCESS_NAME,
      );
      if (setup?.status === "exited") break;
      if (Date.now() > deadline) throw new Error("The setup kept running");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }, 30_000);

  it("waits for a setup an interrupted preparation started instead of starting another", async () => {
    const { id } = await provider.createSandbox({});
    const environment = "sleep 1; echo once >> ../count";
    const first = new AbortController();
    // The first preparation goes away without stopping its setup.
    void runWorkspaceSetup({
      provider,
      sandboxId: id,
      projectDir,
      environment,
      personalAllowed: false,
      timeoutMinutes: 1,
      signal: first.signal,
    }).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (
      !(await provider.processes.listProcesses({ sandboxId: id })).some(
        (process) => process.name === SETUP_PROCESS_NAME,
      )
    ) {
      if (Date.now() > deadline) throw new Error("The setup never started");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(
      await runWorkspaceSetup({
        provider,
        sandboxId: id,
        projectDir,
        environment,
        personalAllowed: false,
        timeoutMinutes: 1,
      }),
    ).toEqual({ status: "current" });
    expect(await read(id, "../count")).toBe("once\n");
  }, 30_000);
});
