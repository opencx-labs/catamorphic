import { spawn } from "node:child_process";
import { randomBytes } from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import type {
  AttemptHost,
  HarnessAdapter,
} from "@catamorphic/agent-protocol/runner";
import {
  type ClaudeCodeUsage,
  readClaudeCodeUsage,
} from "@catamorphic/claude-code";
import type {
  ClaudeAccountSignIn,
  ClaudeAccountSwitch,
  ClaudeAccountsView,
} from "../../shared/claude-accounts.js";
import { classifyAgentError } from "./agent-errors.js";

/**
 * The Claude accounts Claude Code agents on this machine's login take turns
 * on (ADR 0243). The person only signs accounts in and out; every rule is
 * fixed here. Sign-ins stay Claude Code's own (ADR 0199): each account is a
 * Claude Code home its own `claude auth login` signed in, and Work learns
 * who it is and how much it has used by asking that CLI, never by reading
 * a credential.
 */

/** Work moves off the account in use at this share of its 5-hour or weekly limit. */
export const SWITCH_AT = 0.85;
/** How long an account a turn was rate limited on rests. */
const REST_MS = 5 * 60_000;
/** How old a usage reading may be when Settings shows the roster. */
const USAGE_FRESH_MS = 60_000;
/** The least time between two readings of an account after its turns. */
const AFTER_TURN_MS = 30_000;
/** How long a turn waits for the first reading of an account, and Settings for any. */
const READING_WAIT_MS = 4_000;
/** How long a sign-in waits for the person. */
const SIGN_IN_MS = 10 * 60_000;
/** Where Claude Code's own sign-in lands once it is done, for closing its tab. */
export const CLAUDE_SIGNED_IN_PAGE =
  "https://platform.claude.com/oauth/code/success";
/** The machine's own Claude Code login, first in the roster when there is one. */
export const MACHINE_ACCOUNT = "machine";
/**
 * What each account home links from the person's `~/.claude`, so that a
 * switch keeps the agent's settings, instructions and extensions.
 */
const LINKED_CONFIG = [
  "settings.json",
  "CLAUDE.md",
  "agents",
  "commands",
  "skills",
  "hooks",
  "output-styles",
  "plugins",
];

/** How the roster reaches Claude Code: its own sign-in, sign-out and `/usage`. */
export interface ClaudeAccountsCli {
  /** Run Claude Code's sign-in in `home`; true once it signed in. */
  login(input: {
    home: string;
    openUrl: (url: string) => void;
    signal: AbortSignal;
  }): Promise<boolean>;
  logout(home: string): Promise<void>;
  /** The account and its usage; `home` undefined is the machine's login. */
  usage(home: string | undefined): Promise<ClaudeCodeUsage>;
}

/** The account an attempt runs on: its environment and what it learns from the turn. */
export interface ClaudeAccountAttempt {
  id: string;
  env: Record<string, string>;
  watch(adapter: HarnessAdapter): HarnessAdapter;
}

interface StoredAccount {
  id: string;
  email: string;
  plan?: string;
  addedAt: number;
}

interface RosterFile {
  version: 1;
  accounts: StoredAccount[];
  inUse?: string;
  lastSwitch?: ClaudeAccountSwitch;
}

/** Where a waiting sign-in's page opens; asking again moves it to that window. */
interface SignInPage {
  url?: string;
  open: (url: string) => void;
}

/** An account as the choice sees it. */
export interface AccountCandidate {
  id: string;
  /** Share of its fuller window used, 0-1; unknown counts as unused. */
  used?: number;
  /** Signed in and not resting. */
  usable: boolean;
}

/**
 * Which account takes the next turn: the one in use while it is usable and
 * under {@link SWITCH_AT}; else the first such account in roster order;
 * else the least used usable one; else, with none usable, the one in use
 * (its turn fails as it would have).
 */
export function chooseAccount(
  candidates: readonly AccountCandidate[],
  inUse: string | undefined,
): string | undefined {
  const usable = candidates.filter((candidate) => candidate.usable);
  const under = (candidate: AccountCandidate) =>
    (candidate.used ?? 0) < SWITCH_AT;
  const current = usable.find((candidate) => candidate.id === inUse);
  if (current && under(current)) return current.id;
  const first = usable.find(under);
  if (first) return first.id;
  const least = [...usable].sort((a, b) => (a.used ?? 0) - (b.used ?? 0))[0];
  if (least) return least.id;
  return candidates.some((candidate) => candidate.id === inUse)
    ? inUse
    : candidates[0]?.id;
}

