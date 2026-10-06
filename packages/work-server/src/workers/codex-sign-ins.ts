import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { z } from "zod";
import {
  assertMachineFree,
  MachineHeldError,
  placeSignIn,
  signInCommand,
  signOutOnMachine,
  stageSignIn,
} from "./sign-ins.js";

/*
 * A member signs in to Codex on one of their machines from the Work app
 * (ADR 0213): this machine runs Codex's own device-code login
 * (`codex login --device-auth`) into a home of its own for them, the app
 * shows the link and the one-time code it printed, and the member approves
 * in their own browser. The token is issued to Codex on this machine and
 * never leaves it; the one-time code is useless without that approval.
 * Attempts are this process's working state: a machine that restarts
 * forgets them, and the member starts again.
 */

/** What a member does with Codex on a machine. */
export type CodexSignInRequest =
  | { action: "begin"; member: string }
  | { action: "status"; member: string; attempt: string }
  | { action: "cancel"; member: string; attempt: string }
  | { action: "signOut"; member: string };

export const CodexSignInStartedSchema = z.strictObject({
  attempt: z.string().uuid(),
  verificationUrl: z.string().url(),
  userCode: z.string().min(1).max(32),
  expiresAt: z.string().datetime(),
});
export type CodexSignInStarted = z.infer<typeof CodexSignInStartedSchema>;

export const CodexSignInStatusSchema = z.strictObject({
  state: z.enum(["waiting", "signed-in", "failed", "expired", "cancelled"]),
  message: z.string().max(400).optional(),
});
export type CodexSignInStatus = z.infer<typeof CodexSignInStatusSchema>;
export type CodexSignInState = CodexSignInStatus["state"];

export const CodexSignedOutSchema = z.strictObject({ signedOut: z.boolean() });

/** A login this machine would not start, and why, for the member to read. */
export const CodexSignInRefusedSchema = z.strictObject({
  refused: z.string().min(1).max(400),
});

/** How long Codex takes at most to print its link and code. */
const CODE_TIMEOUT_MS = 30_000;
/** Codex's own codes last 15 minutes unless it says otherwise. */
const DEFAULT_CODE_MINUTES = 15;
/** Finished attempts are remembered this long for a late status read. */
const FINISHED_TTL_MS = 60 * 60_000;

interface Attempt {
  member: string;
  child: ChildProcess;
  staging: string;
  expiresAt: number;
  state: CodexSignInState;
  message?: string;
  finishedAt?: number;
  deadline: NodeJS.Timeout;
}

/** Codex's output without its colors. */
export function plainOutput(text: string): string {
  // biome-ignore lint/suspicious/noControlCharactersInRegex: ANSI escapes
  return text.replace(/\u001b\[[0-9;]*[A-Za-z]/g, "");
}

/**
 * The link, one-time code and lifetime `codex login --device-auth` printed,
 * once it printed both.
 */
export function parseDeviceCode(
  output: string,
): { verificationUrl: string; userCode: string; minutes: number } | undefined {
  const text = plainOutput(output);
  const verificationUrl = /https:\/\/\S+/.exec(text)?.[0];
  const userCode = text
    .split("\n")
    .map((line) => line.trim())
    .find((line) => /^[A-Z0-9]{3,8}-[A-Z0-9]{3,8}$/.test(line));
  if (!verificationUrl || !userCode) return undefined;
  const minutes = Number(/expires in (\d+) minutes?/i.exec(text)?.[1]);
  return {
    verificationUrl,
    userCode,
    minutes:
      Number.isFinite(minutes) && minutes > 0 ? minutes : DEFAULT_CODE_MINUTES,
  };
}

/** The last thing Codex said, for a member to read: one short line. */
function lastWords(output: string): string | undefined {
  const lines = plainOutput(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  const last = lines.at(-1);
  return last ? last.slice(0, 300) : undefined;
}

export class CodexSignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CodexSignInRefusedError";
  }
}

export class CodexSignIns {
  /**
   * Replica memory (a): the logins this machine's own process runs, each a
   * child process here; a machine that restarts forgets them and the
   * member starts again.
   */
  private readonly attempts = new Map<string, Attempt>();

  constructor(
    private readonly options: {
      /** The machine's sign-in root (`<data>/sign-ins`). */
      signInRoot: string;
      /** The machine's data directory, for signing out. */
      dataDir: string;
      env?: NodeJS.ProcessEnv;
      now?: () => number;
    },
  ) {}

  /** One request from the control plane (or this server's own routes). */
  async handle(
    request: CodexSignInRequest,
  ): Promise<
    | CodexSignInStarted
    | { refused: string }
    | CodexSignInStatus
    | { signedOut: boolean }
  > {
    switch (request.action) {
      case "begin":
        // A refusal is an answer the member reads, not a machine failure.
        return this.begin(request).catch((error: unknown) => {
          if (error instanceof CodexSignInRefusedError)
            return { refused: error.message.slice(0, 400) };
          throw error;
        });
      case "status":
        return this.status(request);
      case "cancel":
        return this.cancel(request);
      case "signOut":
        return {
          signedOut: signOutOnMachine({
            dataDir: this.options.dataDir,
            harness: "codex",
            member: request.member,
          }),
        };
    }
  }

