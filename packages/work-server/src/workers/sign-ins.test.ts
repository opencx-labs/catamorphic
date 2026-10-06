import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  codexCommand,
  listMachineSignIns,
  signInCapabilities,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "./sign-ins.js";

/**
 * Members' sign-ins on a machine (ADR 0199): the harness's own login, run
 * in the operator's terminal, into one member's home on this machine's
 * disk. The machine reports who is signed in to what, never a value.
 */
describe("sign-ins on a machine", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-sign-ins-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  /** A stand-in for Codex's login: records what it was run with. */
  const login = (input: { status: number; writes?: string }) => {
    const runs: Array<{ args: string[]; home?: string }> = [];
    return {
      runs,
      spawn: (
        _command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const home = options.env.CODEX_HOME;
        runs.push({ args, ...(home ? { home } : {}) });
        if (home && input.writes)
          fs.writeFileSync(path.join(home, input.writes), "{}");
        return { status: input.status, error: undefined };
      },
    };
  };

  it("runs Codex's own login into the member's home, and reports only the fact", () => {
    const codex = login({ status: 0, writes: "auth.json" });
    const { home, exitCode } = signInOnMachine({
      dataDir,
      harness: "codex",
      member: "user|alice",
      args: ["--device-auth"],
      spawn: codex.spawn,
    });
    expect(exitCode).toBe(0);
    // The login runs beside the home, which it becomes once it completed.
    expect(codex.runs).toHaveLength(1);
    expect(codex.runs[0]?.args.slice(-2)).toEqual(["login", "--device-auth"]);
    expect(codex.runs[0]?.home).not.toBe(home);
    expect(home.startsWith(signInRoot(dataDir))).toBe(true);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    // Codex keeps its sign-in in its home's own file, where a sandbox sees it.
    expect(fs.readFileSync(path.join(home, "config.toml"), "utf8")).toContain(
      'cli_auth_credentials_store = "file"',
    );
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([
      { harness: "codex", member: "user|alice", home },
    ]);
    expect(signInCapabilities(signInRoot(dataDir))).toEqual([
      "sign-ins",
      "sign-in:codex:user|alice",
    ]);
  });

  it("reports no sign-in for a login that never completed, and signs out", () => {
    const failed = login({ status: 1 });
    expect(
      signInOnMachine({
        dataDir,
        harness: "codex",
        member: "alice",
        spawn: failed.spawn,
      }).exitCode,
    ).toBe(1);
    // Exiting 0 without writing its file is not a sign-in either.
    expect(
      signInOnMachine({
        dataDir,
        harness: "codex",
        member: "alice",
        spawn: login({ status: 0 }).spawn,
      }).exitCode,
    ).toBe(1);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
    expect(signInCapabilities(signInRoot(dataDir))).toEqual(["sign-ins"]);
    // A home left by an older login without its file does not count.
    fs.mkdirSync(path.join(signInRoot(dataDir), "codex", "carol"), {
      recursive: true,
    });
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);

    signInOnMachine({
      dataDir,
      harness: "codex",
      member: "alice",
      spawn: login({ status: 0, writes: "auth.json" }).spawn,
    });
    // A later failed login keeps the sign-in that was there.
    signInOnMachine({
      dataDir,
      harness: "codex",
      member: "alice",
      spawn: failed.spawn,
    });
    expect(listMachineSignIns(signInRoot(dataDir))).toHaveLength(1);
    expect(
      signOutOnMachine({ dataDir, harness: "codex", member: "alice" }),
    ).toBe(true);
    expect(
      signOutOnMachine({ dataDir, harness: "codex", member: "alice" }),
    ).toBe(false);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });

  it("signs in with the machine's codex, else the one Work carries", () => {
    const own = path.join(dataDir, "own-bin");
    fs.mkdirSync(own);
    fs.writeFileSync(path.join(own, "codex"), "#!/bin/sh\n", { mode: 0o755 });
    expect(codexCommand({ PATH: own })).toEqual({ command: "codex", args: [] });
    // The image has none on its PATH: the pinned one the harness speaks runs.
    const carried = codexCommand({ PATH: path.join(dataDir, "nothing") });
    expect(carried.command).toBe(process.execPath);
    const version = spawnSync(carried.command, [...carried.args, "--version"], {
      encoding: "utf8",
    });
    expect(version.stdout).toContain("0.160.0");
  });

  it("refuses member ids that are not one path segment", () => {
    for (const member of ["", ".", ".."])
      expect(() =>
        signInOnMachine({
          dataDir,
          harness: "codex",
          member,
          spawn: login({ status: 0, writes: "auth.json" }).spawn,
        }),
      ).toThrow("is not a member id");
    // Slashes are encoded, never followed.
    const { home } = signInOnMachine({
      dataDir,
      harness: "codex",
      member: "../escape",
      spawn: login({ status: 0, writes: "auth.json" }).spawn,
    });
    expect(path.dirname(home)).toBe(path.join(signInRoot(dataDir), "codex"));
    expect(listMachineSignIns(signInRoot(dataDir))[0]?.member).toBe(
      "../escape",
    );
  });
});