/** A usage reading's fuller window: its share used, 0-1, and its name. */
export function fullerWindow(
  usage: ClaudeCodeUsage | undefined,
  now: number,
): { used: number; window: "5-hour" | "weekly" } | undefined {
  // A window past its reset is empty until Claude Code says otherwise.
  const share = (window: ClaudeCodeUsage["fiveHour"]) =>
    window && !(window.resetsAt && Date.parse(window.resetsAt) < now)
      ? window.utilization / 100
      : undefined;
  const fiveHour = share(usage?.fiveHour);
  const weekly = share(usage?.sevenDay);
  if (fiveHour === undefined && weekly === undefined) return undefined;
  return (weekly ?? 0) > (fiveHour ?? 0)
    ? { used: weekly ?? 0, window: "weekly" }
    : { used: fiveHour ?? 0, window: "5-hour" };
}

export class ClaudeAccounts {
  private data: RosterFile;
  private readonly readings = new Map<
    string,
    { usage?: ClaudeCodeUsage; at: number }
  >();
  private readonly inFlight = new Map<string, Promise<void>>();
  private readonly resting = new Map<string, number>();
  /** Accounts a turn was turned away on as signed out, until a reading says otherwise. */
  private readonly turnedAway = new Set<string>();
  private pending:
    | { result: Promise<ClaudeAccountSignIn>; page: SignInPage }
    | undefined;

  constructor(
    private readonly deps: {
      /** `<userData>/claude-accounts.json`: who signed in, never a credential. */
      file: string;
      /** `agent-homes/`, where each account's Claude Code home lives. */
      homesDir: string;
      /** The person's own `~/.claude`, linked into every account home. */
      machineConfigDir: string;
      /** Whether this machine has its own Claude Code login. */
      machineSignedIn: () => Promise<boolean>;
      cli: ClaudeAccountsCli;
      /** The roster changed: windows read it again. */
      onChange: () => void;
      /** E2E: a look at the roster asks Claude Code again after a second. */
      alwaysFresh?: boolean;
    },
  ) {
    this.data = readRoster(deps.file);
  }

  /** Whether any account was signed in from Work: until then the roster is inert. */
  hasAccounts(): boolean {
    return this.data.accounts.length > 0;
  }

  async view(): Promise<ClaudeAccountsView> {
    const candidates = await this.candidateIds();
    const fresh = this.deps.alwaysFresh ? 1_000 : USAGE_FRESH_MS;
    // A slow answer arrives as a change once it lands.
    await waitAtMost(
      Promise.all(
        candidates
          .filter(
            (id) => Date.now() - (this.readings.get(id)?.at ?? 0) >= fresh,
          )
          .map((id) => this.read(id)),
      ),
    );
    const inUse = candidates.includes(this.data.inUse ?? "")
      ? this.data.inUse
      : candidates[0];
    const now = Date.now();
    return {
      accounts: candidates.map((id) => {
        const reading = this.readings.get(id)?.usage;
        const stored = this.data.accounts.find((account) => account.id === id);
        const plan = reading?.plan ?? stored?.plan;
        const resting = this.resting.get(id) ?? 0;
        const minutes = Math.max(1, Math.ceil((resting - now) / 60_000));
        const note = !this.signedIn(id)
          ? id === MACHINE_ACCOUNT
            ? "Signed out of Claude Code on this Mac"
            : "Signed out. Sign in again to use it."
          : resting > now
            ? `Rate limited, back in ${minutes} min`
            : reading && !reading.fiveHour && !reading.sevenDay
              ? "Usage unavailable"
              : undefined;
        return {
          id,
          label:
            reading?.email ??
            stored?.email ??
            (id === MACHINE_ACCOUNT ? "This Mac's Claude login" : "Claude"),
          machine: id === MACHINE_ACCOUNT,
          ...(plan ? { plan } : {}),
          inUse: id === inUse && candidates.length > 1,
          ...(reading?.fiveHour
            ? { fiveHour: Math.round(reading.fiveHour.utilization) }
            : {}),
          ...(reading?.sevenDay
            ? { weekly: Math.round(reading.sevenDay.utilization) }
            : {}),
          ...(note ? { note } : {}),
        };
      }),
      signingIn: this.pending !== undefined,
      switchAt: Math.round(SWITCH_AT * 100),
      ...(this.data.lastSwitch ? { lastSwitch: this.data.lastSwitch } : {}),
    };
  }