  /**
   * Start Codex's device-code login for a member. Resolves once Codex
   * printed its link and code; one login runs per member, so a new one
   * replaces theirs.
   */
  async begin(input: { member: string }): Promise<CodexSignInStarted> {
    this.prune();
    try {
      assertMachineFree({
        root: this.options.signInRoot,
        member: input.member,
      });
    } catch (error) {
      if (error instanceof MachineHeldError)
        throw new CodexSignInRefusedError(error.message);
      throw error;
    }
    for (const [id, attempt] of this.attempts)
      if (attempt.member === input.member && attempt.state === "waiting")
        this.finish(id, "cancelled", "A newer sign-in replaced this one");
    const staging = stageSignIn({
      root: this.options.signInRoot,
      harness: "codex",
      member: input.member,
    });
    const login = signInCommand({
      home: staging,
      args: ["--device-auth"],
      env: this.options.env,
    });
    const child = spawn(login.command, login.args, {
      env: {
        ...(this.options.env ?? process.env),
        ...login.env,
        NO_COLOR: "1",
      },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const id = randomUUID();
    let output = "";
    return new Promise<CodexSignInStarted>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        fs.rmSync(staging, { recursive: true, force: true });
        reject(new CodexSignInRefusedError(message));
      };
      const timer = setTimeout(
        () =>
          fail(
            `Codex did not print a sign-in code within ${CODE_TIMEOUT_MS / 1000} seconds${lastWords(output) ? `: ${lastWords(output)}` : ""}`,
          ),
        CODE_TIMEOUT_MS,
      );
      const read = (chunk: Buffer) => {
        output += chunk.toString("utf8");
        if (output.length > 64_000) output = output.slice(-64_000);
        const code = parseDeviceCode(output);
        if (!code || settled) return;
        settled = true;
        clearTimeout(timer);
        const now = this.now();
        const expiresAt = now + code.minutes * 60_000;
        this.attempts.set(id, {
          member: input.member,
          child,
          staging,
          expiresAt,
          state: "waiting",
          // Codex gives up on its own; this only makes sure.
          deadline: setTimeout(
            () => this.finish(id, "expired", "The code expired"),
            code.minutes * 60_000 + 60_000,
          ),
        });
        resolve({
          attempt: id,
          verificationUrl: code.verificationUrl,
          userCode: code.userCode,
          expiresAt: new Date(expiresAt).toISOString(),
        });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("error", (error) =>
        fail(`Could not run Codex on this machine: ${error.message}`),
      );
      child.once("exit", (code) => {
        if (!settled) {
          fail(
            lastWords(output) ??
              `Codex stopped before printing a sign-in code (exit ${code ?? "signal"})`,
          );
          return;
        }
        const attempt = this.attempts.get(id);
        if (attempt?.state !== "waiting") return;
        if (code === 0 && fs.existsSync(path.join(staging, "auth.json"))) {
          try {
            // Someone else may have signed in here meanwhile.
            assertMachineFree({
              root: this.options.signInRoot,
              member: input.member,
            });
          } catch (error) {
            this.finish(
              id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          placeSignIn({
            root: this.options.signInRoot,
            harness: "codex",
            member: input.member,
            staging,
          });
          this.finish(id, "signed-in");
          return;
        }
        this.finish(
          id,
          this.now() >= attempt.expiresAt ? "expired" : "failed",
          lastWords(output) ?? "Codex did not complete the sign-in",
        );
      });
    });
  }

  status(input: { member: string; attempt: string }): CodexSignInStatus {
    const attempt = this.attempts.get(input.attempt);
    if (!attempt || attempt.member !== input.member)
      return {
        state: "failed",
        message:
          "This machine no longer knows this sign-in; it may have restarted. Start again",
      };
    return {
      state: attempt.state,
      ...(attempt.message ? { message: attempt.message } : {}),
    };
  }

  cancel(input: { member: string; attempt: string }): CodexSignInStatus {
    const attempt = this.attempts.get(input.attempt);
    if (attempt?.member === input.member && attempt.state === "waiting")
      this.finish(input.attempt, "cancelled");
    return this.status(input);
  }

  /** End every login this machine runs, when it stops. */
  stop(): void {
    for (const [id, attempt] of this.attempts)
      if (attempt.state === "waiting") this.finish(id, "cancelled");
  }

  private finish(id: string, state: CodexSignInState, message?: string): void {
    const attempt = this.attempts.get(id);
    if (attempt?.state !== "waiting") return;
    attempt.state = state;
    if (message) attempt.message = message;
    attempt.finishedAt = this.now();
    clearTimeout(attempt.deadline);
    if (attempt.child.exitCode === null) attempt.child.kill("SIGTERM");
    if (state !== "signed-in")
      fs.rmSync(attempt.staging, { recursive: true, force: true });
  }

  private prune(): void {
    const now = this.now();
    for (const [id, attempt] of this.attempts)
      if (attempt.finishedAt && now - attempt.finishedAt > FINISHED_TTL_MS)
        this.attempts.delete(id);
  }

  private now(): number {
    return this.options.now?.() ?? Date.now();
  }
}
