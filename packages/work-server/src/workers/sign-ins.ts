import { type SpawnSyncReturns, spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import { createRequire } from "node:module";
import path from "node:path";
import {
  MACHINE_CAPABILITIES,
  machineSignInHome,
  SIGN_IN_HARNESSES,
  SIGN_IN_SPECS,
  type SignInHarness,
  signInCapability,
  signInMemberDirectory,
  signInMemberOf,
} from "@catamorphic/sandbox";

/**
 * Members' own Claude Code and Codex sign-ins on this machine (ADRs 0199,
 * 0213, 0340). Each is the harness's own home for one member under the
 * machine's data directory, made by the harness's own unmodified login on
 * this machine. Work never reads, copies or sends what is inside: the
 * machine reports only who is signed in, and a sandbox of that member's
 * chat mounts their home. What differs between harnesses is in
 * `SIGN_IN_SPECS`.
 */
export function signInRoot(dataDir: string): string {
  return path.join(dataDir, "sign-ins");
}

export interface MachineSignIn {
  harness: SignInHarness;
  member: string;
  home: string;
}

/** Whether a home holds the file its harness's completed login leaves. */
export function signedIn(input: {
  harness: SignInHarness;
  home: string;
}): boolean {
  return fs.existsSync(
    path.join(input.home, SIGN_IN_SPECS[input.harness].completionFile),
  );
}

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
      return member && signedIn({ harness, home })
        ? [{ harness, member, home }]
        : [];
    });
  });
}

/** A machine holds one person's sign-ins at most (ADRs 0213, 0340). */
export class MachineHeldError extends Error {
  constructor() {
    super(
      "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
    );
    this.name = "MachineHeldError";
  }
}

/**
 * Refuse a member's login on a machine that holds someone else's, of any
 * harness: one machine signed in to several people's accounts reads to a
 * provider as a shared or resold account. One person may hold a sign-in of
 * each harness there.
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

/** Whether an executable of this name is on a search path. */
function onPath(command: string, env: NodeJS.ProcessEnv): boolean {
  return (env.PATH ?? "").split(path.delimiter).some((directory) => {
    if (!directory) return false;
    try {
      fs.accessSync(path.join(directory, command), fs.constants.X_OK);
      return true;
    } catch {
      return false;
    }
  });
}

/**
 * The CLI to sign in with: the machine's own on `PATH`. For Codex, else
 * the one this package carries (the version Work's Codex harness speaks),
 * run with this process's runtime: the image has no `codex` on its `PATH`.
 * Claude Code is always the machine's own unmodified `claude`.
 */
export function harnessCommand(
  harness: SignInHarness,
  env: NodeJS.ProcessEnv = process.env,
): { command: string; args: string[] } {
  const { command } = SIGN_IN_SPECS[harness];
  if (harness === "codex" && !onPath(command, env))
    return {
      command: process.execPath,
      args: [
        createRequire(import.meta.url).resolve("@openai/codex/bin/codex.js"),
      ],
    };
  return { command, args: [] };
}

/** The harness's own login, pointed at one home. */
export function signInCommand(input: {
  harness: SignInHarness;
  home: string;
  /** Instead of the harness's default login arguments. */
  args?: readonly string[];
  env?: NodeJS.ProcessEnv;
}): { command: string; args: string[]; env: Record<string, string> } {
  const spec = SIGN_IN_SPECS[input.harness];
  const cli = harnessCommand(input.harness, input.env);
  return {
    command: cli.command,
    args: [...cli.args, ...spec.login, ...(input.args ?? spec.defaultArgs)],
    env: { [spec.homeVariable]: input.home },
  };
}

/**
 * The environment a login runs in: this process's, pointed at the login's
 * home, without any variable that would hand the CLI another credential
 * (an organization's key on a single server is not the member's sign-in).
 */
export function signInEnvironment(input: {
  harness: SignInHarness;
  base: NodeJS.ProcessEnv;
  login: Record<string, string>;
}): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...input.base };
  for (const name of SIGN_IN_SPECS[input.harness].otherCredentials ?? [])
    delete env[name];
  return { ...env, ...input.login };
}

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
  for (const [name, content] of Object.entries(
    SIGN_IN_SPECS[input.harness].homeFiles ?? {},
  ))
    fs.writeFileSync(path.join(staging, name), content, { mode: 0o600 });
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

/**
 * Why a login that exited cleanly left no sign-in in its home, for a
 * person to read. On macOS Claude Code keeps its sign-in in the Keychain,
 * keyed to the home it ran in, which no sandbox mounts.
 */
export function noSignInLeft(harness: SignInHarness): string {
  const { name } = SIGN_IN_SPECS[harness];
  return harness === "claude-code" && process.platform === "darwin"
    ? `${name} kept this sign-in in the macOS Keychain instead of its home, so a sandbox cannot use it. Sign in on a Linux machine`
    : `${name} did not complete the sign-in`;
}

type Spawn = (
  command: string,
  args: string[],
  options: { env: NodeJS.ProcessEnv; stdio: "inherit" },
) => Pick<SpawnSyncReturns<Buffer>, "status" | "error">;

/**
 * Run a harness's own login for a member, interactively, in this terminal.
 * Only a login that completes becomes the member's home, and only on a
 * machine that holds no one else's ({@link assertMachineFree}).
 */
export function signInOnMachine(input: {
  dataDir: string;
  harness: SignInHarness;
  member: string;
  /** Instead of the harness's default login arguments. */
  args?: readonly string[];
  spawn?: Spawn;
}): { home: string; exitCode: number; reason?: string } {
  const root = signInRoot(input.dataDir);
  assertMachineFree({ root, member: input.member });
  const staging = stageSignIn({ ...input, root });
  const login = signInCommand({
    harness: input.harness,
    home: staging,
    args: input.args,
  });
  const spawn: Spawn =
    input.spawn ??
    ((command, args, options) => spawnSync(command, args, options));
  const result = spawn(login.command, login.args, {
    env: signInEnvironment({
      harness: input.harness,
      base: process.env,
      login: login.env,
    }),
    stdio: "inherit",
  });
  const exitCode = result.error ? 127 : (result.status ?? 1);
  if (exitCode !== 0 || !signedIn({ harness: input.harness, home: staging })) {
    fs.rmSync(staging, { recursive: true, force: true });
    if (result.error)
      throw new Error(
        `Could not run ${login.command}: ${result.error.message}. Install ${SIGN_IN_SPECS[input.harness].name} on this machine first.`,
      );
    return {
      home: machineSignInHome({ ...input, root }),
      exitCode: exitCode || 1,
      // The login said it finished, and left nothing to sign in with.
      ...(exitCode === 0 ? { reason: noSignInLeft(input.harness) } : {}),
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
