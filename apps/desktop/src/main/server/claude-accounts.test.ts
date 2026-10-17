import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  type AttemptHost,
  type AttemptStart,
  type HarnessAdapter,
  type HarnessEvent,
  NO_CAPABILITIES,
  RUNNER_PROTOCOL_VERSION,
} from "@catamorphic/agent-protocol/runner";
import type { ClaudeCodeUsage } from "@catamorphic/claude-code";
import { afterEach, describe, expect, it, vi } from "vitest";
import {
  type AccountCandidate,
  ClaudeAccounts,
  type ClaudeAccountsCli,
  chooseAccount,
  fullerWindow,
  MACHINE_ACCOUNT,
} from "./claude-accounts.js";

const directories: string[] = [];

afterEach(() => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    fs.rmSync(directory, { recursive: true, force: true });
});

/**
 * Claude Code at the process boundary: a sign-in signs in the next email,
 * and `/usage` answers what the test set for the email a home holds.
 */
class ScriptedClaude implements ClaudeAccountsCli {
  signIns: string[] = [];
  usages = new Map<string, { fiveHour?: number; weekly?: number }>();
  machine: string | undefined = "me@example.com";
  signedOut = new Set<string>();
  logins = 0;
  logouts: string[] = [];
  asked: Array<string | undefined> = [];
  /** Holds a sign-in open until the test lets it finish. */
  hold: Promise<void> | undefined;

  async login({
    home,
    openUrl,
  }: {
    home: string;
    openUrl: (url: string) => void;
  }): Promise<boolean> {
    this.logins += 1;
    openUrl(`https://claude.com/cai/oauth/authorize?attempt=${this.logins}`);
    await this.hold;
    const email = this.signIns.shift();
    if (!email) return false;
    fs.writeFileSync(path.join(home, "signed-in-as"), email);
    return true;
  }

  async logout(home: string): Promise<void> {
    this.logouts.push(home);
  }

  async usage(home: string | undefined): Promise<ClaudeCodeUsage> {
    this.asked.push(home);
    const email = home
      ? fs.existsSync(path.join(home, "signed-in-as"))
        ? fs.readFileSync(path.join(home, "signed-in-as"), "utf8")
        : undefined
      : this.machine;
    if (!email || this.signedOut.has(email)) return { signedIn: false };
    const usage = this.usages.get(email) ?? {};
    return {
      signedIn: true,
      email,
      plan: "Claude Max",
      ...(usage.fiveHour === undefined
        ? {}
        : { fiveHour: { utilization: usage.fiveHour } }),
      ...(usage.weekly === undefined
        ? {}
        : { sevenDay: { utilization: usage.weekly } }),
    };
  }
}

function setup(opts: { machine?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "claude-accounts-"));
  directories.push(root);
  const machineConfigDir = path.join(root, "dot-claude");
  fs.mkdirSync(path.join(machineConfigDir, "skills"), { recursive: true });
  fs.writeFileSync(path.join(machineConfigDir, "settings.json"), "{}");
  fs.writeFileSync(path.join(machineConfigDir, "CLAUDE.md"), "# Mine");
  const cli = new ScriptedClaude();
  let changes = 0;
  const make = () =>
    new ClaudeAccounts({
      file: path.join(root, "claude-accounts.json"),
      homesDir: path.join(root, "agent-homes"),
      machineConfigDir,
      machineSignedIn: async () => opts.machine !== false,
      cli,
      onChange: () => {
        changes += 1;
      },
    });
  return {
    root,
    cli,
    roster: make(),
    make,
    changes: () => changes,
    file: path.join(root, "claude-accounts.json"),
  };
}

const ignore = () => {};

const start: AttemptStart = {
  protocol: RUNNER_PROTOCOL_VERSION,
  sessionId: "session-1",
  projectId: "project-1",
  turnId: "turn-1",
  attemptId: "attempt-1",
  reason: "initial",
  harness: "claude-code",
  workingDirectory: "/workspace",
  stateDirectory: "/state",
  thread: { mode: "fresh", providerThreadId: "thread-1" },
  input: { itemId: "item-1", text: "Hello", attachments: [] },
  systemPrompt: "",
  context: "",
  permissions: {},
  modelAccess: { kind: "host" },
  toolPolicies: {},
  toolAnnotations: {},
  mcpServers: {},
  hostTools: [],
  plugins: [],
  env: {},
  options: {},
};