  /**
   * Sign another account in with Claude Code's own `claude auth login`, in
   * a home of its own. One sign-in at a time: asking again while one
   * waits opens its page again.
   */
  signIn(openUrl: (url: string) => void): Promise<ClaudeAccountSignIn> {
    if (this.pending) {
      this.pending.page.open = openUrl;
      if (this.pending.page.url) openUrl(this.pending.page.url);
      return this.pending.result;
    }
    const page: SignInPage = { open: openUrl };
    let settle: (result: ClaudeAccountSignIn) => void = () => {};
    const result = new Promise<ClaudeAccountSignIn>((resolve) => {
      settle = resolve;
    });
    this.pending = { result, page };
    this.deps.onChange();
    void this.runSignIn(page).then(settle, (cause: unknown) =>
      settle({
        ok: false,
        error: cause instanceof Error ? cause.message : String(cause),
      }),
    );
    return result;
  }

  private async runSignIn(page: SignInPage): Promise<ClaudeAccountSignIn> {
    const id = `claude-account-${randomBytes(4).toString("hex")}`;
    const home = this.home(id);
    try {
      fs.mkdirSync(home, { recursive: true });
      this.linkConfig(home);
      const signedIn = await this.deps.cli.login({
        home,
        openUrl: (url) => {
          page.url = url;
          page.open(url);
        },
        signal: AbortSignal.timeout(SIGN_IN_MS),
      });
      const usage = signedIn
        ? await this.deps.cli.usage(home).catch(() => undefined)
        : undefined;
      if (!usage?.signedIn || !usage.email) {
        await this.forget(home);
        return { ok: false, error: "The sign-in did not finish." };
      }
      const email = usage.email;
      if (
        (await this.deps.machineSignedIn()) &&
        (await this.machineEmail()) === email
      ) {
        await this.forget(home);
        return {
          ok: false,
          error: `${email} is this Mac's own Claude login already.`,
        };
      }
      const account: StoredAccount = {
        id,
        email,
        ...(usage.plan ? { plan: usage.plan } : {}),
        addedAt: Date.now(),
      };
      // Signing in again replaces the account's old home in its place.
      const again = this.data.accounts.findIndex(
        (stored) => stored.email === email,
      );
      const old = this.data.accounts[again];
      if (old) {
        this.data.accounts[again] = account;
        if (this.data.inUse === old.id) this.data.inUse = id;
        this.readings.delete(old.id);
        void this.forget(this.home(old.id));
      } else this.data.accounts.push(account);
      this.readings.set(id, { usage, at: Date.now() });
      this.save();
      return { ok: true, email };
    } catch (cause) {
      fs.rmSync(home, { recursive: true, force: true });
      throw cause;
    } finally {
      this.pending = undefined;
      this.deps.onChange();
    }
  }

  /** Sign an account out: Claude Code's own sign-out, then its home goes. */
  async signOut(id: string): Promise<void> {
    if (!this.data.accounts.some((account) => account.id === id)) return;
    this.data.accounts = this.data.accounts.filter(
      (account) => account.id !== id,
    );
    if (this.data.inUse === id) delete this.data.inUse;
    this.readings.delete(id);
    this.save();
    this.deps.onChange();
    await this.forget(this.home(id));
  }

