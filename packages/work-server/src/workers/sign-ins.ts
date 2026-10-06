import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  MACHINE_CAPABILITIES,
  machineSignInHome,
  SIGN_IN_HARNESSES,
  type SignInHarness,
  signInCapability,
  signInMemberDirectory,
  signInMemberOf,
} from "@catamorphic/sandbox";

/**
 * Members' own Codex sign-ins on this machine (ADRs 0199, 0213). Each is
 * Codex's own home for one member under the machine's data directory, made
 * by Codex's own login on this machine. Work never reads, copies or sends
 * what is inside: the machine reports only who is signed in, and a sandbox
 * of that member's chat mounts their home. Claude Code subscriptions run
 * only on the member's own computer, so no machine holds one.
 */
export function signInRoot(dataDir: string): string {
  return path.join(dataDir, "sign-ins");
}

export interface MachineSignIn {
  harness: SignInHarness;
  member: string;
  home: string;
}

/** The file a signed-in Codex home holds: its file credential store. */
const CODEX_AUTH_FILE = "auth.json";

/** The sign-in homes on this machine that hold a completed login. */
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
      const home = path.join(directory, entry.name);
      return member && fs.existsSync(path.join(home, CODEX_AUTH_FILE))
        ? [{ harness, member, home }]
        : [];
    });
  });
}

/** A machine holds one person's Codex sign-in at most (ADR 0213). */
export class MachineHeldError extends Error {
  constructor() {
    super(
      "Another person's Codex sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
    );
    this.name = "MachineHeldError";
  }
}

/**
 * Refuse a member's login on a machine that holds someone else's: one
 * machine signed in to several accounts reads to the provider as a shared
 * or resold account.
 */
export function assertMachineFree(input: { root: string; member: string }) {
  if (
    listMachineSignIns(input.root).some(
      (signIn) => signIn.member !== input.member,
    )
  )
    throw new MachineHeldError();
}

/**
 * What this machine reports about sign-ins: that its sandboxes can mount
 * them, and one `sign-in:<harness>:<member>` per completed login. Never a
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

/**
 * The `codex` to sign in with: the machine's own on `PATH`, else the one
 * this package carries (the version Work's Codex harness speaks), run with
 * this process's runtime. The image has no `codex` on its `PATH`.
 */
export function codexCommand(env: NodeJS.ProcessEnv = process.env): {
  command: string;
  args: string[];
} {
  for (const directory of (env.PATH ?? "").split(path.delimiter)) {
    if (!directory) continue;
    try {
      fs.accessSync(path.join(directory, "codex"), fs.constants.X_OK);
      return { command: "codex", args: [] };
    } catch {
      // Not here.
    }
  }
  return {
    command: process.execPath,
    args: [
      createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"),
    ],
  };
}

/** Codex's own login, pointed at one home. */
export function signInCommand(input: {
  home: string;
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: Record<string, string> } {
  const codex = codexCommand(input.env);
  return {
    command: codex.command,
    args: [...codex.args, "login", ...(input.args ?? [])],
    env: { CODEX_HOME: input.home },
  };
}

/** Codex keeps its sign-in in the home's own file, so a sandbox sees it. */
const CODEX_FILE_STORE = 'cli_auth_credentials_store = "file"\n';

/**
 * A login runs in a home of its own beside the member's, so a pending or
 * abandoned one is never reported as signed in and never disturbs a
 * sign-in the member already has. It takes the member's place only once
 * the login completed ({@link placeSignIn}).
 */
export function stageSignIn(input: {
  root: string;
  harness: SignInHarness;
  member: string;
}): string {
  const staging = path.join(
    input.root,
    ".pending",
    `${input.harness}-${signInMemberDirectory(input.member)}-${randomUUID()}`,
  );
  fs.mkdirSync(staging, { recursive: true, mode: 0o700 });
  fs.writeFileSync(path.join(staging, "config.toml"), CODEX_FILE_STORE, {
    mode: 0o600,
  });
  return staging;
}

/** A completed login replaces the member's home; returns that home. */
export function placeSignIn(input: {
  root: string;
  harness: SignInHarness;
  member: string;
  staging: string;
}): string {
  const home = machineSignInHome(input);
  fs.mkdirSync(path.dirname(home), { recursive: true, mode: 0o700 });
  fs.rmSync(home, { recursive: true, force: true });
  fs.renameSync(input.staging, home);
  return home;
}

type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

/**
 * Run Codex's own login for a member, interactively, in this terminal.
 * Only a login that completes becomes the member's home, and only on a
 * machine that holds no one else's ({@link assertMachineFree}).
 */
export function signInOnMachine(input: {
  dataDir: string;
  harness: SignInHarness;
  member: string;
  /** Passed to the login (`--device-auth` for a machine without a browser). */
  args?: readonly string[];
  spawn?: Spawn;
}): { home: string; exitCode: number } {
  const root = signInRoot(input.dataDir);
  assertMachineFree({ root, member: input.member });
  const staging = stageSignIn({ ...input, root });
  const login = signInCommand({ home: staging, args: input.args });
  const spawn: Spawn =
    input.spawn ??
    ((command, args, options) => spawnSync(command, args, options));
  const result = spawn(login.command, login.args, {
    env: { ...process.env, ...login.env },
    stdio: "inherit",
  });
  const exitCode = result.error ? 127 : (result.status ?? 1);
  if (exitCode !== 0 || !fs.existsSync(path.join(staging, CODEX_AUTH_FILE))) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (result.error)
      throw new Error(
        `Could not run ${login.command}: ${result.error.message}. Install Codex on this machine first.`,
      );
    return {
      home: machineSignInHome({ ...input, root }),
      exitCode: exitCode || 1,
    };
  }
  return { home: placeSignIn({ ...input, root, staging }), exitCode: 0 };
}

/**
 * Delete every member's sign-in home from this machine, when a pooled
 * machine returns to its pool (ADR 0205). Returns how many went.
 */
export function removeMachineSignIns(root: string): number {
  const homes = listMachineSignIns(root);
  // Logins that never completed, and ones still running, go too.
  fs.rmSync(root, { recursive: true, force: true });
  return homes.length;
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