/** One attempt on the roster's account; resolves with what the host saw. */
async function runTurn(
  attempt: { watch(adapter: HarnessAdapter): HarnessAdapter } | undefined,
  completion: Extract<HarnessEvent, { type: "turn.completed" }>,
): Promise<HarnessEvent[]> {
  if (!attempt) throw new Error("No account took the attempt");
  const seen: HarnessEvent[] = [];
  const adapter: HarnessAdapter = {
    id: "scripted",
    capabilities: () => NO_CAPABILITIES,
    start: (_attempt, host) => {
      host.emit(completion);
      return {
        steer: async () => false,
        interrupt: () => {},
        finished: Promise.resolve(),
      };
    },
  };
  const host: AttemptHost = {
    emit: (event) => {
      seen.push(event);
    },
    callTool: async () => {
      throw new Error("No tools here");
    },
    authorize: async () => ({ allowed: false, message: "No tools here" }),
    request: async () => {
      throw new Error("No requests here");
    },
    nativeState: {
      append: async () => {},
      load: async () => null,
      subpaths: async () => [],
    },
    signal: new AbortController().signal,
  };
  await attempt.watch(adapter).start(start, host).finished;
  // The reading the finished turn asked for.
  await new Promise((resolve) => setTimeout(resolve, 10));
  return seen;
}

describe("chooseAccount", () => {
  const at = (id: string, used?: number, usable = true): AccountCandidate => ({
    id,
    ...(used === undefined ? {} : { used }),
    usable,
  });

  it.each([
    [
      "stays on the account in use under 85%",
      [at("a", 0.1), at("b", 0.84)],
      "b",
      "b",
    ],
    [
      "moves at 85% to the first account under it",
      [at("a", 0.9), at("b", 0.85), at("c", 0.2)],
      "a",
      "c",
    ],
    [
      "prefers roster order once it moves",
      [at("a", 0.5), at("b", 0.95), at("c", 0.1)],
      "b",
      "a",
    ],
    ["counts an unknown reading as unused", [at("a", 0.9), at("b")], "a", "b"],
    [
      "takes the least used when all are past 85%",
      [at("a", 0.99), at("b", 0.86), at("c", 0.9)],
      "a",
      "b",
    ],
    [
      "passes over a resting or signed-out account",
      [at("a", 0.1, false), at("b", 0.7)],
      "a",
      "b",
    ],
    [
      "keeps the account in use when none can serve",
      [at("a", 0.1, false), at("b", 0.2, false)],
      "b",
      "b",
    ],
    [
      "starts on the first account",
      [at("a", 0.3), at("b", 0.1)],
      undefined,
      "a",
    ],
  ])("%s", (_name, candidates, inUse, expected) => {
    expect(chooseAccount(candidates, inUse)).toBe(expected);
  });
});

describe("fullerWindow", () => {
  const now = Date.parse("2026-10-17T12:00:00Z");
  it("names the fuller of the 5-hour and weekly windows", () => {
    expect(
      fullerWindow(
        {
          signedIn: true,
          fiveHour: { utilization: 40 },
          sevenDay: { utilization: 87 },
        },
        now,
      ),
    ).toEqual({ used: 0.87, window: "weekly" });
    expect(
      fullerWindow(
        {
          signedIn: true,
          fiveHour: { utilization: 91 },
          sevenDay: { utilization: 30 },
        },
        now,
      ),
    ).toEqual({ used: 0.91, window: "5-hour" });
  });

  it("treats a window past its reset as empty", () => {
    expect(
      fullerWindow(
        {
          signedIn: true,
          fiveHour: { utilization: 99, resetsAt: "2026-10-17T11:59:00Z" },
          sevenDay: { utilization: 20, resetsAt: "2026-10-20T00:00:00Z" },
        },
        now,
      ),
    ).toEqual({ used: 0.2, window: "weekly" });
    expect(fullerWindow({ signedIn: true }, now)).toBeUndefined();
  });
});

