import { type ChildProcess, spawn } from "node:child_process";
import { randomUUID } from "node:crypto";
import fs from "node:fs";
import type { Readable } from "node:stream";
import {
  SIGN_IN_SPECS,
  type SignInHarness,
  type SignInSpec,
} from "@catamorphic/sandbox";
import { z } from "zod";
import {
  assertMachineFree,
  MachineHeldError,
  noSignInLeft,
  placeSignIn,
  signedIn,
  signInCommand,
  signInEnvironment,
  signOutOnMachine,
  stageSignIn,
} from "./sign-ins.js";

/*
 * A member signs in to Claude Code or Codex on one of their machines from
 * the Work app (ADRs 0213, 0342): this machine runs the harness's own
 * unmodified login into a home of its own for them, the app shows the link
 * it printed, and the member finishes in their own browser. Codex prints a
 * one-time code the member enters there (`codex login --device-auth`);
 * Claude Code's page gives the member a code, which they paste into the
 * app and this machine writes to the login as its one line of input
 * (`claude auth login`). The token is issued to the harness on this
 * machine and never leaves it. Attempts are this process's working state:
 * a machine that restarts forgets them, and the member starts again.
 *
 * The pasted code is a secret in transit: it goes to the login's input and
 * nowhere else. No answer, message, log or error here carries it.
 */

/** What a member does with a harness's sign-in on a machine. */
export type HarnessSignInRequest =
  | { action: "begin"; harness: SignInHarness; member: string }
  | {
      action: "status";
      harness: SignInHarness;
      member: string;
      attempt: string;
    }
  | {
      action: "cancel";
      harness: SignInHarness;
      member: string;
      attempt: string;
    }
  | {
      action: "input";
      harness: SignInHarness;
      member: string;
      attempt: string;
      text: string;
    }
  | { action: "signOut"; harness: SignInHarness; member: string };

/** The longest line a login is handed. */
export const SIGN_IN_INPUT_MAX = 4096;

export const HarnessSignInStartedSchema = z.strictObject({
  attempt: z.string().uuid(),
  verificationUrl: z.string().url().max(8192),
  /** The one-time code the login printed, when it printed one. */
  userCode: z.string().min(1).max(32).optional(),
  /** What the login waits for after the link: a code the member pastes. */
  expects: z.literal("code").optional(),
  expiresAt: z.string().datetime(),
});
export type HarnessSignInStarted = z.infer<typeof HarnessSignInStartedSchema>;

export const HarnessSignInStatusSchema = z.strictObject({
  state: z.enum(["waiting", "signed-in", "failed", "expired", "cancelled"]),
  message: z.string().max(400).optional(),
});
export type HarnessSignInStatus = z.infer<typeof HarnessSignInStatusSchema>;
export type HarnessSignInState = HarnessSignInStatus["state"];

export const HarnessSignedOutSchema = z.strictObject({
  signedOut: z.boolean(),
});

/** What a machine would not do, and why, for the member to read. */
export const HarnessSignInRefusedSchema = z.strictObject({
  refused: z.string().min(1).max(400),
});

/** How long a login takes at most to print its link. */
const CODE_TIMEOUT_MS = 30_000;
/** A login lasts 15 minutes unless it says otherwise. */
const DEFAULT_CODE_MINUTES = 15;
/** How long an exited login's remaining output is waited for. */
const EXIT_DRAIN_MS = 500;
/** Finished attempts are remembered this long for a late status read. */
const FINISHED_TTL_MS = 60 * 60_000;

interface Attempt {
  harness: SignInHarness;
  member: string;
  child: ChildProcess;
  staging: string;
  expiresAt: number;
  state: HarnessSignInState;
  message?: string;
  finishedAt?: number;
  deadline: NodeJS.Timeout;
  /** What the login said since it printed its link. */
  output: string;
  /**
   * The line the member pasted, kept only while the login runs so nothing
   * the login says back about it reaches a message.
   */
  secret?: string;
}

/** A login's output without its colors. */
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

/**
 * The link a login that waits for a pasted code printed (`claude auth
 * login`: "If the browser didn't open, visit: <url>"), once the whole link
 * is there: the first https link on one of the harness's own hosts.
 */
