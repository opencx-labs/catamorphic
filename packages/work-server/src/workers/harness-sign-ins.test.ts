import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { inspect } from "node:util";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  HarnessSignInRefusedError,
  HarnessSignIns,
  parseDeviceCode,
  parseSignInLink,
} from "./harness-sign-ins.js";
import { listMachineSignIns, signInRoot } from "./sign-ins.js";

/**
 * A stand-in for `codex login --device-auth` (v0.160.0's output, colors
 * included). What it does after printing its code depends on FAKE_CODEX:
 * approve (writes its file and exits 0), deny (exits 1), hang, or refuse
 * before printing any code.
 */
const FAKE_CODEX = `#!/bin/sh
if [ "$1 $2" != "login --device-auth" ]; then echo "unexpected: $*" >&2; exit 2; fi
if [ "$FAKE_CODEX" = refuse ]; then
  echo "Error: device code login is not enabled for this workspace" >&2
  exit 1
fi
printf '\\nWelcome to Codex [v\\033[90m0.160.0\\033[0m]\\n\\n'
printf 'Follow these steps to sign in with ChatGPT using device code authorization:\\n\\n'
printf '1. Open this link in your browser and sign in to your account\\n   \\033[94mhttps://auth.openai.com/codex/device\\033[0m\\n\\n'
printf '2. Enter this one-time code \\033[90m(expires in 15 minutes)\\033[0m\\n   \\033[94mABCD-1E2F3\\033[0m\\n\\n'
case "$FAKE_CODEX" in
  approve) sleep 0.3; printf '{"tokens":"kept on this machine"}' > "$CODEX_HOME/auth.json"; echo "Successfully logged in"; exit 0 ;;
  deny) sleep 0.3; echo "Error: the request was denied" >&2; exit 1 ;;
  *) sleep 600 ;;
esac
`;

