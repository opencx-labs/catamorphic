import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import {
  MACHINE_CAPABILITIES,
  machineSignInHome,
  SIGN_IN_HARNESSES,
  type SignInHarness,
  signInCapability,
  signInMemberOf,
} from "@catamorphic/sandbox";

/**
 * Members' own harness sign-ins on this machine (ADR 0198). Each is the
 * harness's own home for one member under the machine's data directory,
 * made by the harness's own login in the operator's terminal on this
 * machine. Work never reads, copies or sends what is inside: the machine
 * reports only who is signed in to what, and a sandbox of that member's
 * chat mounts their home.
 */
export function signInRoot(dataDir: string): string {
  return path.join(dataDir, "sign-ins");
}

export interface MachineSignIn {
  harness: SignInHarness;
  member: string;
  home: string;
}

/** The sign-in homes present on this machine. */
export function listMachineSignIns(root: string): MachineSignIn[] {
  return SIGN_IN_HARNESSES.flatMap((harness) => {
    const directory = path.join(root, harness);
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(directory, { withFileTypes: true });
    } catch {
      return [];
    }
    return entries.flatMap((entry) => {
      const member = entry.isDirectory()
        ? signInMemberOf(entry.name)
        : undefined;
      return member
        ? [{ harness, member, home: path.join(directory, entry.name) }]
        : [];
    });
  });
}

/**
 * What this machine reports about sign-ins: that its sandboxes can mount
 * them, and one `sign-in:<harness>:<member>` per home present. Never a
 * credential.
 */
export function signInCapabilities(root: string): string[] {
  return [
    MACHINE_CAPABILITIES.signIns,
    ...listMachineSignIns(root)
      .map((signIn) => signInCapability(signIn))
      .sort(),
  ];
}

/** The harness's own login, pointed at one member's home. */
export function signInCommand(input: {
  harness: SignInHarness;
  home: string;
  args?: readonly string[];
}): { command: string; args: string[]; env: Record<string, string> } {
  return input.harness === "codex"
    ? {
        command: "codex",
        args: ["login", ...(input.args ?? [])],
        env: { CODEX_HOME: input.home },
      }
    : {
        command: "claude",
        args: ["/login", ...(input.args ?? [])],
        env: { CLAUDE_CONFIG_DIR: input.home },
      };
}

/** Codex keeps its sign-in in the home's own file, so a sandbox sees it. */
const CODEX_FILE_STORE = 'cli_auth_credentials_store = "file"\n';

type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

/**
 * Run the harness's own login for a member, interactively, in this
 * terminal. The home is created owner-only; a login that fails leaves no
 * home behind unless one was already there.
 */
export function signInOnMachine(input: {
  dataDir: string;
  harness: SignInHarness;
  member: string;
  /** Passed to the harness's login (`--device-auth` for Codex). */
  args?: readonly string[];
  spawn?: Spawn;
}): { home: string; exitCode: number } {
  const home = machineSignInHome({
    root: signInRoot(input.dataDir),
    harness: input.harness,
    member: input.member,
  });
  const existed = fs.existsSync(home);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  if (input.harness === "codex") {
    const config = path.join(home, "config.toml");
    if (!fs.existsSync(config))
      fs.writeFileSync(config, CODEX_FILE_STORE, { mode: 0o600 });
  }
  const login = signInCommand({ ...input, home });
  const spawn: Spawn =
    input.spawn ??
    ((command, args, options) => spawnSync(command, args, options));
  const result = spawn(login.command, login.args, {
    env: { ...process.env, ...login.env },
    stdio: "inherit",
  });
  const exitCode = result.error ? 127 : (result.status ?? 1);
  if (exitCode !== 0 && !existed)
    fs.rmSync(home, { recursive: true, force: true });
  if (result.error)
    throw new Error(
      `Could not run ${login.command}: ${result.error.message}. Install it on this machine first.`,
    );
  return { home, exitCode };
}

/** Delete a member's sign-in home from this machine. */
export function signOutOnMachine(input: {
  dataDir: string;
  harness: SignInHarness;
  member: string;
}): boolean {
  const home = machineSignInHome({
    root: signInRoot(input.dataDir),
    harness: input.harness,
    member: input.member,
  });
  if (!fs.existsSync(home)) return false;
  fs.rmSync(home, { recursive: true, force: true });
  return true;
}
