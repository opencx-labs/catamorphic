import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { LocalProcessSandboxProvider } from "@catamorphic/local-process";
import type { SandboxProvider } from "@catamorphic/sandbox";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { sandboxSecretsPrelude } from "../services/sandbox-secrets.js";
import {
  environmentSetupDue,
  parseSetupRecord,
  planWorkspaceSetup,
  runWorkspaceSetup,
  SETUP_PROCESS_NAME,
  SetupNetworkError,
  setupFingerprint,
  setupRecordAfter,
  workspaceSetupFailedNote,
  workspaceSetupNetworkRefusedNote,
  workspaceSetupScript,
  workspaceSetupUnavailableNote,
} from "../services/workspace-setup.js";

/*
 * Workspace setup (ADRs 0208, 0257): what runs when, the script that runs
 * it, and running it in a local-process sandbox, on its own network.
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
    const record = {
      environment: setupFingerprint(env),
      personal: "none",
      base: "none",
    };
    expect(parseSetupRecord(JSON.stringify(record))).toEqual(record);
    for (const text of [
      "",
      "{",
      "[]",
      '{"environment":1,"personal":"none","base":"none"}',
      // Written before records named their base: set up again.
      '{"environment":"none","personal":"none"}',
    ])
      expect(parseSetupRecord(text)).toBeNull();
  });

  it("runs a new workspace's setup once, and again when a command changes", () => {
    const first = planWorkspaceSetup({
      environment: env,
      personalAllowed: false,
      recorded: null,
    });
    expect(first).toEqual({
      record: {
        environment: setupFingerprint(env),
        personal: "none",
        base: "none",
      },
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

  it("runs the Environment's part again when the workspace's base moves", () => {
    const first = planWorkspaceSetup({
      environment: env,
      personal: mine,
      personalAllowed: true,
      base: "a".repeat(40),
      recorded: null,
    });
    expect(first?.record.base).toBe("a".repeat(40));
    const recorded = first?.record ?? null;
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: true,
        base: "a".repeat(40),
        recorded,
      }),
    ).toBeNull();
    expect(
      environmentSetupDue({ environment: env, base: "a".repeat(40), recorded }),
    ).toBe(false);
    // A review chat's next push: everything runs again on the new head.
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: true,
        base: "b".repeat(40),
        recorded,
      }),
    ).toEqual({
      record: { ...recorded, base: "b".repeat(40) },
      environment: env,
      personal: mine,
    });
    // Someone else's turn on the new head runs the Environment's part and
    // leaves the owner's to run again on their next turn.
    const moved = planWorkspaceSetup({
      environment: env,
      personal: mine,
      personalAllowed: false,
      base: "b".repeat(40),
      recorded,
    });
    expect(moved?.record.personal).toBe("none");
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: true,
        base: "b".repeat(40),
        recorded: moved?.record ?? null,
      }),
    ).toMatchObject({ personal: mine });
    expect(
      environmentSetupDue({ environment: env, base: "b".repeat(40), recorded }),
    ).toBe(true);
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
        base: "none",
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
      record: {
        environment: setupFingerprint(env),
        personal: "none",
        base: "none",
      },
      environment: env,
    });
    // The owner's next turn adds theirs alone: the Environment's is current.
    expect(
      planWorkspaceSetup({
        environment: env,
        personal: mine,
        personalAllowed: true,
        recorded: {
          environment: setupFingerprint(env),
          personal: "none",
          base: "none",
        },
      }),
    ).toEqual({
      record: {
        environment: setupFingerprint(env),
        personal: setupFingerprint(mine),
        base: "none",
      },
      personal: mine,
    });
  });

  it("records each part as it succeeds, the owner's still to run after the Environment's", () => {
    const plan = {
      record: {
        environment: setupFingerprint(env),
        personal: setupFingerprint(mine),
        base: "none",
      },
      environment: env,
      personal: mine,
    };
    expect(setupRecordAfter({ plan, part: "environment" })).toEqual({
      ...plan.record,
      personal: "none",
    });
    // Even with no owner's part to follow: theirs runs again on their turn.
    expect(
      setupRecordAfter({
        plan: { record: plan.record, environment: env },
        part: "environment",
      }),
    ).toEqual({ ...plan.record, personal: "none" });
    expect(setupRecordAfter({ plan, part: "personal" })).toEqual(plan.record);
    const environmentOnly = workspaceSetupScript({
      plan,
      parts: ["environment"],
    });
    expect(environmentOnly).toContain(`'Environment setup'`);
    expect(environmentOnly).not.toContain(`'Personal setup'`);
    expect(environmentOnly).toContain(
      JSON.stringify(setupRecordAfter({ plan, part: "environment" })),
    );
    expect(environmentOnly).not.toContain(JSON.stringify(plan.record));
    const both = workspaceSetupScript({ plan });
    expect(both.indexOf(`'Personal setup'`)).toBeLessThan(
      both.indexOf(JSON.stringify(plan.record)),
    );
  });

  it("writes a script that loads secrets, stops each part at its first failure, and records only success", () => {
    const script = workspaceSetupScript({
      plan: {
        record: {
          environment: setupFingerprint(env),
          personal: "none",
          base: "none",
        },
        environment: env,
      },
    });
    expect(script).toContain(sandboxSecretsPrelude());
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
    const refusals = (
      ["folder", "no-base", "sign-in", "not-admitted"] as const
    ).map((reason) => workspaceSetupNetworkRefusedNote({ reason }));
    for (const refusal of refusals) expect(refusal).toContain("setup.network");
    expect(refusals[1]).toContain("workspace: { ref }");
    for (const text of [note, timedOut, ...refusals])
      expect(text).not.toMatch(/[–—]/);
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
      base: "none",
    });
    // The workspace's base moved: it sets up again on the new one.
    expect(
      await runWorkspaceSetup({ ...setup, base: "c".repeat(40), onRun }),
    ).toEqual({ status: "succeeded" });
    expect(await read(id, "../runs")).toBe("ran in project\nran in project\n");
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
      { "secrets.sh": "export DEMO_TOKEN=from-secrets\n" },
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

describe("a setup on its own network (ADR 0257)", () => {
  let root: string;
  let machine: LocalProcessSandboxProvider;
  const projectDir = "/workspace/project";
  const wide = { mode: "allowlist" as const, allow: ["registry.npmjs.org"] };
  const network = { egress: wide, env: { SETUP_TOKEN: "named-secret" } };

  beforeAll(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), "catamorphic-setup-net-"));
    machine = new LocalProcessSandboxProvider({
      root,
      acceptUnenforcedEgress: true,
    });
  });

  afterAll(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  /**
   * The machine, with every widening and narrowing written into the
   * sandbox's `../order` beside what setup writes there, and stops
   * recorded.
   */
  const switching = (options?: { failNarrow?: boolean }) => {
    const widenings: Array<{ id: string; until: string; allow: string[] }> = [];
    const narrowed: string[] = [];
    const stopped: string[] = [];
    const provider = new Proxy(machine, {
      get(target, property) {
        if (property === "widenEgress")
          return async (args: {
            sandboxId: string;
            egress: { mode: "allowlist"; allow: string[] };
            id: string;
            until: string;
          }) => {
            widenings.push({
              id: args.id,
              until: args.until,
              allow: args.egress.allow,
            });
            await target.executeCommand(
              args.sandboxId,
              "echo wide >> ../order",
              {
                cwd: projectDir,
              },
            );
          };
        if (property === "narrowEgress")
          return async (args: { sandboxId: string; id: string }) => {
            if (options?.failNarrow)
              throw new Error("The machine did not answer");
            narrowed.push(args.id);
            await target.executeCommand(
              args.sandboxId,
              "echo narrow >> ../order",
              { cwd: projectDir },
            );
          };
        if (property === "stopSandbox")
          return async (sandboxId: string) => {
            stopped.push(sandboxId);
          };
        const value: unknown = Reflect.get(target, property, target);
        return typeof value === "function" ? value.bind(target) : value;
      },
    }) satisfies SandboxProvider;
    return { provider, widenings, narrowed, stopped };
  };
  const order = async (sandboxId: string) =>
    (
      await machine.executeCommand(sandboxId, "cat ../order 2>/dev/null", {
        cwd: projectDir,
      })
    ).result
      .split("\n")
      .filter(Boolean);

  it("runs the Environment's part alone, widened, with only the secrets it names", async () => {
    const { id } = await machine.createSandbox({});
    // Even a secrets file that should not be there is not loaded.
    await machine.uploadFiles(
      id,
      { "secrets.sh": "export OTHER_SECRET=from-file\n" },
      "/workspace/.work-session/env",
    );
    const { provider, widenings, narrowed } = switching();
    const before = Date.now();
    expect(
      await runWorkspaceSetup({
        provider,
        sandboxId: id,
        projectDir,
        environment: `echo "environment \${SETUP_TOKEN:-none} \${OTHER_SECRET:-none}" >> ../order`,
        personal: "echo personal >> ../order",
        personalAllowed: true,
        timeoutMinutes: 1,
        network,
      }),
    ).toEqual({ status: "succeeded" });
    // The owner's part is not this call's: it runs once the sandbox is narrow.
    expect(await order(id)).toEqual([
      "wide",
      "environment named-secret none",
      "narrow",
    ]);
    expect(widenings).toHaveLength(1);
    expect(widenings[0]?.allow).toEqual(["registry.npmjs.org"]);
    expect(narrowed).toEqual([widenings[0]?.id]);
    // The machine narrows by itself a minute after the setup's own time.
    const until = Date.parse(widenings[0]?.until ?? "");
    expect(until - before).toBeGreaterThanOrEqual(120_000);
    expect(until - Date.now()).toBeLessThanOrEqual(120_000);
    expect(
      parseSetupRecord(
        (
          await machine.executeCommand(id, "cat ../.work-session/setup.done", {
            cwd: projectDir,
          })
        ).result,
      ),
    ).toMatchObject({ personal: "none" });
  }, 30_000);

  it("narrows once the part ended however it ended: failed, timed out or stopped", async () => {
    const failing = await machine.createSandbox({});
    const failed = switching();
    expect(
      await runWorkspaceSetup({
        provider: failed.provider,
        sandboxId: failing.id,
        projectDir,
        environment: "echo environment >> ../order\nexit 3",
        personalAllowed: false,
        timeoutMinutes: 1,
        network,
      }),
    ).toMatchObject({
      status: "failed",
      exitCode: 3,
      parts: ["environment"],
    });
    expect(await order(failing.id)).toEqual(["wide", "environment", "narrow"]);

    const slow = await machine.createSandbox({});
    const timed = switching();
    expect(
      await runWorkspaceSetup({
        provider: timed.provider,
        sandboxId: slow.id,
        projectDir,
        environment: "sleep 30",
        personalAllowed: false,
        timeoutMinutes: 0.02,
        network,
      }),
    ).toMatchObject({ status: "failed", timedOut: true });
    expect(await order(slow.id)).toEqual(["wide", "narrow"]);

    const stopping = await machine.createSandbox({});
    const stopped = switching();
    const abort = new AbortController();
    expect(
      await runWorkspaceSetup({
        provider: stopped.provider,
        sandboxId: stopping.id,
        projectDir,
        environment: "sleep 30",
        personalAllowed: false,
        timeoutMinutes: 1,
        network,
        signal: abort.signal,
        onRun: async () => {
          setTimeout(() => abort.abort(), 200);
        },
      }),
    ).toEqual({ status: "aborted" });
    expect(await order(stopping.id)).toEqual(["wide", "narrow"]);
  }, 30_000);

  it("stops the sandbox and fails when it cannot be narrowed again", async () => {
    const { id } = await machine.createSandbox({});
    const { provider, stopped } = switching({ failNarrow: true });
    const ran = runWorkspaceSetup({
      provider,
      sandboxId: id,
      projectDir,
      environment: "echo environment >> ../order",
      personalAllowed: false,
      timeoutMinutes: 1,
      network,
    });
    await expect(ran).rejects.toBeInstanceOf(SetupNetworkError);
    await expect(ran).rejects.toThrow("The machine did not answer");
    expect(stopped).toEqual([id]);
    expect(await order(id)).toEqual(["wide", "environment"]);
  }, 30_000);

  it("never widens a sandbox in which a setup is already running", async () => {
    const { id } = await machine.createSandbox({});
    const earlier = new AbortController();
    void runWorkspaceSetup({
      provider: machine,
      sandboxId: id,
      projectDir,
      environment: "sleep 1; echo earlier >> ../order",
      personalAllowed: false,
      timeoutMinutes: 1,
      signal: earlier.signal,
    }).catch(() => {});
    const deadline = Date.now() + 10_000;
    while (
      !(await machine.processes.listProcesses({ sandboxId: id })).some(
        (process) => process.name === SETUP_PROCESS_NAME,
      )
    ) {
      if (Date.now() > deadline) throw new Error("The setup never started");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    const { provider, widenings } = switching();
    await expect(
      runWorkspaceSetup({
        provider,
        sandboxId: id,
        projectDir,
        environment: "echo later >> ../order",
        personalAllowed: false,
        timeoutMinutes: 1,
        network,
      }),
    ).rejects.toThrow("already running");
    expect(widenings).toEqual([]);
  }, 30_000);
});