  /**
   * The account the next attempt of a Claude Code agent on this machine's
   * login runs on, or undefined while no account was signed in from Work.
   * A switch says why on the turn's activity line.
   */
  async forAttempt(
    report: (activity: string) => void,
  ): Promise<ClaudeAccountAttempt | undefined> {
    if (!this.hasAccounts()) return undefined;
    const ids = await this.candidateIds();
    // The first turn on an account Work has no reading for waits for one.
    await waitAtMost(
      Promise.all(
        ids.filter((id) => !this.readings.has(id)).map((id) => this.read(id)),
      ),
    );
    const now = Date.now();
    const candidates = ids.map((id) => ({
      id,
      used: fullerWindow(this.readings.get(id)?.usage, now)?.used,
      usable: this.signedIn(id) && (this.resting.get(id) ?? 0) <= now,
    }));
    const before = this.data.inUse;
    const chosen = chooseAccount(candidates, before) ?? MACHINE_ACCOUNT;
    if (chosen !== before) {
      this.data.inUse = chosen;
      if (before && ids.includes(before)) {
        const from = this.label(before);
        const to = this.label(chosen);
        const reason = this.switchReason(before, now);
        this.data.lastSwitch = { from, to, reason, at: now };
        report(`Using ${to}: ${from} ${reason}`);
      }
      this.save();
      this.deps.onChange();
    }
    const env: Record<string, string> = {};
    if (chosen !== MACHINE_ACCOUNT) {
      const home = this.home(chosen);
      this.linkConfig(home);
      env.CLAUDE_CONFIG_DIR = home;
    }
    return {
      id: chosen,
      env,
      watch: (adapter) => this.watch(chosen, adapter),
    };
  }

  /** What a finished turn tells the roster about its account. */
  private watch(id: string, adapter: HarnessAdapter): HarnessAdapter {
    return {
      id: adapter.id,
      capabilities: () => adapter.capabilities(),
      start: (attempt, host, local) =>
        adapter.start(
          attempt,
          {
            emit: (event) => {
              if (event.type === "turn.completed") {
                // The kind the harness gave, else the one Work's own
                // failure words would give it.
                const kind =
                  event.status === "failed" && event.error
                    ? (event.error.kind ??
                      classifyAgentError(event.error.message))
                    : undefined;
                if (kind === "rate_limit")
                  this.resting.set(id, Date.now() + REST_MS);
                if (kind === "auth") this.turnedAway.add(id);
                void this.readAfterTurn(id, kind !== undefined);
              }
              host.emit(event);
            },
            callTool: (input) => host.callTool(input),
            authorize: (input) => host.authorize(input),
            request: (key, request, options) =>
              host.request(key, request, options),
            nativeState: host.nativeState,
            signal: host.signal,
          } satisfies AttemptHost,
          local,
        ),
    };
  }

  private async readAfterTurn(id: string, now: boolean): Promise<void> {
    const last = this.readings.get(id)?.at ?? 0;
    const wait = this.deps.alwaysFresh ? 0 : AFTER_TURN_MS;
    if (!now && Date.now() - last < wait) return;
    await this.read(id);
  }

  /** Ask Claude Code who an account is and how much it used; one ask at a time. */
  private read(id: string): Promise<void> {
    const running = this.inFlight.get(id);
    if (running) return running;
    const reading = this.deps.cli
      .usage(id === MACHINE_ACCOUNT ? undefined : this.home(id))
      .then(
        (usage) => {
          this.readings.set(id, { usage, at: Date.now() });
          if (usage.signedIn) this.turnedAway.delete(id);
        },
        (cause: unknown) => {
          // Kept: the last reading, and when this one was tried.
          console.warn(
            `[desktop] Claude usage for ${this.label(id)} could not be read:`,
            cause instanceof Error ? cause.message : cause,
          );
          this.readings.set(id, {
            ...this.readings.get(id),
            at: Date.now(),
          });
        },
      )
      .finally(() => {
        this.inFlight.delete(id);
        this.deps.onChange();
      });
    this.inFlight.set(id, reading);
    return reading;
  }

  private signedIn(id: string): boolean {
    return (
      !this.turnedAway.has(id) &&
      this.readings.get(id)?.usage?.signedIn !== false
    );
  }

  private switchReason(id: string, now: number): string {
    if (!this.signedIn(id)) return "is signed out";
    if ((this.resting.get(id) ?? 0) > now) return "was rate limited";
    const fuller = fullerWindow(this.readings.get(id)?.usage, now);
    return fuller
      ? `is at ${Math.round(fuller.used * 100)}% of its ${fuller.window} limit`
      : "is unavailable";
  }

  private async candidateIds(): Promise<string[]> {
    const machine = await this.deps.machineSignedIn().catch(() => false);
    return [
      ...(machine ? [MACHINE_ACCOUNT] : []),
      ...this.data.accounts.map((account) => account.id),
    ];
  }

  private async machineEmail(): Promise<string | undefined> {
    if (!this.readings.has(MACHINE_ACCOUNT)) await this.read(MACHINE_ACCOUNT);
    return this.readings.get(MACHINE_ACCOUNT)?.usage?.email;
  }