describe("Codex sign-ins started from the app (ADR 0213)", () => {
  let dataDir: string;
  let bin: string;
  const machines: HarnessSignIns[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-codex-sign-in-"));
    bin = path.join(dataDir, "bin");
    fs.mkdirSync(bin);
    fs.writeFileSync(path.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  });
  afterEach(() => {
    for (const machine of machines.splice(0)) machine.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const machine = (mode: string, now?: () => number) => {
    const signIns = new HarnessSignIns({
      signInRoot: signInRoot(dataDir),
      dataDir,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_CODEX: mode,
      },
      ...(now ? { now } : {}),
    });
    machines.push(signIns);
    return signIns;
  };

  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 10_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const pending = () =>
    fs.existsSync(path.join(signInRoot(dataDir), ".pending"))
      ? fs.readdirSync(path.join(signInRoot(dataDir), ".pending"))
      : [];

  it("reads the link and code Codex prints, colors and all", () => {
    expect(
      parseDeviceCode(
        "1. Open\n   \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m\n2. Enter this one-time code \u001b[90m(expires in 15 minutes)\u001b[0m\n   \u001b[94mABCD-1E2F3\u001b[0m\n",
      ),
    ).toEqual({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1E2F3",
      minutes: 15,
    });
    expect(
      parseDeviceCode("https://auth.openai.com/codex/device\n"),
    ).toBeUndefined();
  });

  it("hands back the link and code, then places the completed login", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({
      harness: "codex",
      member: "user|alice",
    });
    expect(started).toMatchObject({
      verificationUrl: "https://auth.openai.com/codex/device",
      userCode: "ABCD-1E2F3",
    });
    const minutes = (Date.parse(started.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Pending, it is not a sign-in the machine reports.
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "user|alice",
          attempt: started.attempt,
        }).state !== "waiting",
    );
    expect(
      signIns.status({
        harness: "codex",
        member: "user|alice",
        attempt: started.attempt,
      }),
    ).toEqual({ state: "signed-in" });
    const [signIn] = listMachineSignIns(signInRoot(dataDir));
    expect(signIn?.member).toBe("user|alice");
    expect(fs.existsSync(path.join(signIn?.home ?? "", "auth.json"))).toBe(
      true,
    );
    expect(pending()).toEqual([]);
  });

  it("says what Codex said when it refuses before giving a code", async () => {
    const signIns = machine("refuse");
    await expect(
      signIns.begin({ harness: "codex", member: "alice" }),
    ).rejects.toThrow(
      new HarnessSignInRefusedError(
        "Error: device code login is not enabled for this workspace",
      ),
    );
    expect(pending()).toEqual([]);
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });

  it("keeps the sign-in a member had when a new login is denied or cancelled", async () => {
    const first = machine("approve");
    const done = await first.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        first.status({
          harness: "codex",
          member: "alice",
          attempt: done.attempt,
        }).state === "signed-in",
    );

    const denied = machine("deny");
    const refused = await denied.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        denied.status({
          harness: "codex",
          member: "alice",
          attempt: refused.attempt,
        }).state !== "waiting",
    );
    expect(
      denied.status({
        harness: "codex",
        member: "alice",
        attempt: refused.attempt,
      }),
    ).toEqual({ state: "failed", message: "Error: the request was denied" });

    const hanging = machine("hang");
    const waiting = await hanging.begin({ harness: "codex", member: "alice" });
    expect(
      hanging.cancel({
        harness: "codex",
        member: "alice",
        attempt: waiting.attempt,
      }),
    ).toEqual({ state: "cancelled" });

    expect(listMachineSignIns(signInRoot(dataDir))).toHaveLength(1);
    await until(() => pending().length === 0);
  });

  it("answers only the member who started a login, and one login per member", async () => {
    const signIns = machine("hang");
    const first = await signIns.begin({ harness: "codex", member: "alice" });
    expect(
      signIns.status({
        harness: "codex",
        member: "bob",
        attempt: first.attempt,
      }),
    ).toEqual({
      state: "failed",
      message:
        "This machine no longer knows this sign-in; it may have restarted. Start again",
    });
    expect(
      signIns.cancel({
        harness: "codex",
        member: "bob",
        attempt: first.attempt,
      }).state,
    ).toBe("failed");
    expect(
      signIns.status({
        harness: "codex",
        member: "alice",
        attempt: first.attempt,
      }).state,
    ).toBe("waiting");
    const second = await signIns.begin({ harness: "codex", member: "alice" });
    expect(
      signIns.status({
        harness: "codex",
        member: "alice",
        attempt: first.attempt,
      }),
    ).toEqual({
      state: "cancelled",
      message: "A newer sign-in replaced this one",
    });
    expect(
      signIns.status({
        harness: "codex",
        member: "alice",
        attempt: second.attempt,
      }).state,
    ).toBe("waiting");
  });

  it("calls a login that ends after its code expired expired", async () => {
    let clock = Date.now();
    const signIns = machine("deny", () => clock);
    const started = await signIns.begin({ harness: "codex", member: "alice" });
    clock += 16 * 60_000;
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "alice",
          attempt: started.attempt,
        }).state !== "waiting",
    );
    expect(
      signIns.status({
        harness: "codex",
        member: "alice",
        attempt: started.attempt,
      }).state,
    ).toBe("expired");
  });

  it("holds one person's sign-in: another's login is refused, as an answer", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "alice",
          attempt: started.attempt,
        }).state === "signed-in",
    );
    expect(
      await signIns.handle({
        action: "begin",
        harness: "codex",
        member: "bob",
      }),
    ).toEqual({
      refused:
        "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
    });
    expect(pending()).toEqual([]);
    // Alice may sign in again; it replaces her own.
    const again = await signIns.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "alice",
          attempt: again.attempt,
        }).state === "signed-in",
    );
    expect(
      listMachineSignIns(signInRoot(dataDir)).map((signIn) => signIn.member),
    ).toEqual(["alice"]);
  });

  it("signs a member out of the machine", async () => {
    const signIns = machine("approve");
    const started = await signIns.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "alice",
          attempt: started.attempt,
        }).state === "signed-in",
    );
    expect(
      await signIns.handle({
        action: "signOut",
        harness: "codex",
        member: "alice",
      }),
    ).toEqual({ signedOut: true });
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);
  });
});

/** What a member pastes from the stand-in's sign-in page. */
const CLAUDE_CODE = "TEST-CLAUDE-CODE#state";

