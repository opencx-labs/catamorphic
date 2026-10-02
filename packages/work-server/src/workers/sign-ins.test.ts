import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  listMachineSignIns,
  signInCapabilities,
  signInOnMachine,
  signInRoot,
  signOutOnMachine,
} from "./sign-ins.js";

/**
 * Members' sign-ins on a machine (ADR 0198): the harness's own login, run
 * in the operator's terminal, into one member's home on this machine's
 * disk. The machine reports who is signed in to what, never a value.
 */
describe("sign-ins on a machine", () => {
  let dataDir: string;
  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-sign-ins-"));
  });
  afterEach(() => fs.rmSync(dataDir, { recursive: true, force: true }));

  /** A stand-in for the harness's login: records what it was run with. */
  const login = (input: { status: number; writes?: string }) => {
    const runs: Array<{ command: string; args: string[]; home?: string }> = [];
    return {
      runs,
      spawn: (
        command: string,
        args: string[],
        options: { env: NodeJS.ProcessEnv },
      ) => {
        const home = options.env.CLAUDE_CONFIG_DIR ?? options.env.CODEX_HOME;
        runs.push({ command, args, ...(home ? { home } : {}) });
        if (home && input.writes)
          fs.writeFileSync(path.join(home, input.writes), "{}");
        return { status: input.status, error: undefined };
      },
    };
  };

  it("runs the harness's own login into the member's home, and reports only the fact", () => {
    const claude = login({ status: 0, writes: ".credentials.json" });
    const { home, exitCode } = signInOnMachine({
      dataDir,
      harness: "claude-code",
      member: "user|alice",
      spawn: claude.spawn,
    });
    expect(exitCode).toBe(0);
    expect(claude.runs).toEqual([
      { command: "claude", args: ["/login"], home },
    ]);
    expect(home.startsWith(signInRoot(dataDir))).toBe(true);
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);

    const codex = login({ status: 0, writes: "auth.json" });
    const signedIn = signInOnMachine({
      dataDir,
      harness: "codex",
      member: "bob",
      args: ["--device-auth"],
      spawn: codex.spawn,
    });
    expect(codex.runs).toEqual([
      {
        command: "codex",
        args: ["login", "--device-auth"],
        home: signedIn.home,
      },
    ]);
    // Codex keeps its sign-in in its home's own file, where a sandbox sees it.
    expect(
      fs.readFileSync(path.join(signedIn.home, "config.toml"), "utf8"),
    ).toContain('cli_auth_credentials_store = "file"');

    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([
      { harness: "claude-code", member: "user|alice", home },
      { harness: "codex", member: "bob", home: signedIn.home },
    ]);
    expect(signInCapabilities(signInRoot(dataDir))).toEqual([
      "sign-ins",
      "sign-in:claude-code:user|alice",
      "sign-in:codex:bob",
    ]);
  });

  it("leaves no home behind when a first login fails, and signs out", () => {
    const failed = login({ status: 1 });
    expect(
      signInOnMachine({
        dataDir,
        harness: "claude-code",
        member: "alice",
        spawn: failed.spawn,
      }).exitCode,
    ).toBe(1);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
    expect(signInCapabilities(signInRoot(dataDir))).toEqual(["sign-ins"]);

    signInOnMachine({
      dataDir,
      harness: "claude-code",
      member: "alice",
      spawn: login({ status: 0 }).spawn,
    });
    // A later failed login keeps the sign-in that was there.
    signInOnMachine({
      dataDir,
      harness: "claude-code",
      member: "alice",
      spawn: failed.spawn,
    });
    expect(listMachineSignIns(signInRoot(dataDir))).toHaveLength(1);
    expect(
      signOutOnMachine({ dataDir, harness: "claude-code", member: "alice" }),
    ).toBe(true);
    expect(
      signOutOnMachine({ dataDir, harness: "claude-code", member: "alice" }),
    ).toBe(false);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });

  it("refuses member ids that are not one path segment", () => {
    for (const member of ["", ".", ".."])
      expect(() =>
        signInOnMachine({
          dataDir,
          harness: "claude-code",
          member,
          spawn: login({ status: 0 }).spawn,
        }),
      ).toThrow("is not a member id");
    // Slashes are encoded, never followed.
    const { home } = signInOnMachine({
      dataDir,
      harness: "claude-code",
      member: "../escape",
      spawn: login({ status: 0 }).spawn,
    });
    expect(path.dirname(home)).toBe(
      path.join(signInRoot(dataDir), "claude-code"),
    );
    expect(listMachineSignIns(signInRoot(dataDir))[0]?.member).toBe(
      "../escape",
    );
  });
});