  private label(id: string): string {
    return (
      this.readings.get(id)?.usage?.email ??
      this.data.accounts.find((account) => account.id === id)?.email ??
      (id === MACHINE_ACCOUNT ? "this Mac's Claude login" : "a Claude account")
    );
  }

  private home(id: string): string {
    return path.join(this.deps.homesDir, id);
  }

  /** Link the person's Claude Code configuration into an account home. */
  private linkConfig(home: string): void {
    for (const name of LINKED_CONFIG) {
      const source = path.join(this.deps.machineConfigDir, name);
      const target = path.join(home, name);
      if (!fs.existsSync(source)) continue;
      try {
        fs.lstatSync(target);
      } catch {
        fs.symlinkSync(source, target);
      }
    }
  }

  /** Claude Code's own sign-out of a home, then the home itself. */
  private async forget(home: string): Promise<void> {
    await this.deps.cli.logout(home).catch(() => {});
    fs.rmSync(home, { recursive: true, force: true });
  }

  private save(): void {
    fs.mkdirSync(path.dirname(this.deps.file), { recursive: true });
    const temporary = `${this.deps.file}.${randomBytes(4).toString("hex")}.tmp`;
    fs.writeFileSync(temporary, `${JSON.stringify(this.data, null, 2)}\n`, {
      mode: 0o600,
    });
    fs.renameSync(temporary, this.deps.file);
  }
}

function waitAtMost(work: Promise<unknown>): Promise<unknown> {
  return Promise.race([
    work,
    new Promise((resolve) => setTimeout(resolve, READING_WAIT_MS)),
  ]);
}

function readRoster(file: string): RosterFile {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, "utf8")) as RosterFile;
    if (parsed.version === 1 && Array.isArray(parsed.accounts)) return parsed;
  } catch {}
  return { version: 1, accounts: [] };
}

/**
 * The roster's Claude Code: `claude auth login` with a `BROWSER` that hands
 * the sign-in page to Work instead of opening the system browser, `claude
 * auth logout`, and `/usage` over the SDK's control channel.
 */
export function claudeAccountsCli(
  executable: () => Promise<{ path: string; env: Record<string, string> }>,
): ClaudeAccountsCli {
  return {
    login: async ({ home, openUrl, signal }) => {
      const claude = await executable();
      const urlFile = path.join(home, ".sign-in-url");
      const browser = path.join(home, ".open-sign-in");
      fs.writeFileSync(
        browser,
        `#!/bin/sh\nprintf '%s\\n' "$1" > "$WORK_SIGN_IN_URL_FILE"\n`,
        { mode: 0o755 },
      );
      const child = spawn(claude.path, ["auth", "login", "--claudeai"], {
        env: {
          ...process.env,
          ...claude.env,
          CLAUDE_CONFIG_DIR: home,
          BROWSER: browser,
          WORK_SIGN_IN_URL_FILE: urlFile,
        },
        stdio: "ignore",
      });
      const stop = () => child.kill();
      signal.addEventListener("abort", stop, { once: true });
      const poll = setInterval(() => {
        try {
          const url = fs.readFileSync(urlFile, "utf8").trim();
          clearInterval(poll);
          if (/^https:\/\//.test(url)) openUrl(url);
        } catch {}
      }, 250);
      try {
        return await new Promise<boolean>((resolve) => {
          child.on("error", () => resolve(false));
          child.on("exit", (code) => resolve(code === 0));
        });
      } finally {
        clearInterval(poll);
        signal.removeEventListener("abort", stop);
        fs.rmSync(urlFile, { force: true });
        fs.rmSync(browser, { force: true });
      }
    },
    logout: async (home) => {
      if (!fs.existsSync(home)) return;
      const claude = await executable();
      await new Promise<void>((resolve) => {
        const child = spawn(claude.path, ["auth", "logout"], {
          env: { ...process.env, ...claude.env, CLAUDE_CONFIG_DIR: home },
          stdio: "ignore",
        });
        const timer = setTimeout(() => child.kill(), 15_000);
        child.on("error", () => resolve());
        child.on("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    },
    usage: async (home) => {
      const claude = await executable();
      return readClaudeCodeUsage({
        pathToClaudeCodeExecutable: claude.path,
        env: { ...claude.env, ...(home ? { CLAUDE_CONFIG_DIR: home } : {}) },
      });
    },
  };
}