describe("ClaudeAccounts", () => {
  it("is inert until an account is signed in from Work", async () => {
    const { roster, cli } = setup();
    expect(roster.hasAccounts()).toBe(false);
    expect(await roster.forAttempt(ignore)).toBeUndefined();
    expect(cli.asked).toEqual([]);
  });

  it("signs an account in with Claude Code's own sign-in, in a home of its own", async () => {
    const { roster, cli, file, root } = setup();
    cli.signIns.push("work@example.com");
    const opened: string[] = [];
    const result = await roster.signIn((url) => opened.push(url));
    expect(result).toEqual({ ok: true, email: "work@example.com" });
    expect(opened).toEqual([
      "https://claude.com/cai/oauth/authorize?attempt=1",
    ]);

    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    expect(saved.accounts).toEqual([
      expect.objectContaining({
        email: "work@example.com",
        plan: "Claude Max",
      }),
    ]);
    expect(fs.statSync(file).mode & 0o777).toBe(0o600);
    // The person's Claude Code configuration is linked, never copied.
    const home = path.join(root, "agent-homes", saved.accounts[0].id);
    for (const name of ["settings.json", "CLAUDE.md", "skills"])
      expect(fs.lstatSync(path.join(home, name)).isSymbolicLink()).toBe(true);
    expect(fs.existsSync(path.join(home, "agents"))).toBe(false);

    const view = await roster.view();
    expect(view.accounts.map((row) => [row.label, row.machine])).toEqual([
      ["me@example.com", true],
      ["work@example.com", false],
    ]);
    expect(view.switchAt).toBe(85);
    expect(view.signingIn).toBe(false);
  });

  it("drops a sign-in that did not finish", async () => {
    const { roster, root } = setup();
    expect(await roster.signIn(ignore)).toEqual({
      ok: false,
      error: "The sign-in did not finish.",
    });
    expect(roster.hasAccounts()).toBe(false);
    expect(fs.readdirSync(path.join(root, "agent-homes"))).toEqual([]);
  });

  it("refuses the account this Mac is already signed in to", async () => {
    const { roster, cli, root } = setup();
    cli.signIns.push("me@example.com");
    expect(await roster.signIn(ignore)).toEqual({
      ok: false,
      error: "me@example.com is this Mac's own Claude login already.",
    });
    expect(fs.readdirSync(path.join(root, "agent-homes"))).toEqual([]);
    expect(cli.logouts).toHaveLength(1);
  });

  it("runs one sign-in at a time; asking again opens its page again", async () => {
    const { roster, cli } = setup();
    let release = () => {};
    cli.hold = new Promise<void>((resolve) => {
      release = resolve;
    });
    cli.signIns.push("work@example.com");
    const first: string[] = [];
    const second: string[] = [];
    const a = roster.signIn((url) => first.push(url));
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect((await roster.view()).signingIn).toBe(true);
    const b = roster.signIn((url) => second.push(url));
    release();
    expect(await a).toEqual(await b);
    expect(cli.logins).toBe(1);
    expect(second).toEqual(first);
  });

  it("moves to the next account at 85% and says why", async () => {
    const { roster, cli, make, root } = setup();
    cli.signIns.push("work@example.com", "side@example.com");
    await roster.signIn(ignore);
    await roster.signIn(ignore);
    cli.usages.set("me@example.com", { fiveHour: 40, weekly: 10 });

    const reports: string[] = [];
    const first = await roster.forAttempt((text) => reports.push(text));
    expect(first?.id).toBe(MACHINE_ACCOUNT);
    expect(first?.env).toEqual({});
    expect(reports).toEqual([]);

    // The reading after a turn longer than 30 s finds the machine's login
    // past 85%.
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(Date.now() + 31_000);
    cli.usages.set("me@example.com", { fiveHour: 90, weekly: 10 });
    await runTurn(first, {
      type: "turn.completed",
      status: "completed",
    });
    const second = await roster.forAttempt((text) => reports.push(text));
    const workHome = second?.env.CLAUDE_CONFIG_DIR ?? "";
    expect(path.dirname(workHome)).toBe(path.join(root, "agent-homes"));
    expect(fs.readFileSync(path.join(workHome, "signed-in-as"), "utf8")).toBe(
      "work@example.com",
    );
    expect(reports).toEqual([
      "Using work@example.com: me@example.com is at 90% of its 5-hour limit",
    ]);

    const view = await roster.view();
    expect(view.accounts.find((row) => row.inUse)?.label).toBe(
      "work@example.com",
    );
    expect(view.lastSwitch).toMatchObject({
      from: "me@example.com",
      to: "work@example.com",
      reason: "is at 90% of its 5-hour limit",
    });

    // Sticky: the machine's window resetting does not move it back.
    cli.usages.set("me@example.com", { fiveHour: 5 });
    const later = make();
    expect((await later.forAttempt(ignore))?.env.CLAUDE_CONFIG_DIR).toBe(
      workHome,
    );
  });

  it("rests an account a turn was rate limited on, so the retry runs on the next", async () => {
    const { roster, cli } = setup({ machine: false });
    cli.signIns.push("work@example.com", "side@example.com");
    await roster.signIn(ignore);
    await roster.signIn(ignore);
    const first = await roster.forAttempt(ignore);
    const seen = await runTurn(first, {
      type: "turn.completed",
      status: "failed",
      // No kind from the harness: Work's own failure words classify it.
      error: { message: "429 rate limit exceeded", retrySafe: true },
    });
    // The host still hears the failure: core's backoff retries it.
    expect(seen).toEqual([
      expect.objectContaining({ type: "turn.completed", status: "failed" }),
    ]);

    const reports: string[] = [];
    const retry = await roster.forAttempt((text) => reports.push(text));
    expect(retry?.id).not.toBe(first?.id);
    expect(reports).toEqual([
      "Using side@example.com: work@example.com was rate limited",
    ]);
    const row = (await roster.view()).accounts.find(
      (account) => account.label === "work@example.com",
    );
    expect(row?.note).toBe("Rate limited, back in 5 min");
  });

  it("passes over an account a turn was turned away on until it is signed in again", async () => {
    const { roster, cli } = setup({ machine: false });
    cli.usages.set("work@example.com", { fiveHour: 10 });
    cli.usages.set("side@example.com", { fiveHour: 20 });
    cli.signIns.push("work@example.com", "side@example.com");
    await roster.signIn(ignore);
    await roster.signIn(ignore);
    const first = await roster.forAttempt(ignore);
    cli.signedOut.add("work@example.com");
    await runTurn(first, {
      type: "turn.completed",
      status: "failed",
      error: { message: "Not logged in · Please run /login", kind: "auth" },
    });
    const reports: string[] = [];
    await roster.forAttempt((text) => reports.push(text));
    expect(reports).toEqual([
      "Using side@example.com: work@example.com is signed out",
    ]);
    expect(
      (await roster.view()).accounts.find(
        (account) => account.label === "work@example.com",
      )?.note,
    ).toBe("Signed out. Sign in again to use it.");

    // Signing the same account in again replaces it in its place.
    cli.signedOut.clear();
    cli.signIns.push("work@example.com");
    await roster.signIn(ignore);
    expect(
      (await roster.view()).accounts.map((account) => [
        account.label,
        account.note,
      ]),
    ).toEqual([
      ["work@example.com", undefined],
      ["side@example.com", undefined],
    ]);
    expect(cli.logouts).toHaveLength(1);
  });

  it("asks Claude Code once per account however many turns start together", async () => {
    const { roster, cli, make } = setup();
    cli.signIns.push("work@example.com");
    await roster.signIn(ignore);
    // After a restart, nothing has been read yet.
    const restarted = make();
    cli.asked = [];
    const attempts = await Promise.all([
      restarted.forAttempt(ignore),
      restarted.forAttempt(ignore),
      restarted.forAttempt(ignore),
    ]);
    expect(cli.asked).toHaveLength(2);
    expect(new Set(cli.asked).size).toBe(2);
    expect(new Set(attempts.map((attempt) => attempt?.id))).toEqual(
      new Set([MACHINE_ACCOUNT]),
    );
  });

  it("signs an account out with Claude Code's own sign-out and deletes its home", async () => {
    const { roster, cli, file, root } = setup();
    cli.signIns.push("work@example.com");
    await roster.signIn(ignore);
    const [account] = JSON.parse(fs.readFileSync(file, "utf8")).accounts;
    const home = path.join(root, "agent-homes", account.id);
    await roster.signOut(account.id);
    expect(roster.hasAccounts()).toBe(false);
    expect(cli.logouts).toEqual([home]);
    expect(fs.existsSync(home)).toBe(false);
    // The person's own configuration, linked from the home, is untouched.
    expect(fs.existsSync(path.join(root, "dot-claude", "CLAUDE.md"))).toBe(
      true,
    );
    expect(await roster.forAttempt(ignore)).toBeUndefined();
  });
});