export function parseSignInLink(input: {
  output: string;
  hosts: readonly string[];
}): string | undefined {
  // Only links followed by whitespace: one still arriving is not whole.
  for (const match of plainOutput(input.output).matchAll(
    /https:\/\/[^\s"'<>]+(?=\s)/g,
  )) {
    let host: string;
    try {
      host = new URL(match[0]).hostname.toLowerCase();
    } catch {
      continue;
    }
    if (
      input.hosts.some(
        (allowed) => host === allowed || host.endsWith(`.${allowed}`),
      )
    )
      return match[0];
  }
  return undefined;
}

/** Resolves once a stream has given everything it had. */
function drained(stream: Readable | null): Promise<void> {
  return !stream || stream.readableEnded || stream.destroyed
    ? Promise.resolve()
    : new Promise((resolve) => {
        stream.once("end", resolve);
        stream.once("close", resolve);
      });
}

/** What a login printed for the member to act on, once it printed it all. */
function parsePrompt(input: {
  spec: SignInSpec;
  output: string;
}):
  | { verificationUrl: string; userCode?: string; minutes: number }
  | undefined {
  if (input.spec.expects !== "code") return parseDeviceCode(input.output);
  const verificationUrl = parseSignInLink({
    output: input.output,
    hosts: input.spec.linkHosts ?? [],
  });
  return verificationUrl
    ? { verificationUrl, minutes: DEFAULT_CODE_MINUTES }
    : undefined;
}

/**
 * The last thing a login said, for a member to read: one short line that
 * is neither a prompt nor a link, with anything the member pasted removed.
 */
function lastWords(output: string, secret?: string): string | undefined {
  const lines = plainOutput(output)
    .split("\n")
    .map((line) => line.trim())
    .filter(
      (line) => line && !line.endsWith(">") && !line.includes("https://"),
    );
  const last = lines.at(-1);
  if (!last) return undefined;
  return (secret ? last.split(secret).join("the code") : last).slice(0, 300);
}

export class HarnessSignInRefusedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "HarnessSignInRefusedError";
  }
}