describe("Claude Code sign-ins started from the app (ADR 0340)", () => {
  let dataDir: string;
  let bin: string;
  const machines: HarnessSignIns[] = [];

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "work-claude-sign-in-"));
    bin = path.join(dataDir, "bin");
    fs.mkdirSync(bin);
    // The stand-in speaks `claude auth login` as the CLI does with no
    // terminal; the machine's own `claude` is the one that runs.
    fs.copyFileSync(
      path.join(import.meta.dirname, "fake-claude-cli.ts"),
      path.join(bin, "claude"),
    );
    fs.chmodSync(path.join(bin, "claude"), 0o755);
    fs.writeFileSync(path.join(bin, "codex"), FAKE_CODEX, { mode: 0o755 });
  });
  afterEach(() => {
    for (const machine of machines.splice(0)) machine.stop();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  const machine = (env: Record<string, string> = {}, now?: () => number) => {
    const signIns = new HarnessSignIns({
      signInRoot: signInRoot(dataDir),
      dataDir,
      env: {
        PATH: `${bin}${path.delimiter}${process.env.PATH ?? ""}`,
        FAKE_CODEX: "approve",
        ...env,
      },
      ...(now ? { now } : {}),
    });
    machines.push(signIns);
    return signIns;
  };

  const until = async (check: () => boolean) => {
    const deadline = Date.now() + 15_000;
    while (!check()) {
      if (Date.now() > deadline) throw new Error("Timed out");
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  };

  const pending = () =>
    fs.existsSync(path.join(signInRoot(dataDir), ".pending"))
      ? fs.readdirSync(path.join(signInRoot(dataDir), ".pending"))
      : [];

  const settled = async (
    signIns: HarnessSignIns,
    input: { member: string; attempt: string },
  ) => {
    const target = { harness: "claude-code" as const, ...input };
    await until(() => signIns.status(target).state !== "waiting");
    return signIns.status(target);
  };

  it("reads the link Claude Code prints, only whole and only on its own hosts", () => {
    const link =
      "https://claude.com/cai/oauth/authorize?code=true&client_id=abc&redirect_uri=https%3A%2F%2Fplatform.claude.com%2Foauth%2Fcode%2Fcallback";
    const hosts = ["claude.com", "claude.ai", "anthropic.com"];
    expect(
      parseSignInLink({
        output: `Opening browser to sign in…\nIf the browser didn't open, visit: ${link}\nPaste code here if prompted > `,
        hosts,
      }),
    ).toBe(link);
    // A link still arriving is not handed to anyone.
    expect(
      parseSignInLink({ output: `visit: ${link.slice(0, 40)}`, hosts }),
    ).toBeUndefined();
    // Subdomains count; look-alikes and other sites do not.
    expect(
      parseSignInLink({
        output: "visit: https://console.anthropic.com/oauth\n",
        hosts,
      }),
    ).toBe("https://console.anthropic.com/oauth");
    expect(
      parseSignInLink({
        output:
          "visit: https://evil.example/login\nvisit: https://notclaude.com/x\nvisit: https://claude.com.evil.example/x\n",
        hosts,
      }),
    ).toBeUndefined();
  });

  it("hands back the link, takes the pasted code, then places the completed login", async () => {
    const signIns = machine();
    const started = await signIns.begin({
      harness: "claude-code",
      member: "user|alice",
    });
    expect(started.verificationUrl).toMatch(
      /^https:\/\/claude\.com\/cai\/oauth\/authorize\?/,
    );
    // Claude Code prints no one-time code: it waits for the member's.
    expect(started.expects).toBe("code");
    expect(started).not.toHaveProperty("userCode");
    const minutes = (Date.parse(started.expiresAt) - Date.now()) / 60_000;
    expect(minutes).toBeGreaterThan(14);
    expect(minutes).toBeLessThanOrEqual(15);
    // Pending, it is not a sign-in the machine reports.
    expect(listMachineSignIns(signInRoot(dataDir))).toEqual([]);

    const answer = await signIns.handle({
      action: "input",
      harness: "claude-code",
      member: "user|alice",
      attempt: started.attempt,
      text: `  ${CLAUDE_CODE}\n`,
    });
    // The answer says where the sign-in stands, never what was pasted.
    expect(answer).toEqual({ state: "waiting" });
    expect(
      await settled(signIns, {
        member: "user|alice",
        attempt: started.attempt,
      }),
    ).toEqual({ state: "signed-in" });
    const [signIn] = listMachineSignIns(signInRoot(dataDir));
    expect(signIn).toMatchObject({
      harness: "claude-code",
      member: "user|alice",
    });
    const home = signIn?.home ?? "";
    expect(fs.statSync(home).mode & 0o777).toBe(0o700);
    expect(fs.statSync(path.join(home, ".credentials.json")).mode & 0o777).toBe(
      0o600,
    );
    // Claude Code's home starts empty: Codex's file is Codex's alone.
    expect(fs.existsSync(path.join(home, "config.toml"))).toBe(false);
    expect(pending()).toEqual([]);
  });

  it("keeps the sign-in a member had when a new login gets a wrong code, is cancelled or expires", async () => {
    const signIns = machine();
    const first = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    signIns.input({
      harness: "claude-code",
      member: "alice",
      attempt: first.attempt,
      text: CLAUDE_CODE,
    });
    expect(
      (await settled(signIns, { member: "alice", attempt: first.attempt }))
        .state,
    ).toBe("signed-in");
    const before = fs.readFileSync(
      path.join(
        listMachineSignIns(signInRoot(dataDir))[0]?.home ?? "",
        ".credentials.json",
      ),
      "utf8",
    );

    // A wrong code: what Claude Code said, without what was pasted.
    const wrong = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    signIns.input({
      harness: "claude-code",
      member: "alice",
      attempt: wrong.attempt,
      text: "wrong-code-7f3a",
    });
    expect(
      await settled(signIns, { member: "alice", attempt: wrong.attempt }),
    ).toEqual({ state: "failed", message: "Error: invalid code the code" });

    const waiting = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    expect(
      signIns.cancel({
        harness: "claude-code",
        member: "alice",
        attempt: waiting.attempt,
      }),
    ).toEqual({ state: "cancelled" });

    // Nobody finishes one: Work ends it when its time is up.
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      const abandoned = await signIns.begin({
        harness: "claude-code",
        member: "alice",
      });
      vi.advanceTimersByTime(15 * 60_000 + 1);
      expect(
        signIns.status({
          harness: "claude-code",
          member: "alice",
          attempt: abandoned.attempt,
        }),
      ).toEqual({
        state: "expired",
        message: "The sign-in was not finished in time",
      });
    } finally {
      vi.useRealTimers();
    }

    const [kept] = listMachineSignIns(signInRoot(dataDir));
    expect(
      fs.readFileSync(path.join(kept?.home ?? "", ".credentials.json"), "utf8"),
    ).toBe(before);
    await until(() => pending().length === 0);
  });

  it("takes one line, once, only for a login that waits for one", async () => {
    const signIns = machine();
    const started = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    const target = {
      harness: "claude-code" as const,
      member: "alice",
      attempt: started.attempt,
    };
    for (const text of ["", "   ", "two\nlines", "x".repeat(4097)])
      expect(
        await signIns.handle({ action: "input", ...target, text }),
      ).toEqual({
        refused:
          "That is not a code: paste the one line the sign-in page gave you",
      });
    // Someone else's attempt, or one this machine forgot, takes nothing.
    expect(
      signIns.input({ ...target, member: "bob", text: CLAUDE_CODE }).state,
    ).toBe("failed");
    expect(signIns.status(target).state).toBe("waiting");

    expect(signIns.input({ ...target, text: CLAUDE_CODE })).toEqual({
      state: "waiting",
    });
    expect(
      await signIns.handle({ action: "input", ...target, text: CLAUDE_CODE }),
    ).toEqual({
      refused:
        "This sign-in already has its code. Wait for it to finish, or start again",
    });
    expect(
      (await settled(signIns, { member: "alice", attempt: started.attempt }))
        .state,
    ).toBe("signed-in");
    // Finished, it takes no more; the answer is where it stands.
    expect(signIns.input({ ...target, text: CLAUDE_CODE })).toEqual({
      state: "signed-in",
    });

    // Codex shows its code; it waits for none.
    const codex = await signIns.begin({ harness: "codex", member: "alice" });
    expect(codex.userCode).toBe("ABCD-1E2F3");
    expect(codex).not.toHaveProperty("expects");
    expect(
      await signIns.handle({
        action: "input",
        harness: "codex",
        member: "alice",
        attempt: codex.attempt,
        text: "ABCD-1E2F3",
      }),
    ).toEqual({
      refused:
        "Codex takes no code here: enter the code it showed on its sign-in page",
    });
    // One attempt answers only for its own harness.
    expect(
      signIns.status({
        harness: "claude-code",
        member: "alice",
        attempt: codex.attempt,
      }).state,
    ).toBe("failed");
  });

  it("holds one person's sign-ins, of both harnesses, and no one else's", async () => {
    const signIns = machine();
    const codex = await signIns.begin({ harness: "codex", member: "alice" });
    await until(
      () =>
        signIns.status({
          harness: "codex",
          member: "alice",
          attempt: codex.attempt,
        }).state === "signed-in",
    );
    // Bob's Claude login is refused on the machine that holds Alice's Codex.
    expect(
      await signIns.handle({
        action: "begin",
        harness: "claude-code",
        member: "bob",
      }),
    ).toEqual({
      refused:
        "Another person's sign-in is on this machine, and a machine holds one person's only. Ask an administrator for a machine of your own",
    });
    expect(pending()).toEqual([]);

    // Alice may hold both there. A Codex login of hers in flight is left
    // alone by her Claude Code one.
    const again = await machine({ FAKE_CODEX: "hang" }).begin({
      harness: "codex",
      member: "alice",
    });
    const claude = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    signIns.input({
      harness: "claude-code",
      member: "alice",
      attempt: claude.attempt,
      text: CLAUDE_CODE,
    });
    expect(
      (await settled(signIns, { member: "alice", attempt: claude.attempt }))
        .state,
    ).toBe("signed-in");
    expect(again.userCode).toBe("ABCD-1E2F3");
    expect(
      listMachineSignIns(signInRoot(dataDir)).map((signIn) => [
        signIn.harness,
        signIn.member,
      ]),
    ).toEqual([
      ["claude-code", "alice"],
      ["codex", "alice"],
    ]);

    // Signing out of one leaves the other.
    expect(
      await signIns.handle({
        action: "signOut",
        harness: "claude-code",
        member: "alice",
      }),
    ).toEqual({ signedOut: true });
    expect(
      listMachineSignIns(signInRoot(dataDir)).map((signIn) => signIn.harness),
    ).toEqual(["codex"]);
  });

  it("runs the login without any other credential, and says when the machine has no Claude Code", async () => {
    // An organization's key on a single server is not the member's sign-in:
    // the stand-in refuses a login that is handed one.
    const signIns = machine({
      ANTHROPIC_API_KEY: "sk-ant-organization",
      ANTHROPIC_AUTH_TOKEN: "token-organization",
      ANTHROPIC_BASE_URL: "https://gateway.example.test",
      CLAUDE_CODE_OAUTH_TOKEN: "oauth-organization",
    });
    const started = await signIns.begin({
      harness: "claude-code",
      member: "alice",
    });
    expect(started.expects).toBe("code");
    signIns.cancel({
      harness: "claude-code",
      member: "alice",
      attempt: started.attempt,
    });

    const bare = new HarnessSignIns({
      signInRoot: signInRoot(dataDir),
      dataDir,
      env: { PATH: path.join(dataDir, "nothing") },
    });
    machines.push(bare);
    await expect(
      bare.begin({ harness: "claude-code", member: "alice" }),
    ).rejects.toThrow(/Could not run Claude Code on this machine/);
    await until(() => pending().length === 0);
  });

  it("never writes what a member pasted to a log or an answer", async () => {
    const said: string[] = [];
    const spies = (["log", "info", "warn", "error", "debug"] as const).map(
      (level) =>
        vi.spyOn(console, level).mockImplementation((...args: unknown[]) => {
          said.push(args.map(String).join(" "));
        }),
    );
    const answers: unknown[] = [];
    try {
      const signIns = machine();
      for (const text of ["wrong-code-7f3a", CLAUDE_CODE]) {
        const started = await signIns.handle({
          action: "begin",
          harness: "claude-code",
          member: "alice",
        });
        answers.push(started);
        const attempt = "attempt" in started ? started.attempt : "";
        const target = {
          harness: "claude-code" as const,
          member: "alice",
          attempt,
        };
        answers.push(
          await signIns.handle({ action: "input", ...target, text }),
        );
        answers.push(await settled(signIns, { member: "alice", attempt }));
        answers.push(await signIns.handle({ action: "status", ...target }));
        // A second paste is refused in words that do not repeat it.
        answers.push(
          await signIns.handle({
            action: "input",
            ...target,
            text: `${text}-again`,
          }),
        );
      }
    } finally {
      for (const spy of spies) spy.mockRestore();
    }
    const everything = JSON.stringify({ said, answers });
    expect(answers).toHaveLength(10);
    expect(everything).not.toContain("wrong-code-7f3a");
    expect(everything).not.toContain(CLAUDE_CODE);
    expect(everything).not.toContain("TEST-CLAUDE-CODE");
    // What was pasted is not kept after the login ended either.
    const kept = inspect(machines, { depth: 3 });
    expect(kept).toContain("signed-in");
    expect(kept).not.toContain("wrong-code-7f3a");
    expect(kept).not.toContain("TEST-CLAUDE-CODE");
  });
});