export class HarnessSignIns {
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
      /**
       * A member's sign-in was placed or removed: the machine tells
       * placement now rather than at its next scan.
       */
      onChange?: () => void;
    },
  ) {}

  /** One request from the control plane (or this server's own routes). */
  async handle(
    request: HarnessSignInRequest,
  ): Promise<
    | HarnessSignInStarted
    | { refused: string }
    | HarnessSignInStatus
    | { signedOut: boolean }
  > {
    // A refusal is an answer the member reads, not a machine failure.
    const refusal = (error: unknown) => {
      if (error instanceof HarnessSignInRefusedError)
        return { refused: error.message.slice(0, 400) };
      throw error;
    };
    switch (request.action) {
      case "begin":
        return this.begin(request).catch(refusal);
      case "status":
        return this.status(request);
      case "cancel":
        return this.cancel(request);
      case "input":
        try {
          return this.input(request);
        } catch (error) {
          return refusal(error);
        }
      case "signOut": {
        const signedOut = signOutOnMachine({
          dataDir: this.options.dataDir,
          harness: request.harness,
          member: request.member,
        });
        if (signedOut) this.options.onChange?.();
        return { signedOut };
      }
    }
  }

  /**
   * Start a harness's own login for a member. Resolves once it printed its
   * link (and, for Codex, its code); one login of a harness runs per
   * member, so a new one replaces theirs.
   */
  async begin(input: {
    harness: SignInHarness;
    member: string;
  }): Promise<HarnessSignInStarted> {
    this.prune();
    const { harness, member } = input;
    const spec = SIGN_IN_SPECS[harness];
    try {
      assertMachineFree({ root: this.options.signInRoot, member });
    } catch (error) {
      if (error instanceof MachineHeldError)
        throw new HarnessSignInRefusedError(error.message);
      throw error;
    }
    for (const [id, attempt] of this.attempts)
      if (
        attempt.member === member &&
        attempt.harness === harness &&
        attempt.state === "waiting"
      )
        this.finish(id, "cancelled", "A newer sign-in replaced this one");
    const staging = stageSignIn({
      root: this.options.signInRoot,
      harness,
      member,
    });
    const login = signInCommand({
      harness,
      home: staging,
      env: this.options.env,
    });
    const child = spawn(login.command, login.args, {
      env: signInEnvironment({
        harness,
        base: this.options.env ?? process.env,
        login: { ...login.env, NO_COLOR: "1" },
      }),
      // A login that waits for a pasted code reads it from a plain pipe.
      stdio: [spec.expects ? "pipe" : "ignore", "pipe", "pipe"],
    });
    // A login that ended takes no more input; writing then is no failure.
    child.stdin?.on("error", () => undefined);
    const id = randomUUID();
    let output = "";
    return new Promise<HarnessSignInStarted>((resolve, reject) => {
      let settled = false;
      const fail = (message: string) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        child.kill("SIGTERM");
        fs.rmSync(staging, { recursive: true, force: true });
        reject(new HarnessSignInRefusedError(message));
      };
      const timer = setTimeout(
        () =>
          fail(
            `${spec.name} did not print a sign-in link within ${CODE_TIMEOUT_MS / 1000} seconds${lastWords(output) ? `: ${lastWords(output)}` : ""}`,
          ),
        CODE_TIMEOUT_MS,
      );
      const read = (chunk: Buffer) => {
        const text = chunk.toString("utf8");
        const attempt = this.attempts.get(id);
        if (attempt) {
          attempt.output = (attempt.output + text).slice(-64_000);
          return;
        }
        output = (output + text).slice(-64_000);
        if (settled) return;
        const prompt = parsePrompt({ spec, output });
        if (!prompt) return;
        settled = true;
        clearTimeout(timer);
        const now = this.now();
        const lifetime = prompt.minutes * 60_000;
        const expiresAt = now + lifetime;
        this.attempts.set(id, {
          harness,
          member,
          child,
          staging,
          expiresAt,
          state: "waiting",
          output: "",
          deadline: setTimeout(
            () =>
              this.finish(
                id,
                "expired",
                spec.expects
                  ? "The sign-in was not finished in time"
                  : "The code expired",
              ),
            // Codex gives up on its own, so this only makes sure; a login
            // that waits for a pasted code waits until it is ended.
            spec.expects ? lifetime : lifetime + 60_000,
          ),
        });
        resolve({
          attempt: id,
          verificationUrl: prompt.verificationUrl,
          ...(prompt.userCode ? { userCode: prompt.userCode } : {}),
          ...(spec.expects ? { expects: spec.expects } : {}),
          expiresAt: new Date(expiresAt).toISOString(),
        });
      };
      child.stdout?.on("data", read);
      child.stderr?.on("data", read);
      child.once("error", (error) =>
        fail(
          `Could not run ${spec.name} on this machine: ${error.message}. Install it there first`,
        ),
      );
      const ended = (code: number | null) => {
        if (!settled) {
          fail(
            lastWords(output) ??
              `${spec.name} stopped before printing a sign-in link (exit ${code ?? "signal"})`,
          );
          return;
        }
        const attempt = this.attempts.get(id);
        if (attempt?.state !== "waiting") return;
        if (code === 0 && signedIn({ harness, home: staging })) {
          try {
            // Someone else may have signed in here meanwhile.
            assertMachineFree({ root: this.options.signInRoot, member });
            placeSignIn({
              root: this.options.signInRoot,
              harness,
              member,
              staging,
            });
          } catch (error) {
            // Held by someone else, or the machine was reset meanwhile.
            this.finish(
              id,
              "failed",
              error instanceof Error ? error.message : String(error),
            );
            return;
          }
          this.finish(id, "signed-in");
          this.options.onChange?.();
          return;
        }
        this.finish(
          id,
          this.now() >= attempt.expiresAt ? "expired" : "failed",
          code === 0
            ? noSignInLeft(harness)
            : (lastWords(attempt.output, attempt.secret) ??
                `${spec.name} did not complete the sign-in`),
        );
      };
      // A login's last words may still be in its pipes when it exits:
      // they are read first, for a moment at most (something the login
      // started, such as a browser, may hold a pipe open for long).
      child.once("exit", (code) => {
        void Promise.race([
          Promise.all([drained(child.stdout), drained(child.stderr)]),
          new Promise((resolve) => setTimeout(resolve, EXIT_DRAIN_MS)),
        ]).then(() => ended(code));
      });
    });
  }

  status(input: {
    harness: SignInHarness;
    member: string;
    attempt: string;
  }): HarnessSignInStatus {
    const attempt = this.own(input);
    if (!attempt)
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

  cancel(input: {
    harness: SignInHarness;
    member: string;
    attempt: string;
  }): HarnessSignInStatus {
    if (this.own(input)?.state === "waiting")
      this.finish(input.attempt, "cancelled");
    return this.status(input);
  }

  /**
   * Hand a waiting login the one line it waits for: the code the member
   * copied from their browser. The answer says where the sign-in stands
   * and never repeats the line.
   */
  input(input: {
    harness: SignInHarness;
    member: string;
    attempt: string;
    text: string;
  }): HarnessSignInStatus {
    const spec = SIGN_IN_SPECS[input.harness];
    if (!spec.expects)
      throw new HarnessSignInRefusedError(
        `${spec.name} takes no code here: enter the code it showed on its sign-in page`,
      );
    const attempt = this.own(input);
    if (attempt?.state !== "waiting") return this.status(input);
    const line = input.text.trim();
    if (
      !line ||
      line.length > SIGN_IN_INPUT_MAX ||
      // biome-ignore lint/suspicious/noControlCharactersInRegex: one line only
      /[\u0000-\u001f\u007f]/.test(line)
    )
      throw new HarnessSignInRefusedError(
        "That is not a code: paste the one line the sign-in page gave you",
      );
    const stdin = attempt.child.stdin;
    if (attempt.secret !== undefined || !stdin || stdin.destroyed)
      throw new HarnessSignInRefusedError(
        "This sign-in already has its code. Wait for it to finish, or start again",
      );
    attempt.secret = line;
    // One line, then the end of its input: the login reads no more.
    stdin.end(`${line}\n`);
    return this.status(input);
  }

  /** End every login this machine runs, when it stops. */
  stop(): void {
    for (const [id, attempt] of this.attempts)
      if (attempt.state === "waiting") this.finish(id, "cancelled");
  }

  /** The attempt of this id when it is this member's, of this harness. */
  private own(input: {
    harness: SignInHarness;
    member: string;
    attempt: string;
  }): Attempt | undefined {
    const attempt = this.attempts.get(input.attempt);
    return attempt?.member === input.member && attempt.harness === input.harness
      ? attempt
      : undefined;
  }

  private finish(
    id: string,
    state: HarnessSignInState,
    message?: string,
  ): void {
    const attempt = this.attempts.get(id);
    if (attempt?.state !== "waiting") return;
    attempt.state = state;
    if (message) attempt.message = message;
    attempt.finishedAt = this.now();
    // Nothing of what the member pasted or the login said outlives it.
    delete attempt.secret;
    attempt.output = "";
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
